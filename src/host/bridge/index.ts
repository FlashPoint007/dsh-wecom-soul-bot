import { randomUUID } from 'node:crypto';
import type { WSClient, WsFrame } from '@wecom/aibot-node-sdk';

import { createCatalogService, type CatalogService } from '../catalog.js';
import type { BridgeSettings } from '../config.js';
import { bindingKey, bindingKeyFor } from '../store.js';
import type {
  ApprovalOutcome, ApprovalRequest, HostContext, Logger, QuestionAnswer, QuestionRequest,
  SessionEvent, SessionHandle,
} from '../dsh.js';
import { nullJournal, type Journal } from '../journal.js';
import { createObservationStore, type ObservationStore } from '../observation.js';
import { createRoundTracker, type Round, type RoundTracker } from '../rounds.js';
import { createStatusTracker, type StatusTracker } from '../status.js';
import type { TurnSummary } from '../turns.js';
import type { InteractionDelivery } from '../interaction-transport.js';
import type { Router } from '../routing.js';
import type { SessionOperations } from '../session-ops.js';
import type { WorkspaceService } from '../workspaces.js';
import { parseCommand, runCommand, type CommandServices, type TargetInfo } from './commands.js';
import { createSessionDirectory, type SessionDirectory } from './directory.js';
import { byteLength, limitBytes, MAX_INBOUND_BYTES, MAX_REPLY_BYTES, extractSessionPointer } from './format.js';
import { createReplayGuard, parseInbound, type InboundMessage } from './inbound.js';
import { createInteractionRegistry } from './interactions.js';
import {
  adminUnassignedText, approvalNotice, code, markdownBody, promptFailedNotice, questionNotice, reviewNotice, routingChangedText,
  sessionErrorNotice, sessionLabel, title, turnCompleteNotice, unauthorizedText,
} from './notices.js';
import { ackSummary, createOutbox, type NoticeKind } from './outbox.js';
import { createAccessPolicy } from './policy.js';
import { createSelectionStore } from './selection.js';
import type { SoulService } from '../soul/service.js';

/**
 * One live WeCom connection bound to one settings snapshot.
 *
 * The bridge owns the socket listeners, the access policy, the notification
 * queue and pending WeCom answers. Routing itself — which Session a
 * conversation owns — belongs to the Host-lifetime router, so replacing the
 * bridge (a Config change) never loses a binding or a pending round.
 *
 * Notification recipients are the conversations bound to the Session plus
 * every administrator whose Workspace scope covers it: unlike the previous
 * release this no longer depends on who has messaged the Bot since the
 * process started.
 */

export type BridgeClient = Pick<WSClient, 'on' | 'connect' | 'disconnect' | 'removeAllListeners' | 'sendMessage' | 'replyStream'>;

export interface BridgeDeps {
  readonly ctx: Pick<HostContext, 'on' | 'sessionController'>;
  readonly client: BridgeClient;
  readonly settings: BridgeSettings;
  readonly router: Router;
  readonly log?: Logger;
  readonly journal?: Journal;
  readonly observations?: ObservationStore;
  readonly rounds?: RoundTracker;
  readonly catalogs?: CatalogService;
  readonly status?: StatusTracker;
  /** DSH operations the Bot exposes (archive, compact, create). */
  readonly ops: SessionOperations;
  readonly workspaces: WorkspaceService;
  /** Removes secrets from SDK-provided text before it is shown or logged. */
  readonly scrub?: (text: string) => string;
  /** Runtime consumes Gateway events; do not claim the native Host waterfall. */
  readonly brokeredInteractions?: boolean;
  /** A deployment without the shared broker can notify, but must not claim dual-channel decisions. */
  readonly notificationOnly?: boolean;
  /** Persona, sender identity and chat mode; omitted, the bridge behaves like upstream dsh-wecom-bot. */
  readonly soul?: SoulService;
}

