import type { BindingRecord, GroupRecord, WorkspaceOption } from '../../shared/protocol.js';
import type { SessionController } from '../dsh.js';
import type { Journal } from '../journal.js';
import type { Round } from '../rounds.js';
import type { SessionOperations } from '../session-ops.js';
import type { WorkspaceService } from '../workspaces.js';
import type { SessionDirectory } from './directory.js';
import { formatContext, shortId } from './format.js';
import type { InboundMessage } from './inbound.js';
import { parseAnswer, type InteractionRegistry } from './interactions.js';
import {
  adminOnlyText, adminPrivateOnlyText, adminUnassignedText, code, compactedText, deleteWarningText, deletedText, field,
  groupSessionRefusalText, HELP_TEXT, inline,
  newSessionText, noWorkspaceText, nothingToCompactText, sessionLabel, sessionListText, sessionRef,
  interactionIgnoredText, interactionSubmittedText, questionAccessRefusalText, title, workspaceListText,
} from './notices.js';
import type { AccessPolicy } from './policy.js';
import { sessionTitleFor } from '../session-title.js';
import type { SelectionStore } from './selection.js';

/** Slash commands sent from WeCom. Every handler answers with one passive reply. */

export interface ParsedCommand {
  readonly name: string;
  readonly args: readonly string[];
  /** Text after the command word, original spacing preserved. */
  readonly rest: string;
}

export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  const match = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return undefined;
  const rest = (match[2] ?? '').trim();
  return { name: match[1]!.toLowerCase(), args: rest ? rest.split(/\s+/) : [], rest };
}

/** Drop `count` whitespace-separated tokens and return the remaining text verbatim. */
export function textAfterTokens(text: string, count: number): string {
  let rest = text.trim();
  for (let i = 0; i < count; i++) rest = rest.replace(/^\S+\s*/, '');
  return rest.trim();
}

/** Where a sender's plain messages currently go. */
export interface TargetInfo {
  /** Empty when the sender has no Session yet. */
  readonly sessionId?: string;
  readonly binding?: BindingRecord;
  /** Operator note for this sender, whether or not they are a member. */
  readonly note?: string;
  /** The user group this sender belongs to, when they are a member. */
  readonly group?: GroupRecord;
  /** True when an administrator switch is in effect instead of the binding. */
  readonly switched: boolean;
}

/** The administrator preference the Bot itself writes (`/workspaces`). */
export interface AdminWorkspaceStore {
  adminWorkspace(user: string): string;
  setAdminWorkspace(user: string, path: string): Promise<void>;
}

export interface OperationTicket {
  readonly bridge: number;
  readonly chat: string;
  readonly routing: number;
}

export interface CommandServices {
  readonly policy: AccessPolicy;
  readonly directory: SessionDirectory;
  readonly selection: SelectionStore;
  readonly interactions: InteractionRegistry;
  readonly sessionController: SessionController;
  readonly journal: Journal;
  /** DSH operations the Bot exposes: archive, compact, create. */
  readonly ops: SessionOperations;
  readonly workspaces: WorkspaceService;
  readonly adminWorkspaces: AdminWorkspaceStore;
  /** The Session this sender talks to right now; never creates one. */
  current(message: InboundMessage): Promise<TargetInfo>;
  /** Archive `sessionId` and stop pointing any member at it. */
  archiveSession(message: InboundMessage, sessionId: string): Promise<void>;
  /** True once the bridge stopped or was replaced after `ticket` was taken. */
  stale(ticket: OperationTicket): boolean;
  ticket(message: InboundMessage): OperationTicket;
}

export interface CommandScope {
  readonly message: InboundMessage;
  readonly round: Round;
  reply(text: string): Promise<void>;
}

const BINDING_LABEL = { user: '个人', group: '群聊' } as const;

/**
 * Commands only an administrator may ever run. They act on the Bot rather than
 * on this chat's conversation, so a group chat refuses them even for an
 * administrator: the Session there is shared, and it must not be created,
 * switched or re-pointed — or its tool calls approved — from the group.
 */
const ADMIN_ONLY_COMMANDS = new Set([
  'new', 'workspaces', 'ws', 'sessions', 'list', 'ls', 'use', 'reset', 'approve', 'deny',
]);

/**
 * `**🏷 一句话结论**` plus an optional explanation line — the shape every
 * refusal and confirmation in this file uses, so a reply never looks like an
 * undifferentiated wall of text.
 */
function notice(emoji: string, summary: string, detail?: string): string {
  return [title(emoji, summary), ...(detail ? ['', detail] : [])].join('\n');
}

