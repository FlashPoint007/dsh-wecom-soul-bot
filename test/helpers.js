// Shared fakes for the Host tests. They mirror only what the plugin uses.
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitize } from '../dist/host/journal.js';

export const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * Let pending async work land (the outbox's drain, a journal flush).
 *
 * Every round is a real event-loop turn plus one timer turn: `setImmediate`
 * alone keeps the loop turning without giving timers a chance, and work that is
 * queued behind them then never shows up in the assertions.
 */
export async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await tick();
  await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Wait for a condition that depends on real async work (a file read, a queue
 * drain).
 *
 * The budget is wall-clock, not a tick count: the same chain needs far more
 * turns on a loaded machine or a slower filesystem, and a tick-counted budget
 * spins through its whole allowance in a couple of milliseconds without ever
 * waiting for the work it is watching. `node --test` runs test files in
 * parallel, which is exactly that loaded machine.
 */
export async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return Boolean(predicate());
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

/** Journal that keeps sanitized records in memory, exactly as they would be written. */
export function memoryJournal(secrets = []) {
  const records = [];
  return {
    records,
    write(record) { records.push(sanitize(record, secrets)); },
    flush: async () => {},
    close: async () => {},
    info: () => ({ enabled: true, directory: '/tmp/wecom-soul-bot/logs', file: '/tmp/wecom-soul-bot/logs/today.jsonl', retentionDays: 14 }),
    find(event) { return records.filter(record => record.event === event); },
  };
}

export function fakeClient() {
  const sends = [];
  const replies = [];
  const client = Object.assign(new EventEmitter(), {
    sends, replies,
    connected: false,
    connect() { this.connected = true; return this; },
    disconnect() { this.connected = false; },
    async sendMessage(chat, body) { sends.push({ chat, body }); return { headers: { req_id: `send_${sends.length}` }, errcode: 0, errmsg: 'ok' }; },
    async replyStream(frame, streamId, content, finish) { replies.push({ frame, streamId, content, finish }); return { headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }; },
  });
  return client;
}

/** One workspace directory per test run; the routing store writes a real file. */
export const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wecom-soul-bot-test-')));
let scratchCounter = 0;
export function scratchDirectory() {
  return join(scratchRoot, `case-${++scratchCounter}`);
}

export const TEST_WORKSPACE_PATH = join(scratchRoot, 'workspace');

/** Catalog payload DSH's `sessionController.modelCatalog()` answers with. */
export const fakeModelCatalog = {
  default: { provider: 'deepseek-account', model: 'deepseek-chat' },
  routableProviders: ['deepseek-account'],
  groups: [
    {
      id: 'deepseek-account', name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' } },
      ],
    },
  ],
  failures: [],
};

export function fakeWorkspaceRegistry(workspaces = [], archived = [], pinned = []) {
  const rows = workspaces.map(workspace => ({ sessionIds: [], ...workspace }));
  const archivedCalls = [];
  return {
    rows,
    archivedCalls,
    async archiveSession(sessionId, options) {
      archivedCalls.push({ sessionId, options });
      if (!archived.includes(sessionId)) archived.push(sessionId);
    },
    list: () => rows,
    get: id => rows.find(row => row.id === id),
    async create(path, title) {
      const found = rows.find(row => row.path === path);
      if (found) return found;
      const created = { id: `w${rows.length + 1}`, path, title: title ?? path.split('/').pop(), sessionIds: [] };
      rows.push(created);
      return created;
    },
    async resolveByPath(path) { return rows.find(row => row.path === path); },
    archivedSessionIds: archived,
    pinnedSessionIds: pinned,
  };
}

/**
 * Host context with a Session list, an optional Workspace registry and
 * captured listeners. `sessions` rows follow sessionController.list; created
 * Sessions are appended (and attached to their Workspace) so the catalog sees
 * them exactly like the real registry would.
 *
 * `compactScope` mirrors where DSH actually mounts the compaction backend:
 * `'preset'` (the default, and what the web-app composition does) isolates it
 * inside the agent preset, so the host-level `ctx.get('compaction')` fails and
 * only `agentPresets.serviceFor(agent, 'compaction')` / `agent.ctx.get(...)`
 * reach it; `'host'` keeps the older host-plane layout, and `'none'` mounts no
 * backend at all. `sessionTitle: false` omits DSH's title service.
 * `permissionPresets: false` omits DSH's permission-preset service; `permissionError`
 * makes its `set` throw. Every `set(session, name)` lands in `ctx.permissionSets`
 * and, like DSH's `permissions` projection, in the Session row.
 */