export interface Bridge {
  start(): () => void;
  handleFrame(frame: WsFrame): Promise<void>;
  /** Resolves once every queued message has been handled (see `serialize`). */
  whenIdle(): Promise<void>;
  /** Notify WeCom about a finished turn; resolves to the notified conversations. */
  onTurnEnd(session: SessionHandle, end: SessionEvent, summary: () => TurnSummary): Promise<readonly string[]>;
  onQuestion(request: QuestionRequest, next: () => Promise<QuestionAnswer>, delivery?: InteractionDelivery): Promise<QuestionAnswer>;
  onApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>, delivery?: InteractionDelivery): Promise<ApprovalOutcome>;
  onSessionError(sessionId: string): Promise<readonly string[]>;
  readonly directory: SessionDirectory;
  readonly observations: ObservationStore;
  readonly rounds: RoundTracker;

  /** Send one proactive message (used when the page authorizes somebody). */
  notify(chat: string, text: string, kind: NoticeKind): void;
  /**
   * Adopt edited settings without touching the socket. Administrators, the
   * notification scope, the question timeout and remote approvals are read per
   * message, so only the access policy has to be rebuilt here; replacing the
   * bridge is reserved for the connection identity (Bot ID, Secret, endpoint).
   */
  updateSettings(settings: BridgeSettings): void;
  /** Drop administrator switches when a chat is assigned, moved or removed. */
  resetRouting(chat: string): void;
}