/** `- **标签**：值` — one detail line of a multi-line reply. */
function bullet(label: string, value: string): string {
  return `- ${field(label, value)}`;
}

/** The Workspace a command should default to for one administrator. */
function preferredWorkspace(services: CommandServices, user: string): string {
  return services.adminWorkspaces.adminWorkspace(user);
}

/** Title of one Workspace path, falling back to the path itself. */
async function workspaceTitle(services: CommandServices, path: string): Promise<string> {
  if (!path) {
    try {
      return (await services.workspaces.describe('')).title;
    } catch {
      return '插件默认 Workspace';
    }
  }
  const listed = services.workspaces.list().find(workspace => workspace.path === path);
  return listed?.title ?? path;
}

export async function runCommand(services: CommandServices, scope: CommandScope, command: ParsedCommand): Promise<void> {
  const { message, reply } = scope;
  const { directory, selection, interactions, policy } = services;
  const ticket = services.ticket(message);
  const current = () => !services.stale(ticket);
  const isAdmin = policy.isAdmin(message.user);
  // An administrator command in a group chat is refused whoever sends it: the
  // shared conversation is not the place to manage the Bot. The reply names the
  // real reason — rank for a member, the shared chat for an administrator.
  if (message.chatType === 'group' && ADMIN_ONLY_COMMANDS.has(command.name)) {
    await reply(isAdmin ? adminPrivateOnlyText() : adminOnlyText());
    return;
  }
  // Commands that touch this conversation's Session (compact, delete) are open
  // to everybody in a private chat; in a group chat that Session is shared, so
  // they need an administrator — and the refusal says *that*, because a member
  // in a group is usually after their own Session, not the group's.
  const allowed = (): boolean => isAdmin || message.chatType === 'single';
  const deny = async (): Promise<void> => {
    await reply(message.chatType === 'group' ? groupSessionRefusalText(command.name) : adminOnlyText());
  };

  switch (command.name) {
    case 'help':
    case 'h':
      await reply(HELP_TEXT);
      return;

    case 'whoami': {
      const target = await services.current(message);
      if (!current()) return;
      const lines = [
        title('🪪', '你的身份'),
        '',
        bullet('userid', code(inline(message.user, 120))),
        message.chatType === 'group'
          ? bullet('当前群聊', code(inline(message.chat, 120)))
          : bullet('当前会话', '单聊（chatid 即你的 userid）'),
        bullet('管理员', isAdmin ? '是' : '否'),
      ];
      if (target.group) lines.push(bullet('分组', inline(target.group.name, 60)));
      if (target.binding) {
        lines.push(bullet('绑定', `${BINDING_LABEL[target.binding.kind]} ${code(inline(target.binding.id, 120))}`));
      }
      lines.push(
        '',
        isAdmin
          ? `你是本插件的管理员：可以切换会话、选择默认 Workspace，并按 Workspace 接收通知。`
          : `你不是本插件的管理员：消息只会进入你自己的专属会话，发送 ${code('/delete')} 可以清空它的记忆。`,
        '',
        '分组、Workspace 与模型都可以在 DSH 的插件主页里查看和调整。',
      );
      await reply(lines.join('\n'));
      return;
    }

    case 'status': {
      const target = await services.current(message);
      const info = target.sessionId ? await directory.describe(target.sessionId) : undefined;
      if (!current()) return;
      const questions = [...interactions.questions.values()].filter(q => q.sessionId === target.sessionId).length;
      const approvals = [...interactions.approvals.values()].filter(a => a.privateChats.has(message.chat)).length;
      const running = info?.running === true;
      const lines = [
        title('🧭', '当前状态'),
        '',
        target.sessionId
          ? bullet('会话', sessionRef(info?.title, target.sessionId))
          : bullet('会话', isAdmin && !target.binding
            ? '尚未选择（请先新建或选择会话）' : '尚未创建（发送任意消息即会自动创建）'),
        ...(info?.workspace ? [bullet('Workspace', inline(info.workspace, 120))] : []),
        ...(target.sessionId ? [bullet('preset', info?.preset ? code(inline(info.preset, 60)) : 'DSH 默认')] : []),
        ...(info?.model ? [bullet('模型', code(`${info.model.provider}/${info.model.model}`))] : []),
        ...(info?.model?.reasoningEffort ? [bullet('effort', code(inline(info.model.reasoningEffort, 40)))] : []),
        ...(info?.context ? [bullet('上下文', formatContext(info.context.used, info.context.window))] : []),
        ...(info?.turns !== undefined || info?.steps !== undefined
          ? [bullet('进度', `第 ${info?.turns ?? 0} 轮 · 累计 ${info?.steps ?? 0} 步`)]
          : []),
        ...(target.sessionId
          ? [bullet('运行状态', questions ? '等待回答提问' : running ? '运行中' : '空闲')]
          : []),
      ];
      if (target.group) lines.push(bullet('分组', inline(target.group.name, 60)));
      if (target.binding) {
        const note = target.note ? `（${inline(target.note, 40)}）` : '';
        lines.push(bullet('绑定', `${BINDING_LABEL[target.binding.kind]} ${code(inline(target.binding.id, 120))}${note}`));
      }
      lines.push(bullet('待处理', `${questions} 个提问 · ${approvals} 个审批`));
      if (target.switched) {
        lines.push('', `> 管理员切换中：你现在操作的不是自己的专属会话。发送 ${code('/reset')} 可以回到自己的会话。`);
      }
      await reply(lines.join('\n'));
      return;
    }

    case 'new': {
      if (!isAdmin) { await deny(); return; }
      const path = preferredWorkspace(services, message.user);
      try {
        // `/new` only runs in a single chat (a group is refused above), so the
        // administrator's own userid is the principal the Session belongs to.
        const created = await services.ops.create({ workspace: path, title: sessionTitleFor(message.user) });
        if (!current()) return;
        selection.set(message.chat, message.user, created.sessionId);
        const label = await workspaceTitle(services, path);
        if (!current()) return;
        services.journal.write({
          event: 'wecom.session.new', roundId: scope.round.id, chatId: message.chat,
          userId: message.user, sessionId: created.sessionId, workspace: path,
        });
        await reply(newSessionText(label, created.sessionId));
      } catch (error) {
        if (current()) await reply(notice('⚠️', '新建会话失败', inline(error instanceof Error ? error.message : String(error), 300)));
      }
      return;
    }

    case 'workspaces':
    case 'ws': {
      if (!isAdmin) { await deny(); return; }
      const selected = preferredWorkspace(services, message.user);
      const list: readonly WorkspaceOption[] = services.workspaces.list();
      const token = command.args[0];
      if (!token) {
        await reply(workspaceListText(list, selected).text);
        return;
      }
      if (!list.length) { await reply(noWorkspaceText()); return; }
      if (token === '0' || token.toLowerCase() === 'all') {
        await services.adminWorkspaces.setAdminWorkspace(message.user, '');
        if (!current()) return;
        await reply(notice('🗂', '已取消 Workspace 限定', `之后的 ${code('/sessions')} 会列出所有 Workspace 的会话，${code('/new')} 使用插件默认 Workspace。`));
        return;
      }
      const index = /^\d{1,3}$/.test(token) ? Number(token) : undefined;
      const picked = index !== undefined ? list[index - 1] : list.find(workspace => workspace.path === token);
      if (!picked) {
        await reply(notice('⚠️', '没有这个 Workspace', `发送 ${code('/workspaces')} 查看序号。`));
        return;
      }
      await services.adminWorkspaces.setAdminWorkspace(message.user, picked.path);
      if (!current()) return;
      services.journal.write({ event: 'wecom.workspace.select', roundId: scope.round.id, chatId: message.chat, userId: message.user, workspace: picked.path });
      await reply([
        title('🗂', `默认 Workspace 已设为 ${inline(picked.title, 60)}`),
        '',
        bullet('路径', inline(picked.path, 200)),
        '',
        `${code('/sessions')} 只列出这个 Workspace 的会话，${code('/new')} 也在这里创建。发送 ${code('/workspaces 0')} 取消限定。`,
      ].join('\n'));
      return;
    }

    case 'sessions':
    case 'list':
    case 'ls': {
      if (!isAdmin) { await deny(); return; }
      const scopePath = preferredWorkspace(services, message.user);
      try {
        const groups = await directory.groups(scopePath ? { workspacePath: scopePath } : undefined);
        if (!current()) return;
        const target = await services.current(message);
        const label = scopePath ? await workspaceTitle(services, scopePath) : undefined;
        if (!current()) return;
        const { text, listing } = sessionListText(groups, target.sessionId, 30, label);
        selection.setListing(message.chat, message.user, listing);
        await reply(text);
      } catch {
        if (current()) await reply(notice('⚠️', '读取 DSH 会话列表失败', '请稍后重试，或到 DSH 页面查看。'));
      }
      return;
    }

    case 'use': {
      if (!isAdmin) { await deny(); return; }
      const token = command.args[0];
      if (!token) {
        await reply(notice('ℹ️', '用法', `${code('/use 序号')} 或 ${code('/use 会话ID前缀')}；先发送 ${code('/sessions')} 查看序号。`));
        return;
      }
      const result = await directory.resolve(token, selection.listing(message.chat, message.user));
      if (!current()) return;
      if (!result.ok) {
        const text = result.reason === 'ambiguous' ? notice('⚠️', '匹配到多个会话', '请提供更长的会话 ID 前缀。')
          : result.reason === 'unavailable' ? notice('⚠️', '暂时无法读取 DSH 会话列表', '请稍后重试。')
          : result.reason === 'forbidden' ? notice('🔒', '该会话不在你的 Workspace 范围内', '请让管理员调整管理员 Workspace 设置。')
          : result.hidden === 'archived' ? notice('⚠️', '该会话已归档', '归档的会话不能从企业微信操作。')
          : result.hidden ? notice('⚠️', '该会话当前不可操作')
          : notice('⚠️', '找不到该会话', `发送 ${code('/sessions')} 查看可切换的会话。`);
        await reply(text);
        return;
      }
      selection.set(message.chat, message.user, result.session.sessionId);
      services.journal.write({ event: 'wecom.selection', roundId: scope.round.id, chatId: message.chat, userId: message.user, sessionId: result.session.sessionId });
      await reply([
        title('🔄', `已切换到${sessionLabel(result.session.title)}`),
        '',
        bullet('Workspace', inline(result.session.workspace, 120)),
        bullet('会话 ID', code(shortId(result.session.sessionId))),
        '',
        `现在直接发送消息即可继续该会话；发送 ${code('/reset')} 可以回到自己的专属会话。`,
      ].join('\n'));
      return;
    }

    case 'reset': {
      if (!isAdmin) { await deny(); return; }
      selection.clear(message.chat, message.user);
      if (!current()) return;
      const target = await services.current(message);
      if (!target.sessionId) {
        await reply(target.binding
          ? notice('↩️', '已放弃切换', '你还没有专属会话，发送任意消息即可创建。')
          : adminUnassignedText());
        return;
      }
      const info = await directory.describe(target.sessionId);
      if (!current()) return;
      await reply(`${title('↩️', '已放弃切换')} · 回到你自己的专属会话${sessionLabel(info.title)}`);
      return;
    }

    case 'compact': {
      const target = await services.current(message);
      if (!current()) return;
      if (!target.sessionId) { await reply(isAdmin && !target.binding ? adminUnassignedText()
        : notice('ℹ️', '你还没有专属会话', '发送任意消息即可创建。')); return; }
      if (!allowed()) { await deny(); return; }
      try {
        const outcome = await services.ops.compact(target.sessionId);
        if (!current()) return;
        await reply(outcome ? compactedText(outcome.items, outcome.tokens) : nothingToCompactText());
      } catch (error) {
        if (current()) await reply(notice('⚠️', '上下文压缩失败', inline(error instanceof Error ? error.message : String(error), 300)));
      }
      return;
    }

    case 'delete': {
      const target = await services.current(message);
      if (!current()) return;
      if (!target.sessionId) { await reply(isAdmin && !target.binding ? adminUnassignedText()
        : notice('ℹ️', '你还没有专属会话', '发送任意消息即可创建。')); return; }
      if (!allowed()) { await deny(); return; }
      const confirmed = (command.args[0] ?? '').toLowerCase() === 'confirm';
      if (!confirmed) {
        const info = await directory.describe(target.sessionId);
        if (!current()) return;
        await reply(deleteWarningText(info.title, target.sessionId));
        return;
      }
      try {
        const info = await directory.describe(target.sessionId);
        if (!current()) return;
        await services.archiveSession(message, target.sessionId);
        if (!current()) return;
        services.journal.write({
          event: 'wecom.session.delete', roundId: scope.round.id, chatId: message.chat,
          userId: message.user, sessionId: target.sessionId,
        });
        await reply(`${deletedText()}\n\n> 已归档${sessionLabel(info.title)}`);
      } catch (error) {
        if (current()) await reply(notice('⚠️', '归档会话失败', inline(error instanceof Error ? error.message : String(error), 300)));
      }
      return;
    }

    case 'cancel': {
      const target = await services.current(message);
      if (!current()) return;
      if (!target.sessionId) { await reply(isAdmin && !target.binding ? adminUnassignedText()
        : notice('ℹ️', '你还没有专属会话', '发送任意消息即可创建。')); return; }
      if (!(await directory.permitted(target.sessionId))) {
        // A bound Session may live outside the administrator scope; cancelling
        // it is still the owner's business, so only a switched-to Session is refused here.
        if (target.switched) { if (current()) await reply(notice('⚠️', '该会话当前不可操作')); return; }
      }
      if (!current()) return;
      try {
        services.sessionController.cancel({ sessionId: target.sessionId });
        services.journal.write({ event: 'dsh.cancel', roundId: scope.round.id, sessionId: target.sessionId, chatId: message.chat, userId: message.user });
        await reply(`${title('🛑', '已请求停止当前回合')} · ${code(shortId(target.sessionId))}`);
      } catch (error) {
        services.journal.write({ event: 'dsh.cancel', level: 'warn', roundId: scope.round.id, sessionId: target.sessionId, error });
        await reply(notice('🛑', '没有可停止的回合', '该会话当前没有正在运行的回合。'));
      }
      return;
    }

    case 'answer': {
      const state = command.args[0] ? interactions.findQuestion(command.args[0]) : undefined;
      if (!state) {
        await reply(command.args[0] && interactions.wasClosed(command.args[0]) ? interactionIgnoredText()
          : notice('⚠️', '没有对应的待回答提问', '验证码可能无效或已经过期。'));
        return;
      }
      const target = await services.current(message);
      const mayAnswer = target.sessionId === state.sessionId
        || (isAdmin && message.chatType === 'single' && await directory.permitted(state.sessionId));
      if (!current()) return;
      if (!mayAnswer) {
        await reply(questionAccessRefusalText());
        return;
      }
      if (!state.active()) { await reply(interactionIgnoredText()); return; }
      let question = state.questions.length === 1 ? state.questions[0] : undefined;
      let answer = textAfterTokens(command.rest, 1);
      if (question && command.args[1] === question.id && command.args.length > 2) answer = textAfterTokens(command.rest, 2);
      if (state.questions.length > 1) {
        question = state.questions.find(q => q.id === command.args[1]);
        answer = textAfterTokens(command.rest, 2);
      }
      if (!question) {
        await reply(notice('⚠️', '请指明题目 ID', state.questions.map(q => code(inline(q.id, 60))).join('、')));
        return;
      }
      const parsed = parseAnswer(question, answer);
      if (!parsed.ok) {
        await reply(notice('⚠️', parsed.error, `格式：${code('/answer 验证码 选项序号或文字')}`));
        return;
      }
      state.answers.set(question.id, parsed.item);
      const remaining = state.questions.filter(q => !state.answers.has(q.id));
      services.journal.write({ event: 'dsh.question.answer', roundId: scope.round.id, sessionId: state.sessionId, questionId: question.id, answer: parsed.item, remaining: remaining.length });
      if (remaining.length) {
        await reply(`${title('📝', '已记录')} · 还需回答：${remaining.map(q => inline(q.id, 60)).join('、')}`);
      } else {
        const result = await state.submit({ answers: state.questions.map(q => state.answers.get(q.id)!) });
        await reply(result === 'closed' ? interactionIgnoredText()
          : result === 'submitted' ? interactionSubmittedText('question') : title('✅', '答案已提交给 DSH'));
      }
      return;
    }

    case 'approve':
    case 'deny': {
      const state = command.args[0] ? interactions.findApproval(command.args[0]) : undefined;
      // Reaching here already means a single chat (a group is refused above);
      // the approval must still be visible to this chat and the sender an
      // administrator.
      if (!state || command.args.length !== 1 || !state.privateChats.has(message.chat) || !isAdmin) {
        await reply(command.args[0] && interactions.wasClosed(command.args[0]) ? interactionIgnoredText()
          : notice('⚠️', '没有可在此单聊审批的请求', '只有管理员可以在单聊里用验证码审批；验证码也可能已经过期。'));
        return;
      }
      const permitted = await directory.permitted(state.sessionId);
      if (!current()) return;
      if (!permitted) { await reply(questionAccessRefusalText()); return; }
      if (!state.active()) { await reply(interactionIgnoredText()); return; }
      const outcome = command.name === 'approve' ? 'allowed-once' : 'rejected';
      const result = await state.submit(outcome);
      services.journal.write({ event: 'dsh.approval.answer', roundId: scope.round.id, sessionId: state.sessionId, toolName: state.toolName, callId: state.callId, outcome, submission: result });
      await reply(result === 'closed' ? interactionIgnoredText()
        : result === 'submitted' ? interactionSubmittedText('approval')
          : title(outcome === 'allowed-once' ? '✅' : '🚫', outcome === 'allowed-once' ? '已允许本次工具调用' : '已拒绝本次工具调用'));
      return;
    }

    default:
      await reply(`${title('❓', '未知命令')} · 发送 ${code('/help')} 查看可用命令。`);
  }
}
