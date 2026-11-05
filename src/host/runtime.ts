import { WSClient } from '@wecom/aibot-node-sdk';
import { createBridge, type Bridge, type BridgeClient } from './bridge/index.js';
import { adminGrantedNotice, authorizedNotice, groupAssignedNotice } from './bridge/notices.js';
import { createAccessPolicy } from './bridge/policy.js';
import { createInteractionTransport } from './interaction-transport.js';
import { applyStoreOps, buildRoutingView, type StoreOpResult } from './groups-view.js';
import { createStore, type PluginStore } from './store.js';
import { catalogView, createCatalogService, type CatalogService } from './catalog.js';

import {
  isTrustedWsUrl, readBridgeSettings, readJournalSettings, type BridgeSettings, type JournalSettings,
  type PluginConfig,
} from './config.js';
import type {
  AgentDefaultModel, AgentPresetRegistry, HostContext, Logger, SessionEvent, SessionHandle, WorkspaceRegistry,
} from './dsh.js';
import { pluginHome, type Journal } from './journal.js';
import { createModelService, type ModelService } from './models.js';
import { createObservationStore, type ObservationStore } from './observation.js';
import { createPermissionService, type PermissionService } from './permissions.js';
import { createPresetService, type PresetService } from './presets.js';
import { createRoundTracker, type RoundTracker } from './rounds.js';
import { createRouter, type Router } from './routing.js';
import { createSessionOperations, type SessionOperations } from './session-ops.js';
import { createSessionProvisioner, type SessionProvisioner } from './sessions.js';
import { createSessionTitler } from './session-title.js';
import { createStatusTracker, type StatusTracker } from './status.js';
import { summarizeTurn, type TurnSummary } from './turns.js';
import { createWorkspaceService, pluginWorkspacePath } from './workspaces.js';
import { createSoulService, type SoulService } from './soul/service.js';
import { createSoulScheduler } from './soul/scheduler.js';
import { SCHEDULER_USER } from './soul/rules.js';
import { createSoulStore, validateSoulPatch, type SoulStore } from './soul/store.js';
import { join } from 'node:path';
import {
  STORE_VERSION, type BridgeStateView, type ModelCatalogView, type PresetCatalogView, type StoreOp, type RoutingView,
} from '../shared/protocol.js';

/**
 * Host-lifetime orchestration.
 *
 * Owns everything that must survive a reconnect — rejected senders, rounds,
 * the Session catalog, groups and memberships, status counters — and rebuilds
 * the WeCom bridge whenever the Config changes. It also owns the single
 * `session/event` listener, so turns that end while the bridge is being
 * replaced still complete their rounds.
 */