export function createBridge(deps: BridgeDeps): Bridge {
  const { ctx, client, router } = deps;
  const log = deps.log ?? console;
  const journal = deps.journal ?? nullJournal;
  const observations = deps.observations ?? createObservationStore();
  const rounds = deps.rounds ?? createRoundTracker({ journal });
  const status = deps.status ?? createStatusTracker(journal);
  const scrub = deps.scrub ?? ((text: string) => text);
  const catalogs = deps.catalogs ?? createCatalogService({
    list: async signal => (await ctx.sessionController.list({}, signal)).items,
    registry: () => undefined,
  });

  // The bridge reads these on every message, so a settings edit is handed to
  // the running bridge rather than replacing it (see `updateSettings`).
  let settings = deps.settings;
  const policyFor = () => createAccessPolicy(settings, {
    memberOf: message => router.store.get(bindingKeyFor(message))?.groupId,
  });
  let policy = policyFor();
  const directory = createSessionDirectory(catalogs, {
    allow: entry => policy.adminWorkspaceAllowed(entry.group.path),
  });
  const selection = createSelectionStore();
  const interactions = createInteractionRegistry();
  const outbox = createOutbox({ client, journal, log, status, allow: async notice => {
    if (!notice.sessionId) return notice.kind !== 'admin' || policy.isAdmin(notice.chat);
    const admin = policy.isAdmin(notice.chat);
    if (notice.interactionNonce && !interactions.isPending(notice.interactionNonce)) return false;
    // Approval recipients are scoped administrators only, never a bound member.
    const scopedAdmin = admin && await directory.permitted(notice.sessionId);
    if (notice.kind === 'approval' || notice.kind === 'approval-request') return scopedAdmin;
    return router.forSession(notice.sessionId).some(binding => binding.id === notice.chat) || scopedAdmin;
  } });
  const replay = createReplayGuard();
  const lifetime = new AbortController();
  let closed = false;
  let started = false;
  let displaced = false;
  let generation = 0;
  const routingGenerations = new Map<string, number>();

  const stale = (ticket: number) => closed || ticket !== generation;
  const parts = (message: InboundMessage) => ({ chat: message.chat, user: message.user, chatType: message.chatType });

  /** The Session a sender talks to right now, without creating anything. */
  async function currentTarget(message: InboundMessage): Promise<TargetInfo> {
    if (message.chatType === 'single' && policy.isAdmin(message.user)) {
      const choice = selection.get(message.chat, message.user);
      if (choice) {
        if (await directory.permitted(choice)) return { sessionId: choice, switched: true };
        selection.clear(message.chat, message.user);
      }
    }
    const key = bindingKeyFor(parts(message));
    const binding = router.store.get(key);
    const note = router.store.label(key);
    return {
      ...(binding?.sessionId ? { sessionId: binding.sessionId } : {}),
      ...(binding ? { binding } : {}),
      ...(binding ? { group: router.store.group(binding.groupId) } : {}),
      ...(note ? { note } : {}),
      switched: false,
    };
  }

  /** The Session a prompt must go to; creates the binding's Session when needed. */
  async function routeTarget(message: InboundMessage): Promise<
    { readonly ok: true; readonly sessionId: string; valid(): boolean } | { readonly ok: false; readonly message: string }
  > {
    const switched = await currentTarget(message);
    if (switched.switched && switched.sessionId) {
      const sessionId = switched.sessionId;
      return { ok: true, sessionId, valid: () => policy.isAdmin(message.user)
        && selection.get(message.chat, message.user) === sessionId };
    }
    if (!switched.binding) return { ok: false, message: adminUnassignedText() };
    const routed = await router.route(parts(message), switched.binding.groupId);
    if (!routed.ok || !routed.sessionId) {
      return { ok: false, message: routed.message ?? '无法为你创建专属会话，请稍后重试。' };
    }
    if (routed.created) {
      journal.write({
        event: 'session.created', chatId: message.chat, userId: message.user,
        sessionId: routed.sessionId, binding: routed.binding ? bindingKey(routed.binding.kind, routed.binding.id) : undefined,
      });
    }
    const binding = routed.binding;
    return { ok: true, sessionId: routed.sessionId,
      valid: () => Boolean(binding && router.store.get(bindingKey(binding.kind, binding.id)) === binding),
    };
  }

  /**
   * Conversations that may receive automatic messages about this Session:
   * every binding pointing at it, plus the administrators whose Workspace
   * scope covers it. `reason` only labels the {@link journal} warning emitted
   * when nobody qualifies, which is the only trace of a skipped notice.
   */
  async function recipients(sessionId: string, reason: NoticeKind): Promise<string[]> {
    const chats = new Set<string>();
    for (const binding of router.forSession(sessionId)) chats.add(binding.id);
    if (settings.adminUserIds.length && await directory.permitted(sessionId)) {
      for (const admin of settings.adminUserIds) chats.add(admin);
    }
    const unique = [...chats];
    if (!unique.length) {
      journal.write({
        event: 'wecom.notify.skipped', level: 'warn', sessionId, reason,
        detail: 'no binding points at this Session and no administrator scope covers its Workspace',
      });
    }
    return unique;
  }

  function notify(chats: readonly string[], text: string, kind: NoticeKind, sessionId?: string, interactionNonce?: string): void {
    for (const chat of chats) outbox.enqueue({ chat, text, kind, ...(sessionId ? { sessionId } : {}), ...(interactionNonce ? { interactionNonce } : {}) });
  }

  async function reply(message: InboundMessage, round: Round, text: string): Promise<void> {
    if (closed) return;
    const content = limitBytes(text, MAX_REPLY_BYTES);
    const streamId = `stream_${randomUUID()}`;
    rounds.reply(round, content);
    const startedAt = Date.now();
    const meta = { roundId: round.id, chatId: message.chat, userId: message.user, reqId: message.reqId };
    try {
      const ack = await client.replyStream(message.frame, streamId, content, true);
      journal.write({ event: 'wecom.reply', ...meta, request: { streamId, content, finish: true }, response: ackSummary(ack), durationMs: Date.now() - startedAt });
    } catch (error) {
      status.count('failures');
      log.warn('WeCom reply failed');
      journal.write({ event: 'wecom.reply', level: 'warn', ...meta, request: { streamId, content, finish: true }, error, durationMs: Date.now() - startedAt });
    }
  }

  const commandServices: CommandServices = {
    // A getter, not the object: `updateSettings` replaces `policy`, and a
    // command must see the administrator list the operator just saved. Holding
    // the original object here made a promotion wait for a plugin restart.
    get policy() { return policy; },
    directory, selection, interactions, journal,
    sessionController: ctx.sessionController,
    ops: deps.ops,
    workspaces: deps.workspaces,
    adminWorkspaces: router.store,
    current: currentTarget,
    async archiveSession(message, sessionId) {
      // Archive first: if DSH refuses, the binding must not be cleared.
      await deps.ops.archive(sessionId);
      selection.clear(message.chat, message.user);
      for (const binding of router.store.forSession(sessionId)) {
        await router.store.update(bindingKey(binding.kind, binding.id), { sessionId: '' });
        journal.write({
          event: 'binding.session.reset', binding: bindingKey(binding.kind, binding.id), sessionId, reason: 'archived-by-command',
        });
      }
    },
    stale: ticket => stale(ticket.bridge) || (routingGenerations.get(ticket.chat) ?? 0) !== ticket.routing,
    ticket: message => ({ bridge: generation, chat: message.chat, routing: routingGenerations.get(message.chat) ?? 0 }),
  };

  async function submitPrompt(message: InboundMessage, round: Round, content: string): Promise<void> {
    const ticket = generation;
    const target = await routeTarget(message);
    if (stale(ticket)) return;
    if (!target.ok) {
      await reply(message, round, target.message);
      rounds.complete(round, 'blocked', { response: { reason: 'route-failed' } });
      return;
    }
    const sessionId = target.sessionId;
    if (interactions.hasQuestion(sessionId)) {
      await reply(message, round, [
        title('⏸', '该会话正在等待回答提问'),
        '',
        `请先用 ${code('/answer 验证码 选项')} 作答；普通消息不会被当作答案。`,
      ].join('\n'));
      rounds.complete(round, 'blocked', { response: { reason: 'question-pending' } });
      return;
    }
    const info = await directory.describe(sessionId);
    round.sessionId = sessionId;
    round.sessionTitle = info.title;
    if (info.workspace) round.workspace = info.workspace;
    const chatMode = Boolean(deps.soul?.chatMode() && deps.soul.bound(sessionId));
    // The callback req_id is short-lived: acknowledge before activating the Session.
    // In chat mode the persona answers by itself when the turn ends, so no receipt.
    if (!chatMode) {
      await reply(message, round, [
        `${title('🚀', '已提交给 DSH')} · ${sessionLabel(info.title)}`,
        '> 本轮完成后我会在这里通知你；发送 /cancel 可以停止本轮。',
      ].join('\n'));
    }
    if (stale(ticket) || lifetime.signal.aborted || !policy.evaluate(parts(message)).accepted) {
      rounds.complete(round, 'interrupted');
      return;
    }
    if (!target.valid()) {
      await reply(message, round, routingChangedText());
      rounds.complete(round, 'interrupted');
      return;
    }
    const sender = { user: message.user, chat: message.chat, chatType: message.chatType };
    deps.soul?.noteSender(sessionId, sender);
    const text = deps.soul ? deps.soul.decorate(sender, content) : content;
    const request = {
      requestId: randomUUID(), sessionId, mode: 'queue' as const,
      content: [{ type: 'text' as const, text }],
    };
    // Register first: the turn may end before prompt() resolves.
    rounds.awaitTurn(round, request.requestId);
    const startedAt = Date.now();
    const meta = { roundId: round.id, sessionId, requestId: request.requestId, chatId: message.chat, userId: message.user };
    try {
      const response = await ctx.sessionController.prompt(request, lifetime.signal);
      status.count('prompts');
      journal.write({ event: 'dsh.prompt', ...meta, request, response, durationMs: Date.now() - startedAt });
    } catch (error) {
      status.count('failures');
      journal.write({ event: 'dsh.prompt', level: 'warn', ...meta, request, error, durationMs: Date.now() - startedAt });
      rounds.complete(round, 'prompt-failed', { response: { error } });
      if (!stale(ticket)) {
        outbox.enqueue({ chat: message.chat, text: promptFailedNotice(sessionId, info.title), kind: 'prompt-failed', sessionId, roundIds: [round.id] });
      }
    }
  }

  /**
   * Quoting (replying to) one of this Bot's own per-Session notices carries
   * that notice's embedded `/use <token>` hint back on `quotedText`, even
   * though the WeCom callback never echoes the quoted message's id. Only an
   * administrator may act on it: for everyone else the message keeps going to
   * their own Session. An unresolved or missing quote changes nothing.
   */
  async function applyQuotedSession(message: InboundMessage, round: Round): Promise<void> {
    if (!message.quotedText) return;
    const hint = extractSessionPointer(message.quotedText);
    if (!hint) return;
    if (message.chatType !== 'single' || !policy.isAdmin(message.user)) {
      journal.write({
        event: 'wecom.quote', roundId: round.id, chatId: message.chat, userId: message.user,
        hint, outcome: 'not-admin',
      });
      return;
    }
    const resolved = await directory.resolve(hint);
    if (!resolved.ok) {
      journal.write({
        event: 'wecom.quote', level: 'debug', roundId: round.id,
        chatId: message.chat, userId: message.user, hint, outcome: resolved.reason,
      });
      return;
    }
    selection.set(message.chat, message.user, resolved.session.sessionId);
    journal.write({
      event: 'wecom.quote', roundId: round.id, chatId: message.chat, userId: message.user,
      hint, sessionId: resolved.session.sessionId,
    });
  }

  /**
   * One in-flight message per conversation, in arrival order.
   *
   * `handleFrame` awaits real work (routing store writes, Session creation,
   * the prompt) while the socket hands frames over as fast as WeCom sends
   * them. Two messages typed in a row therefore used to overlap: both saw a
   * member with no Session yet, both created one, and the second message was
   * submitted to a Session nobody was bound to — the person's two messages
   * ended up in two conversations in the sidebar. Serializing per chat keeps
   * the order someone typed in, without making one conversation wait behind
   * another's Session creation.
   */
  const chains = new Map<string, Promise<void>>();

  function serialize(chat: string, task: () => Promise<void>): Promise<void> {
    const previous = chains.get(chat) ?? Promise.resolve();
    // `then(task, task)`: a failed message must not stall the conversation.
    const run = previous.then(task, task);
    // The chain tail never rejects, so one bad frame cannot poison the queue;
    // the caller still sees the rejection.
    const tail = run.catch(() => {});
    chains.set(chat, tail);
    void tail.then(() => { if (chains.get(chat) === tail) chains.delete(chat); });
    return run;
  }

  /** Resolves once every queued message has been handled. */
  async function whenIdle(): Promise<void> {
    for (;;) {
      const pending = [...chains.values()];
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  async function handleFrame(frame: WsFrame): Promise<void> {
    if (closed) return;
    const message = parseInbound(frame, settings.botId);
    if (!message) {
      journal.write({ event: 'wecom.message.ignored', level: 'debug', reason: 'invalid-or-foreign-frame', frame });
      return;
    }
    if (!replay.first(message.msgId)) {
      journal.write({ event: 'wecom.message.duplicate', level: 'debug', msgId: message.msgId, chatId: message.chat, userId: message.user });
      return;
    }
    return await serialize(message.chat, () => handleMessage(message));
  }

  async function handleMessage(message: InboundMessage): Promise<void> {
    // A queued message may wait out a bridge rebuild; drop it instead of
    // spending a round on a conversation that no longer has a live socket.
    if (closed) return;
    const decision = policy.evaluate(parts(message));
    observations.record({
      chat: message.chat, user: message.user, chatType: message.chatType,
      accepted: decision.accepted,
      // Only a refused message keeps its text, so the page can show the
      // operator what an unknown sender actually wrote.
      ...(message.text ? { text: message.text } : {}),
    });
    status.count('received');
    const round = rounds.begin({
      chatId: message.chat, userId: message.user, chatType: message.chatType, msgId: message.msgId,
      reqId: message.reqId, msgtype: message.msgtype, ...(message.text !== undefined ? { text: message.text } : {}),
    });
    journal.write({
      event: 'wecom.message', roundId: round.id,
      chatId: message.chat, userId: message.user, chatType: message.chatType, msgId: message.msgId, msgtype: message.msgtype,
      decision: decision.accepted ? 'accepted' : 'rejected', ...(decision.accepted ? {} : { reason: decision.reason }),
      frame: message.frame,
    });
    if (!decision.accepted) {
      // A refused sender is told once per message that it needs an operator:
      // the reply is the only way a person learns the Bot exists but will not
      // answer yet. The settings page lists it under 「未授权用户」, where
      // assigning it to a group is what authorizes it.
      status.count('rejected');
      await reply(message, round, unauthorizedText());
      rounds.complete(round, 'rejected', { response: { reason: decision.reason } });
      return;
    }
    // Only an explicit page assignment creates membership. Administrative
    // commands and plain messages must never implicitly add anyone to a group.
    const ticket = generation;
    if (stale(ticket)) return;
    if (message.msgtype !== 'text') {
      await reply(message, round, `${title('⚠️', '目前只支持文本消息')}\n\n图片、语音、文件暂时无法提交给 DSH。`);
      rounds.complete(round, 'unsupported');
      return;
    }
    const content = message.text?.trim() ?? '';
    if (!content) {
      await reply(message, round, `${title('⚠️', '消息内容为空')}\n\n发送文字内容即可继续这个会话。`);
      rounds.complete(round, 'unsupported');
      return;
    }
    if (byteLength(content) > MAX_INBOUND_BYTES) {
      await reply(message, round, title('⚠️', '消息过长') + '\n\n请缩短后再发送。');
      rounds.complete(round, 'blocked', { response: { reason: 'too-long' } });
      return;
    }
    await applyQuotedSession(message, round);
    if (stale(ticket)) return;
    const command = parseCommand(content);
    if (command) {
      round.command = command.name;
      await runCommand(commandServices, { message, round, reply: text => reply(message, round, text) }, command);
      rounds.complete(round, 'command');
      return;
    }
    await submitPrompt(message, round, content);
  }

  const notifiedEnds = new WeakSet<object>();
  async function onTurnEnd(session: SessionHandle, end: SessionEvent, summary: () => TurnSummary): Promise<readonly string[]> {
    if (closed || notifiedEnds.has(end)) return [];
    notifiedEnds.add(end);
    const reason = end.data?.reason?.kind ?? 'unknown';
    // A GUI-origin error matters to scoped operators too, with no Bot round.
    if (reason !== 'completed' && reason !== 'error' && !rounds.hasPending(session.id)) return [];
    const kind = reason === 'error' ? 'session-error' : 'turn-complete';
    if (deps.soul?.chatMode() && deps.soul.bound(session.id)) {
      // Chat mode: the persona's own words, to the conversation that owns the
      // Session only. No Session card, no administrator copy: a group chat's
      // replies must not leak into anyone's private chat.
      const chats = router.forSession(session.id).map(binding => binding.id);
      if (closed || !chats.length) return [];
      const turn = summary();
      let text: string;
      if (reason === 'error') text = '我好像卡住了，等会儿再找我试试';
      else if (turn.assistantText) text = markdownBody(turn.assistantText, MAX_REPLY_BYTES - 100);
      else return []; // nothing to say: stay quiet rather than send an empty card
      notify(chats, text, kind, session.id);
      return chats;
    }
    const chats = await recipients(session.id, kind);
    if (closed || !chats.length) return [];
    const info = await directory.describe(session.id);
    if (closed) return [];
    const turn = summary();
    const safe = turn.failure?.code ? { ...turn, failure: { ...turn.failure, code: scrub(turn.failure.code) } } : turn;
    notify(chats, turnCompleteNotice(safe, info), kind, session.id);
    return chats;
  }

  async function onSessionError(sessionId: string): Promise<readonly string[]> {
    if (closed) return [];
    const chats = await recipients(sessionId, 'session-error');
    const info = await directory.describe(sessionId);
    if (closed) return [];
    notify(chats, sessionErrorNotice(sessionId, info.title, info.workspace), 'session-error', sessionId);
    return chats;
  }

  async function onQuestion(request: QuestionRequest, next: () => Promise<QuestionAnswer>, delivery?: InteractionDelivery): Promise<QuestionAnswer> {
    const sessionId = request.agent?.id;
    const ticket = generation;
    if (closed || !sessionId || !request.questions?.length || request.signal?.aborted) return next();
    const chats = await recipients(sessionId, 'question');
    if (stale(ticket) || request.signal?.aborted || !chats.length) return next();
    const info = await directory.describe(sessionId);
    if (stale(ticket) || request.signal?.aborted) return next();
    // A text reply cannot represent a plan review or content it never showed:
    // WeCom must not claim these, not even with a free-text answer.
    if (request.questions.some(q => q.intent?.kind === 'plan-review' || Boolean(q.detail))) {
      journal.write({ event: 'dsh.question', sessionId, delegated: 'review', questions: request.questions, chats });
      notify(chats, reviewNotice(sessionId, info.title), 'review', sessionId);
      return next();
    }
    if (deps.notificationOnly) {
      notify(chats, reviewNotice(sessionId, info.title), 'review', sessionId);
      return next();
    }
    const wait = interactions.waitQuestion(sessionId, request.questions, settings.questionTimeoutMs, request.signal, delivery);
    if (!wait) return next();
    journal.write({ event: 'dsh.question', sessionId, nonce: wait.nonce, questions: request.questions, chats, timeoutMs: settings.questionTimeoutMs });
    notify(chats, questionNotice(sessionId, info.title, request.questions, wait.nonce, settings.questionTimeoutMs), 'question', sessionId, wait.nonce);
    const answer = await wait.result;
    journal.write({ event: 'dsh.question.result', sessionId, nonce: wait.nonce, outcome: answer ? 'answered' : 'fallback', ...(answer ? { answer } : {}) });
    return answer ?? next();
  }

  async function onApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>, delivery?: InteractionDelivery): Promise<ApprovalOutcome> {
    const sessionId = request.agent?.id;
    if (closed || !sessionId) return next();
    // A tool call belongs to whoever operates the deployment, not to the person
    // whose message triggered it: every administrator is told, no group member
    // (and no non-administrator private chat) ever is.
    const ticket = generation;
    const info = await directory.describe(sessionId);
    const permitted = await directory.permitted(sessionId);
    if (stale(ticket) || request.signal?.aborted) return next();
    const admins = permitted ? [...settings.adminUserIds] : [];
    if (!admins.length) {
      journal.write({ event: 'dsh.approval', sessionId, toolName: request.toolName, remote: false, chats: [] });
      return next();
    }
    const meta = { sessionId, toolName: request.toolName, ...(request.callId ? { callId: request.callId } : {}) };
    if (deps.notificationOnly) {
      journal.write({ event: 'dsh.approval', ...meta, remote: false, chats: admins });
      notify(admins, approvalNotice(sessionId, info.title, request), 'approval', sessionId);
      return next();
    }
    const wait = interactions.waitApproval(sessionId, {
      toolName: request.toolName, privateChats: admins, ...(request.callId ? { callId: request.callId } : {}),
    }, settings.questionTimeoutMs, request.signal, delivery);
    if (!wait) {
      notify(admins, approvalNotice(sessionId, info.title, request), 'approval', sessionId);
      return next();
    }
    journal.write({ event: 'dsh.approval', ...meta, remote: true, nonce: wait.nonce, chats: admins, timeoutMs: settings.questionTimeoutMs });
    notify(admins, approvalNotice(sessionId, info.title, request, wait.nonce, settings.questionTimeoutMs), 'approval-request', sessionId, wait.nonce);
    const outcome = await wait.result;
    journal.write({ event: 'dsh.approval.result', ...meta, nonce: wait.nonce, outcome: outcome ?? 'fallback' });
    return outcome ?? next();
  }

  function start(): () => void {
    if (closed || started) throw new Error('WeCom bridge cannot be started twice');
    started = true;
    generation++;
    status.set('connecting');
    client.on('connected', () => journal.write({ event: 'wecom.socket', state: 'connected' }));
    client.on('authenticated', () => {
      displaced = false;
      status.set('online');
      outbox.setOnline(true);
    });
    client.on('reconnecting', (attempt: number) => {
      if (!displaced) status.set('reconnecting', `第 ${attempt} 次重连`);
    });
    client.on('disconnected', (reason: string) => {
      outbox.setOnline(false);
      if (!displaced) status.set('offline', scrub(String(reason ?? '')).slice(0, 200) || undefined);
    });
    client.on('error', (error: Error) => {
      outbox.setOnline(false);
      log.warn('WeCom socket error (details in the plugin journal)');
      status.set('error', scrub(error?.message ?? String(error)).slice(0, 200));
    });
    client.on('event.disconnected_event', () => {
      displaced = true;
      outbox.setOnline(false);
      log.warn('WeCom Bot was taken over by another connection; resolve the duplicate before reconnecting');
      status.set('displaced', '同一个 Bot 在别处建立了新连接，本连接已被断开');
    });
    client.on('event', (frame: WsFrame) => journal.write({ event: 'wecom.event', level: 'debug', frame }));
    client.on('message', (frame: WsFrame) => {
      void handleFrame(frame).catch(error => {
        log.error('WeCom callback failed (details in the plugin journal)');
        journal.write({ event: 'bridge.error', level: 'error', stage: 'message', error });
      });
    });
    const offQuestion = deps.brokeredInteractions ? undefined : ctx.on('user-questions/request', onQuestion);
    const offApproval = deps.brokeredInteractions ? undefined : ctx.on('approval/request', onApproval);
    const stop = (): void => {
      if (closed) return;
      closed = true;
      generation++;
      lifetime.abort();
      interactions.cancelAll();
      outbox.clear();
      offQuestion?.();
      offApproval?.();
      try { client.disconnect(); } catch { log.warn('WeCom disconnect failed'); }
      try { client.removeAllListeners(); } catch { log.warn('WeCom listener cleanup failed'); }
    };
    try {
      client.connect();
    } catch (error) {
      stop();
      status.set('error', scrub(error instanceof Error ? error.message : String(error)).slice(0, 200));
      throw new Error('WeCom connection failed');
    }
    return stop;
  }

  return {
    start, handleFrame, whenIdle, onTurnEnd, onQuestion, onApproval, onSessionError, directory, observations, rounds,
    updateSettings(next) {
      const adminsChanged = JSON.stringify(settings.adminUserIds) !== JSON.stringify(next.adminUserIds);
      const scopeChanged = JSON.stringify(settings.adminWorkspaces) !== JSON.stringify(next.adminWorkspaces);
      if (adminsChanged || scopeChanged) {
        // Invalidate operations still awaiting a catalog read or passive ACK;
        // do not interrupt turns DSH has already accepted or drop the socket.
        generation++;
        for (const id of settings.adminUserIds) if (!next.adminUserIds.includes(id)) selection.clearChat(id);
      }
      if (adminsChanged || scopeChanged) {
        // An old nonce must not survive an approval-policy change. Questions
        // keep their original deadline; a new wait reads the new timeout.
        for (const pending of interactions.approvals.values()) pending.finish(null);
      }
      settings = next;
      policy = policyFor();
    },
    resetRouting(chat) {
      routingGenerations.set(chat, (routingGenerations.get(chat) ?? 0) + 1);
      selection.clearChat(chat);
    },
    notify(chat, text, kind) {
      if (closed) return;
      outbox.enqueue({ chat, text, kind });
    },
  };
}