export function fakeHost({
  sessions, workspaces, archived = [], pinned = [], defaultModel, compactResult, compactError,
  compactScope = 'preset', sessionTitle = true, permissionPresets = true, permissionError,
} = {}) {
  const handlers = new Map();
  const prompts = [];
  const cancels = [];
  const listCalls = [];
  const creates = [];
  const selections = [];
  const defaultSaves = [];
  const compactions = [];
  const agentResolutions = [];
  const renames = [];
  const liveAgents = new Map();
  const compacted = compactResult === undefined
    ? { compactionId: 'c1', summarySeq: 30, shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234 }
    : compactResult;
  let currentDefault = defaultModel ?? { provider: 'deepseek-account', model: 'deepseek-chat' };
  const rows = sessions ?? [
    { sessionId: 's1', updatedAt: 200, running: false, blank: false, cwd: '/w/alpha', projections: { values: { title: 'Alpha 任务' } } },
    { sessionId: 's2', updatedAt: 100, running: true, blank: false, cwd: '/w/beta', projections: { values: { title: 'Beta 任务' } } },
  ];
  const registry = workspaces === undefined ? undefined : fakeWorkspaceRegistry(workspaces, archived, pinned);
  const defaultModelService = {
    currentSelection: () => ({ ...currentDefault }),
    async saveSelection(next) { defaultSaves.push({ ...next }); currentDefault = { ...next }; },
  };
  const compactionService = {
    async compactNow(agent, signal) {
      compactions.push({ agent, aborted: signal.aborted });
      if (compactError) throw compactError;
      return compacted;
    },
  };
  const permissionSets = [];
  const permissionService = {
    catalog: () => ({ options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access' }] }),
    set(session, name) {
      if (permissionError) throw permissionError;
      permissionSets.push({ sessionId: session.id, name });
      const row = rows.find(item => item.sessionId === session.id);
      if (row) {
        row.projections ??= { values: {} };
        row.projections.values.permissions = { currentValue: name };
      }
    },
  };
  const titleService = {
    rename(session, title) { renames.push({ sessionId: session.id, title }); return { title }; },
  };
  // Every Session this fake creates is live, exactly like the real store's.
  const liveSessions = new Map();
  const sessionStore = { get: id => liveSessions.get(id) };
  // The Agent's own context: in the real composition this is where a
  // preset-owned and isolated `compaction` lives.
  const agentCtx = {
    get: name => (name === 'compaction' && compactScope !== 'none' ? compactionService : ctx.get(name)),
  };
  const ctx = {
    handlers, prompts, cancels, listCalls, creates, selections, defaultSaves, compactions,
    agentResolutions, renames, permissionSets, liveAgents, liveSessions, rows, registry, defaultModelService,
    on(name, fn) { handlers.set(name, fn); return () => { if (handlers.get(name) === fn) handlers.delete(name); }; },
    get(name) {
      if (name === 'workspaceRegistry') return registry;
      if (name === 'agentDefaultModel') return defaultModelService;
      if (name === 'agents') return { get: id => liveAgents.get(id) };
      if (name === 'sessions') return sessionStore;
      if (name === 'permissionPresets') return permissionPresets ? permissionService : undefined;
      if (name === 'sessionTitle') return sessionTitle === false ? undefined : titleService;
      if (name === 'agentPresets') {
        // The real registry reads a service out of the agent's mounted preset.
        return {
          serviceFor(agent, serviceName) {
            return serviceName === 'compaction' && compactScope === 'preset' ? agent.ctx?.get?.(serviceName) : undefined;
          },
          async list() { return []; },
          async resolve() { return { id: 'standard' }; },
        };
      }
      if (name === 'compaction') return compactScope === 'host' ? compactionService : undefined;
      return undefined;
    },
    sessionController: {
      async prompt(request) {
        prompts.push(request);
        const row = rows.find(item => item.sessionId === request.sessionId);
        if (row) row.blank = false;
        return { accepted: true };
      },
      cancel(request) { cancels.push(request); return { accepted: true }; },
      async list(request, signal) { listCalls.push({ request, signal }); return { items: rows }; },
      async create(request) {
        creates.push(request);
        const workspace = request.workspaceId ? registry?.get(request.workspaceId) : undefined;
        const cwd = workspace?.path ?? request.cwd;
        const sessionId = `session-created-${creates.length}`;
        rows.push({ sessionId, updatedAt: Date.now(), running: false, blank: true, cwd, projections: { values: { title: null } } });
        if (workspace) workspace.sessionIds.push(sessionId);
        // Created Sessions are live in the store, as DSH's own create leaves them.
        liveSessions.set(sessionId, { id: sessionId });
        return { sessionId };
      },
      async selectModel(request) {
        selections.push(request);
        const selected = {
          provider: request.provider, model: request.model,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        };
        // DSH records the selection as a durable projection; the plugin reads it back.
        const row = rows.find(item => item.sessionId === request.sessionId);
        if (row) {
          row.projections ??= { values: {} };
          row.projections.values.modelSelection = { lastUsed: null, pending: selected };
        }
        return { selected };
      },
      async modelCatalog() { return fakeModelCatalog; },
      async resolveAgent(sessionId) {
        agentResolutions.push(sessionId);
        // The Agent carries its own context: a preset-owned service (compaction)
        // is reachable only through it.
        const agent = { id: sessionId, session: { id: sessionId }, ctx: agentCtx };
        liveAgents.set(sessionId, agent);
        return { agent };
      },
    },
  };
  return ctx;
}

let counter = 0;
export function frame(content, { chat = 'alice', user = 'alice', id, bot = 'bot', msgtype = 'text', quote } = {}) {
  const msgid = id ?? `m${++counter}`;
  return {
    cmd: 'aibot_msg_callback',
    headers: { req_id: `req_${msgid}` },
    body: {
      msgid, aibotid: bot, msgtype,
      chattype: chat === user ? 'single' : 'group',
      ...(chat === user ? {} : { chatid: chat }),
      from: { userid: user },
      response_url: 'https://example.invalid/secret-callback',
      ...(msgtype === 'text' ? { text: { content } } : { image: { url: 'https://example.invalid/img', aeskey: 'k' } }),
      ...(quote !== undefined ? { quote: { msgtype: 'text', text: { content: quote } } } : {}),
    },
  };
}

/** A Session whose log ends with one finished turn. */
export function finishedSession(id, { turn = 1, text = '完成', reason = 'completed', promptIds = [] } = {}) {
  const events = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn } },
    ...promptIds.map((rpcId, index) => ({ type: 'user/message', seq: 2 + index, time: 1001, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', rpcId } } })),
    { type: 'request/header', seq: 10, time: 1002, data: { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'high' } } } },
    { type: 'step/start', seq: 11, time: 1003, data: { turn, step: 1 } },
    { type: 'tool/call', seq: 12, time: 1004, data: { turn, step: 1, name: 'bash' } },
    { type: 'assistant/message', seq: 13, time: 1005, data: { turn, step: 2, message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text }] } } },
  ];
  const end = { type: 'turn/end', seq: 20, time: 4000, data: { turn, reason: { kind: reason } } };
  events.push(end);
  return { session: { id, snapshotEvents: () => events }, end };
}

export const baseSettings = {
  botId: 'bot', secretRef: 'WECOM_SOUL_BOT_SECRET', wsUrl: '',
  adminUserIds: [], adminWorkspaces: [],
  questionTimeoutMs: 1000, remoteApprovals: false,
};

/** A routing store plus the standard services every Host test needs. */
export async function fakeRoutingStore(extra = {}) {
  const { createStore } = await import('../dist/host/store.js');
  return createStore({ directory: extra.directory ?? scratchDirectory(), onError: () => {}, ...extra });
}

/**
 * Seed the plugin's own store file in a throwaway DSH home.
 *
 * The Host never migrates or invents this document, so a test that wants the
 * deployment "configured" with something writes it here, before the runtime
 * reads it. Everything omitted keeps the store's documented default.
 */
export async function writeStore(home, document = {}) {
  const directory = join(home, 'wecom-soul-bot');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    version: '0.5', settings: {}, groups: [], bindings: [], labels: {}, adminDefaults: {}, ...document,
  }, undefined, 2));
}