export interface ClientOptions {
  readonly botId: string;
  readonly secret: string;
  readonly wsUrl?: string;
  readonly logger: { debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

export interface RuntimeOptions {
  readonly ctx: HostContext;
  readonly config: PluginConfig;
  readonly log: Logger;
  readonly journal: Journal;
  readonly createClient?: (options: ClientOptions) => BridgeClient;
  /** `defineTool` from @deepseek-ai/dsh-tools; resolved by the plugin entry when DSH provides it. */
  readonly defineTool?: (options: unknown) => unknown;
  /** Override the soul store directory (tests). */
  readonly soulDirectory?: string;
}

export interface Runtime {
  start(): Promise<void>;
  stop(): Promise<void>;
  state(options?: { readonly refresh?: boolean }): Promise<BridgeStateView>;
  /** The groups/members table for the settings page. */
  routingView(options?: { readonly refresh?: boolean }): Promise<RoutingView>;
  /** Apply settings-page group and member edits. */
  applyOps(ops: readonly StoreOp[]): Promise<StoreOpResult>;
  /** Values the journal must scrub (the resolved Bot Secret). */

  secrets(): readonly string[];
  /** The journal's own settings; read from the store on every write. */
  journalSettings(): JournalSettings;
  readonly observations: ObservationStore;
  readonly rounds: RoundTracker;
  readonly status: StatusTracker;
  readonly catalogs: CatalogService;
  readonly store: PluginStore;
  current(): Bridge | undefined;
  readonly soul: SoulService;
  readonly soulStore: SoulStore;
  /** Run one scheduler tick now (tests and manual triggers). */
  tickScheduler(): Promise<void>;
  /** Apply one persona/memory settings edit from the page. */
  applySoul(patch: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { ctx, config, log, journal } = options;
  const createClient = options.createClient ?? ((clientOptions: ClientOptions) => new WSClient({
    botId: clientOptions.botId,
    secret: clientOptions.secret,
    ...(clientOptions.wsUrl ? { wsUrl: clientOptions.wsUrl } : {}),
    logger: clientOptions.logger,
  }) as unknown as BridgeClient);

  const status = createStatusTracker(journal);
  const observations = createObservationStore();
  const rounds = createRoundTracker({ journal });
  const catalogs = createCatalogService({
    list: async signal => (await ctx.sessionController.list({}, signal)).items,
    registry: () => {
      const registry = ctx.get?.('workspaceRegistry') as WorkspaceRegistry | undefined;
      return registry && typeof registry.list === 'function' ? registry : undefined;
    },
  });
  const store = createStore({
    directory: pluginHome(),
    onError: (error, stage) => {
      log.warn(`WeCom routing store ${stage} failed`);
      journal.write({ event: 'binding.store.error', level: 'warn', stage, error });
    },
  });
  const workspaces = createWorkspaceService({
    registry: () => {
      const registry = ctx.get?.('workspaceRegistry') as WorkspaceRegistry | undefined;
      return registry && typeof registry.list === 'function' ? registry : undefined;
    },
    defaultPath: pluginWorkspacePath(pluginHome()),
    log,
  });
  const models: ModelService = createModelService({
    sessionController: ctx.sessionController,
    defaults: () => ctx.get?.('agentDefaultModel') as AgentDefaultModel | undefined,
    log,
  });
  const presets: PresetService = createPresetService({
    registry: () => ctx.get?.('agentPresets') as AgentPresetRegistry | undefined,
  });
  const permissions: PermissionService = createPermissionService({ ctx, sessionController: ctx.sessionController, journal });
  const titles = createSessionTitler({ ctx, journal });
  const sessionOps: SessionOperations = createSessionOperations({ ctx, workspaces, catalogs, titles, journal });
  const provisioner: SessionProvisioner = createSessionProvisioner({
    sessionController: ctx.sessionController,
    models,
    permissions,
    workspaces,
    catalogs,
    bindings: store,
    bindingKey: binding => `${binding.kind}:${binding.id}`,
    titles,
    journal,
    log,
  });

  const router: Router = createRouter({ store, provisioner, log });
  const soulStore = createSoulStore({ directory: options.soulDirectory ?? join(pluginHome(), 'soul') });
  const soul = createSoulService({
    ctx, store: soulStore, journal,
    bindings: { forSession: sessionId => store.forSession(sessionId) },
    admins: () => store.settings().adminUserIds,
    ...(options.defineTool ? { defineTool: options.defineTool } : {}),
  });
  let stopSoul: (() => void) | undefined;
  /** Aborts plugin-initiated prompts still in flight when the plugin stops. */
  const schedulerLifetime = new AbortController();
  const scheduler = createSoulScheduler({
    store: soulStore, soul, journal,
    bindingFor: key => store.get(key),
    online: () => status.connection().phase === 'online',
    async submit(binding, text, requestId) {
      const chatType = binding.kind === 'group' ? 'group' as const : 'single' as const;
      // Routing keys a private chat by its user, a group by its chat id.
      const parts = { chat: binding.id, user: binding.id, chatType };
      const routed = await router.route(parts, binding.groupId);
      if (!routed.ok || !routed.sessionId) {
        journal.write({ event: 'soul.scheduled.route-failed', level: 'warn', binding: binding.kind + ':' + binding.id });
        return undefined;
      }
      // The scheduler is never an owner: the turn stays chat-only.
      soul.noteSender(routed.sessionId, { user: SCHEDULER_USER, chat: binding.id, chatType }, requestId, '');
      await ctx.sessionController.prompt({
        requestId, sessionId: routed.sessionId, mode: 'queue',
        content: [{ type: 'text', text }],
      }, schedulerLifetime.signal);
      return routed.sessionId;
    },
  });
  let stopScheduler: (() => void) | undefined;

  let bridge: Bridge | undefined;
  let stopBridge: (() => void) | undefined;
  const interactionTransport = createInteractionTransport({
    ctx, journal,
    async onQuestion(request, delivery) {
      if (!bridge) return delivery.decline();
      return bridge.onQuestion(request, async () => { await delivery.decline(); return { answers: [] }; }, delivery);
    },
    async onApproval(request, delivery) {
      if (!bridge) return delivery.decline();
      return bridge.onApproval(request, async () => { await delivery.decline(); return 'unavailable'; }, delivery);
    },
  });
  /**
   * The connection identity of the live bridge: Bot ID, resolved Secret and the
   * WebSocket endpoint. Only these three ever justify dropping the socket — the
   * rest of the settings are handed to the running bridge, so adding an
   * administrator or re-scoping notifications costs no reconnect.
   */
  let identity = '';
  /** The settings the live bridge currently holds, to journal real changes only. */
  let applied = '';
  let secret = '';
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;
  let lastCatalogError = '';
  const disposers: (() => void)[] = [];

  const scrub = (text: string) => (secret.length >= 6 ? text.split(secret).join('[redacted]') : text);

  function sdkLogger(): ClientOptions['logger'] {
    const forward = (level: 'info' | 'warn' | 'error') => (...args: unknown[]) => {
      const parts = args.map(arg => typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : arg);
      journal.write({ event: 'wecom.sdk', level, message: parts });
      const text = scrub(parts.filter(part => typeof part === 'string').join(' '));
      // Surface the SDK's terminal conditions on the settings page.
      if (/^Authentication failed/.test(text)) status.set('error', `认证失败：${text.replace(/^Authentication failed:\s*/, '').slice(0, 160)}`);
      else if (/^Max auth failure attempts/.test(text)) status.set('error', '多次认证失败，已停止重试；请检查 Bot ID 与 Secret');
      else if (/^Max reconnect attempts/.test(text)) status.set('offline', '多次重连失败，已停止重连；在插件页的「连接」里重新保存一次即可再连');
    };
    return { debug() {}, info: forward('info'), warn: forward('warn'), error: forward('error') };
  }

  function teardown(): void {
    stopBridge?.();
    stopBridge = undefined;
    bridge = undefined;
  }

  async function reconfigure(): Promise<void> {
    if (disposed) return;
    // The settings live in the store's file, so it has to be read before the first
    // connection decision can be made. A reload event that arrives while the
    // plugin is still starting otherwise queues this ahead of `store.load()`, and
    // the bridge dials out with the defaults (no administrators) before adopting
    // the real block a moment later — visible in the journal as a `rebuilt`
    // followed by a `kept`. `load()` is memoized, so this costs one read.
    await store.load();
    if (disposed) return;
    const settings: BridgeSettings = readBridgeSettings(config, store.settings());
    if (settings.wsUrl && !isTrustedWsUrl(settings.wsUrl)) {
      if (identity !== 'invalid-ws') {
        teardown();
        identity = 'invalid-ws';
        secret = '';
        log.error('WeCom wsUrl must be a credential-free wss:// address; connection disabled');
        status.set('invalid', 'WebSocket 地址必须是不含账号密码的 wss:// 地址');
      }
      return;
    }
    let resolved = '';
    if (settings.secretRef) {
      try {
        resolved = (await ctx.credentials.resolve(settings.secretRef))?.value ?? '';
      } catch (error) {
        if (disposed) return;
        teardown();
        identity = '';
        status.set('error', '读取 DSH 凭据失败');
        journal.write({ event: 'config.error', level: 'error', stage: 'credentials', secretRef: settings.secretRef, error });
        return;
      }
    }
    if (disposed) return;
    const connection = JSON.stringify([settings.botId, resolved, settings.wsUrl]);
    const summary = {
      botId: settings.botId, secretRef: settings.secretRef, secretConfigured: Boolean(resolved),
      wsUrl: settings.wsUrl || 'sdk-default',
      adminUserIds: settings.adminUserIds, adminWorkspaces: settings.adminWorkspaces,
      questionTimeoutMs: settings.questionTimeoutMs, remoteApprovals: settings.remoteApprovals,
    };
    if (connection === identity) {
      // Nothing about the connection moved: the settings changed, or the event
      // was about something else entirely. Hand the live bridge the new values —
      // a settings edit must never cost the socket.
      const current = JSON.stringify(settings);
      if (bridge && current !== applied) {
        applied = current;
        bridge.updateSettings(settings);
        journal.write({ event: 'config.applied', connection: 'kept', ...summary });
      }
      return;
    }
    identity = connection;
    applied = JSON.stringify(settings);
    teardown();
    secret = resolved;
    journal.write({ event: 'config.applied', connection: 'rebuilt', ...summary });
    if (!settings.botId || !resolved) {
      log.info?.('WeCom bridge awaits Bot ID and Secret on the plugin page');
      status.set('unconfigured', !settings.botId ? '缺少 Bot ID' : '缺少 Bot Secret');
      return;
    }
    const client = createClient({
      botId: settings.botId, secret: resolved, logger: sdkLogger(),
      ...(settings.wsUrl ? { wsUrl: settings.wsUrl } : {}),
    });
    const created = createBridge({
      ctx, client, settings, router, log, journal, observations, rounds, catalogs, status, scrub,
      ops: sessionOps, workspaces, soul,
      brokeredInteractions: Boolean(interactionTransport), notificationOnly: !interactionTransport,
    });
    stopBridge = created.start();
    bridge = created;
  }

  /**
   * Queue one reconfigure and hand back the queue, so an edit that must be
   * visible immediately can await the running bridge adopting it.
   */
  function schedule(): Promise<void> {
    queue = queue.then(reconfigure).catch(error => {
      log.error('WeCom reconfigure failed (details in the plugin journal)');
      journal.write({ event: 'bridge.error', level: 'error', stage: 'reconfigure', error });
    });
    return queue;
  }

  async function onTurnEnd(session: SessionHandle, end: SessionEvent): Promise<void> {
    let cached: TurnSummary | undefined;
    const summary = () => (cached ??= summarizeTurn(session, end));
    let notified: readonly string[] = [];
    try {
      notified = bridge ? await bridge.onTurnEnd(session, end, summary) : [];
    } catch (error) {
      journal.write({ event: 'bridge.error', level: 'error', stage: 'turn-end', sessionId: session.id, error });
    }
    soul.onTurnEnd(session.id, summary().promptIds);
    if (!rounds.hasPending(session.id) && !notified.length) return;
    const turn = summary();
    journal.write({
      event: 'dsh.turn.end', sessionId: session.id, turn: turn.turn, reason: turn.reason,
      durationMs: turn.durationMs, model: turn.model, steps: turn.steps, toolCalls: turn.toolCalls,
      omittedBlocks: turn.omittedBlocks, promptIds: turn.promptIds, assistant: turn.assistantText,
      notifiedChats: notified,
    });
    rounds.onTurnEnd(turn, notified);
  }

  function onSessionEvent(session: SessionHandle, event: SessionEvent): void {
    if (disposed) return;
    if (event.type === 'session/title') catalogs.invalidate();
    if (event.type === 'turn/end') void onTurnEnd(session, event);
  }

  /** Never let a slow model catalog hold up the settings page. */
  async function modelsView(refresh: boolean): Promise<{ view: ModelCatalogView | null; error?: string }> {
    const cached = models.snapshot();
    if (cached && !refresh) return { view: cached };
    try {
      if (cached) return { view: await models.load({ refresh: true }) };
      const loaded = await Promise.race([
        models.load(),
        new Promise<undefined>(resolve => { setTimeout(() => resolve(undefined), 2500).unref?.(); }),
      ]);
      return { view: loaded ?? models.snapshot() ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { view: cached ?? null, error: `读取 DSH 模型列表失败：${message}` };
    }
  }

  /** Presets are a local read; a failure only costs the group form its choices. */
  async function presetsView(refresh: boolean): Promise<{ view: PresetCatalogView | null; error?: string }> {
    const cached = presets.snapshot();
    if (cached && !refresh) return { view: cached };
    try {
      return { view: await presets.load({ refresh }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { view: cached ?? null, error: `读取 DSH preset 列表失败：${message}` };
    }
  }

  async function routingView(options: { readonly refresh?: boolean } = {}): Promise<RoutingView> {
    await store.load();
    if (options.refresh) catalogs.invalidate();
    const policy = createAccessPolicy(readBridgeSettings(config, store.settings()), { memberOf: () => undefined });
    return await buildRoutingView({
      store, provisioner, workspaces, models, presets, permissions, catalogs, observations, router,
      ops: sessionOps,
      isAdmin: user => policy.isAdmin(user),
    });
  }

  return {
    observations, rounds, status, catalogs, store, soul, soulStore,
    tickScheduler: () => scheduler.tick(),
    current: () => bridge,
    async applySoul(patch) {
      await soulStore.load();
      const checked = validateSoulPatch(patch);
      if (!checked.ok) return checked;
      await soulStore.update(checked.patch);
      journal.write({ event: 'soul.settings', fields: Object.keys(checked.patch) });
      return { ok: true };
    },

    secrets: () => (secret ? [secret] : []),
    journalSettings: () => readJournalSettings(store.settings()),
    async start() {
      const off = [
        ctx.on('app-boot/config-reload', schedule),
        ctx.on('credentials/reference-updated', ref => { if (ref === config.secretEnv.get().trim()) schedule(); }),
        ctx.on('session/event', onSessionEvent),
        ctx.on('api-session/error', sessionId => {
          // The event's message may contain a provider failure chain. Never relay
          // raw exception text; the Session pointer is enough to inspect safely.
          void bridge?.onSessionError(sessionId).catch(() => {
            journal.write({ event: 'bridge.error', stage: 'session-error', sessionId });
          });
        }),
      ];
      for (const dispose of off) if (typeof dispose === 'function') disposers.push(dispose);
      await store.load();
      await soulStore.load();
      stopSoul = soul.start();
      stopScheduler = scheduler.start();
      schedule();
      await queue;
      await interactionTransport?.start();
    },
    async stop() {
      disposed = true;
      for (const dispose of disposers.splice(0)) dispose();
      stopScheduler?.();
      stopScheduler = undefined;
      schedulerLifetime.abort();
      stopSoul?.();
      stopSoul = undefined;
      await queue;
      await interactionTransport?.stop();
      teardown();
      rounds.closeAll('interrupted');
      await store.flush();
    },
    routingView,
    async applyOps(ops) {
      await store.load();
      const before = new Map(store.bindings().map(binding => [`${binding.kind}:${binding.id}`, binding]));
      const policy = createAccessPolicy(readBridgeSettings(config, store.settings()), { memberOf: () => undefined });
      const result = await applyStoreOps({
        store, provisioner, workspaces, models, presets, permissions, router, catalogs, observations, log,
        ops: sessionOps,
        isAdmin: user => policy.isAdmin(user),
      }, ops);
      if (result.changed > 0) catalogs.invalidate();
      const after = new Map(store.bindings().map(binding => [`${binding.kind}:${binding.id}`, binding]));
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(key);
        const current = after.get(key);
        if (previous?.groupId !== current?.groupId || (previous?.sessionId && !current?.sessionId)) {
          bridge?.resetRouting((current ?? previous)!.id);
        }
      }
      // A settings edit lands in the store, and the running bridge has to hear
      // about it: administrators, the notification scope and the question timeout
      // are read per message. `reconfigure` sees an unchanged connection identity
      // and updates the live bridge instead of reconnecting. Await it: the page
      // says the edit is live as soon as this call returns, and a promotion must
      // be usable by the very next command, not one microtask later.
      //
      // This runs even when `ok` is false: an earlier op in the batch stays
      // applied, and leaving the bridge with its old administrators is exactly
      // the "only after a restart" bug.
      if (result.settingsChanged) await schedule();
      // Authorization is what the person was waiting for: tell them once, in
      // the chat they already messaged from. An offline bridge simply drops
      // it — the next thing they send will work anyway.
      for (const entry of result.authorized ?? []) {
        const group = store.group(entry.groupId);
        bridge?.notify(entry.id, authorizedNotice(group?.name ?? '默认分组'), 'authorized');
        journal.write({
          event: 'wecom.authorized', kind: entry.kind, chatId: entry.id, group: entry.groupId,
          notified: Boolean(bridge),
        });
      }
      // A move changes the group a person belongs to, so tell them where they
      // landed instead of leaving them to discover it from a different Session.
      for (const entry of result.assigned ?? []) {
        const group = store.group(entry.groupId);
        bridge?.notify(entry.id, groupAssignedNotice(group?.name ?? '默认分组'), 'group-assigned');
        journal.write({
          event: 'wecom.group.assigned', kind: entry.kind, chatId: entry.id,
          group: entry.groupId, previousGroup: entry.previousGroupId, notified: Boolean(bridge),
        });
      }
      // Promotion is a privilege change, not just another checkbox: the person
      // is told what they may now do, in the private chat those commands need.
      for (const id of result.promotedAdmins ?? []) {
        bridge?.notify(id, adminGrantedNotice(), 'admin');
        journal.write({ event: 'wecom.admin.granted', chatId: id, notified: Boolean(bridge) });
      }
      return result;
    },
    async state(stateOptions = {}) {
      const refresh = stateOptions.refresh === true;
      let sessions: BridgeStateView['sessions'] = null;
      let sessionsError: string | undefined;
      if (refresh) catalogs.invalidate();
      try {
        const catalog = await catalogs.load({ force: refresh });
        sessions = catalogView(catalog, store.bindings().map(record => record.sessionId).filter(Boolean));
        lastCatalogError = '';
      } catch (error) {
        sessionsError = '暂时无法读取 DSH Session 列表';
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastCatalogError) journal.write({ event: 'catalog.error', level: 'warn', error });
        lastCatalogError = message;
      }
      const settings = readBridgeSettings(config, store.settings());
      const stored = store.settings();
      let routing: RoutingView | null = null;
      let routingError: string | undefined;
      try {
        routing = await routingView({ refresh });
      } catch (error) {
        routingError = '暂时无法读取分组信息';
        journal.write({ event: 'binding.view.error', level: 'warn', error });
      }
      const { view: modelView, error: modelsError } = await modelsView(refresh);
      const { view: presetView, error: presetsError } = await presetsView(refresh);
      const notices: string[] = [];
      if (interactionTransport && !interactionTransport.ready()) {
        notices.push('企业微信交互通道暂不可用：请在 DSH 页面回答问题与审批，页面操作不受影响。');
      }
      const defaultGroup = routing?.groups.find(group => group.isDefault);
      if (defaultGroup?.workspaceError) notices.push(`默认分组的 Workspace 不可用：${defaultGroup.workspaceError}`);
      // Default states (every Workspace in scope, no member yet) are not
      // problems: the page's own sections say them where they apply.
      if (routing?.full) notices.push('成员数量已达上限，新成员不会被记录；请在下方清理。');
      return {
        version: STORE_VERSION,
        connection: status.connection(),
        traffic: status.traffic(),
        rejected: observations.rejected(key => Boolean(store.get(key))).map(row => {
          const note = store.label(row.key);
          return Object.freeze({ ...row, label: note, displayName: note || row.id });
        }),
        sessions,
        ...(sessionsError ? { sessionsError } : {}),
        routing,
        ...(routingError ? { routingError } : {}),
        models: modelView,
        ...(modelsError ? { modelsError } : {}),
        presets: presetView,
        ...(presetsError ? { presetsError } : {}),
        permissions: permissions.catalog(),
        workspaces: workspaces.list(),
        settings: stored,
        admins: settings.adminUserIds.map(id => {
          const key = `user:${id}`;
          const note = store.label(key);
          const binding = store.get(key);
          const group = binding ? store.group(binding.groupId) : undefined;
          return Object.freeze({
            id,
            label: note,
            displayName: note || id,
            ...(group ? { groupName: group.name } : {}),
          });
        }),
        notices,
        journal: journal.info(),
      };
    },
  };
}
