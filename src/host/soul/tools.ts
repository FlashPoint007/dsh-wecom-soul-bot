import type { BindingRecord } from '../../shared/protocol.js';
import type { Journal } from '../journal.js';
import { normalizeText, searchEntries, type MemoryLayer } from './memory.js';
import { formatLocal, parseDueAt } from './rules.js';
import { looksSecret, MAX_ENTRY_CHARS, MAX_REMINDER_CHARS, type MemoryScope, type SoulStore } from './store.js';

/** Pending reminders one conversation may hold. */
export const MAX_REMINDERS_PER_CHAT = 10;

export interface ToolSender {
  readonly user: string;
  readonly chat: string;
  readonly chatType: 'single' | 'group';
}

export interface ToolContext {
  readonly store: SoulStore;
  readonly journal: Pick<Journal, 'write'>;
  readonly now: () => number;
  bindingFor(sessionId: string | undefined): BindingRecord | undefined;
  /** The sender of the prompt currently being answered in this Session. */
  senderOf(sessionId: string): ToolSender | undefined;
  isOwner(user: string): boolean;
}

type Exec = { agent?: { id?: string; session?: { id?: string } } } | undefined;

export function bindingKeyOf(binding: Pick<BindingRecord, 'kind' | 'id'>): string {
  return binding.kind + ':' + binding.id;
}

/** Build the memory and reminder tool definitions; define is the defineTool of dsh-tools. */
export function buildSoulTools(define: (options: unknown) => unknown, tc: ToolContext): unknown[] {
  const target = (exec: Exec, needMemory: boolean) => {
    if (needMemory && !tc.store.settings().memoryEnabled) throw new Error('记忆功能已在插件页关闭。');
    const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
    const binding = tc.bindingFor(sessionId);
    if (!sessionId || !binding) throw new Error('这个工具只在企业微信机器人的会话里可用。');
    return { sessionId, binding, key: bindingKeyOf(binding) };
  };
  const scopeOf = (value: unknown): MemoryScope => (value === 'shared' ? 'shared' : 'chat');
  const layerOf = (value: unknown): MemoryLayer => (value === 'core' ? 'core' : 'episodic');
  const ownerSpeaking = (sessionId: string) => {
    const sender = tc.senderOf(sessionId);
    return Boolean(sender && tc.isOwner(sender.user));
  };
  const requireSharedWriter = (sessionId: string) => {
    const sender = tc.senderOf(sessionId);
    if (!sender || sender.chatType !== 'single' || !tc.isOwner(sender.user)) {
      throw new Error('共享记忆只能在主人私聊时写入；这件事请用 scope="chat" 记在当前会话。');
    }
  };

  const remember = define({
    name: 'wecom_memory_remember',
    description: '企业微信机器人专用：把一件值得长期记住的事记进记忆（一句话一条）。layer="core" 是不会忘的核心记忆（称呼、喜好、身份、长期约定），只有主人能写；layer="episodic"（默认）是会随时间淡忘的近期记忆，importance 1-5 越大忘得越慢。记一件已经记过的事会强化它。scope="chat"（默认）只在当前私聊或群可见；scope="shared" 所有会话可见，只能在主人私聊时写。拒绝记录密码、验证码、密钥等敏感信息。',
    parameters: {
      content: { type: 'string', required: true, description: '要记住的一件事，一句话，最多 500 字。写清楚是谁的事，例如「主人爱喝冰美式」。' },
      layer: { type: 'string', description: 'core 或 episodic（默认）。' },
      importance: { type: 'integer', description: '1-5，默认 3。' },
      scope: { type: 'string', description: 'chat（默认）或 shared。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        scope: { type: 'string' }, layer: { type: 'string' }, importance: { type: 'integer' }, reinforced: { type: 'boolean' },
      } },
      render: (_a: unknown, v: { scope: string; layer: string; importance: number; reinforced: boolean }) => [{
        type: 'text', text: (v.reinforced ? '已强化' : '已记入') + ' ' + v.scope + ' 的' + (v.layer === 'core' ? '核心' : '近期') + '记忆（重要度 ' + v.importance + '）。',
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { content?: unknown; layer?: unknown; importance?: unknown; scope?: unknown }, exec: Exec) {
      const { sessionId, key } = target(exec, true);
      const scope = scopeOf(args.scope);
      const layer = layerOf(args.layer);
      const content = normalizeText(String(args.content ?? ''));
      if (!content) throw new Error('content 不能为空。');
      if (content.length > MAX_ENTRY_CHARS) throw new Error('一条记忆最多 ' + MAX_ENTRY_CHARS + ' 字，请拆短。');
      if (looksSecret(content)) throw new Error('这条内容像是密码或密钥，不能记。');
      if (scope === 'shared') requireSharedWriter(sessionId);
      if (layer === 'core' && !ownerSpeaking(sessionId)) throw new Error('核心记忆只有主人能写；这件事请用 layer="episodic" 记。');
      const by = tc.senderOf(sessionId)?.user;
      const importance = typeof args.importance === 'number' ? args.importance : 3;
      const result = await tc.store.remember(scope, key, { text: content, layer, importance, ...(by ? { by } : {}) });
      tc.journal.write({ event: 'soul.memory.remember', sessionId, binding: key, scope, layer, reinforced: result.reinforced });
      return { scope, layer: result.entry.layer, importance: result.entry.importance, reinforced: result.reinforced };
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: '记住一件事', kind: 'other', rawInput: args }),
  });

  const recall = define({
    name: 'wecom_memory_recall',
    description: '企业微信机器人专用：按关键词回忆长期记忆，连已经淡忘、不在上下文里的记忆也能找回来。被找回的记忆会被强化（忘得更慢）。在当前会话记忆和共享记忆里一起找。',
    parameters: {
      query: { type: 'string', required: true, description: '要回忆的关键词或一句话，例如「主人的生日」。' },
      limit: { type: 'integer', description: '最多返回几条，1-10，默认 5。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        matches: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          text: { type: 'string' }, scope: { type: 'string' }, layer: { type: 'string' }, clarity: { type: 'integer' }, date: { type: 'string' },
        } } },
      } },
      render: (_a: unknown, v: { matches: { text: string; scope: string; layer: string; clarity: number; date: string }[] }) => [{
        type: 'text',
        text: v.matches.length
          ? v.matches.map(m => '- ' + m.text + '（' + m.scope + '，' + (m.layer === 'core' ? '核心' : '清晰度 ' + m.clarity + '%') + '，' + m.date + '）').join('\n')
          : '没想起来相关的记忆。',
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { query?: unknown; limit?: unknown }, exec: Exec) {
      const { sessionId, key } = target(exec, true);
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query 不能为空。');
      const limit = Math.min(10, Math.max(1, typeof args.limit === 'number' ? Math.round(args.limit) : 5));
      const now = tc.now();
      const half = tc.store.settings().halfLifeDays;
      const hits = (['chat', 'shared'] as const).flatMap(scope =>
        searchEntries(tc.store.entries(scope, key), query, now, half, limit).map(hit => ({ ...hit, scope })));
      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, limit);
      for (const scope of ['chat', 'shared'] as const) {
        const ids = top.filter(h => h.scope === scope).map(h => h.entry.id);
        if (ids.length) await tc.store.reinforce(scope, key, ids);
      }
      tc.journal.write({ event: 'soul.memory.recall', sessionId, binding: key, hits: top.length });
      return { matches: top.map(h => ({
        text: h.entry.text, scope: h.scope, layer: h.entry.layer,
        clarity: Math.round(h.retention * 100), date: formatLocal(h.entry.createdAt).slice(0, 10),
      })) };
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: '回忆一下', kind: 'other', rawInput: args }),
  });

  const forget = define({
    name: 'wecom_memory_forget',
    description: '企业微信机器人专用：删除记忆里包含指定文字的条目（过时或记错的）。scope 同 wecom_memory_remember；删除共享记忆同样只能在主人私聊时进行。',
    parameters: {
      match: { type: 'string', required: true, description: '要删除的条目里包含的一段文字，至少 2 个字。' },
      scope: { type: 'string', description: 'chat（默认）或 shared。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string' }, removed: { type: 'integer' } } },
      render: (_a: unknown, v: { scope: string; removed: number }) => [{ type: 'text', text: '从 ' + v.scope + ' 记忆删除了 ' + v.removed + ' 条。' }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { match?: unknown; scope?: unknown }, exec: Exec) {
      const { sessionId, key } = target(exec, true);
      const scope = scopeOf(args.scope);
      const match = String(args.match ?? '').trim();
      if (match.length < 2) throw new Error('match 至少 2 个字，避免误删。');
      if (scope === 'shared') requireSharedWriter(sessionId);
      const removed = await tc.store.forget(scope, key, match);
      tc.journal.write({ event: 'soul.memory.forget', sessionId, binding: key, scope, removed });
      return { scope, removed };
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: '删除一条记忆', kind: 'other', rawInput: args }),
  });

  const reminderTarget = (exec: Exec) => {
    if (!tc.store.settings().remindersEnabled) throw new Error('提醒功能已在插件页关闭。');
    return target(exec, false);
  };

  const setReminder = define({
    name: 'wecom_reminder_set',
    description: '企业微信机器人专用：定一个提醒，到点插件会让你用自己的口吻在当前这个私聊或群里提醒对方。时间二选一：in_minutes（多少分钟后），或 at（主人电脑的本地时间 "YYYY-MM-DD HH:mm" 或 "HH:mm"，"HH:mm" 已过就算明天）。最多提前一年；每个会话最多 10 条待发提醒。',
    parameters: {
      text: { type: 'string', required: true, description: '到点要提醒的事，一句话，最多 300 字，例如「下午三点的面试」。' },
      at: { type: 'string', description: '本地时间 "YYYY-MM-DD HH:mm" 或 "HH:mm"。' },
      in_minutes: { type: 'integer', description: '多少分钟后提醒，至少 1。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, due: { type: 'string' } } },
      render: (_a: unknown, v: { id: string; due: string }) => [{ type: 'text', text: '已定提醒 ' + v.id + '，会在 ' + v.due + '（本地时间）发出。' }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { text?: unknown; at?: unknown; in_minutes?: unknown }, exec: Exec) {
      const { sessionId, key } = reminderTarget(exec);
      const text = normalizeText(String(args.text ?? ''));
      if (!text) throw new Error('text 不能为空。');
      if (text.length > MAX_REMINDER_CHARS) throw new Error('提醒内容最多 ' + MAX_REMINDER_CHARS + ' 字。');
      if (looksSecret(text)) throw new Error('提醒内容像是密码或密钥，不能定。');
      const pending = tc.store.reminders().filter(r => r.status === 'pending' && r.bindingKey === key).length;
      if (pending >= MAX_REMINDERS_PER_CHAT) throw new Error('这个会话已经有 ' + MAX_REMINDERS_PER_CHAT + ' 条待发提醒了，先取消一些。');
      const dueAt = parseDueAt({ at: args.at, in_minutes: args.in_minutes }, tc.now());
      const reminder = await tc.store.addReminder({ bindingKey: key, text, dueAt, createdBy: tc.senderOf(sessionId)?.user ?? '' });
      tc.journal.write({ event: 'soul.reminder.set', sessionId, binding: key, id: reminder.id, dueAt });
      return { id: reminder.id, due: formatLocal(dueAt) };
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: '定一个提醒', kind: 'other', rawInput: args }),
  });

  const listReminders = define({
    name: 'wecom_reminder_list',
    description: '企业微信机器人专用：列出当前这个私聊或群里还没发出的提醒。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        reminders: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string' }, text: { type: 'string' }, due: { type: 'string' },
        } } },
      } },
      render: (_a: unknown, v: { reminders: { id: string; text: string; due: string }[] }) => [{
        type: 'text', text: v.reminders.length ? v.reminders.map(r => '- ' + r.id + ' ' + r.due + ' ' + r.text).join('\n') : '没有待发的提醒。',
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args: unknown, exec: Exec) {
      const { key } = reminderTarget(exec);
      const reminders = tc.store.reminders().filter(r => r.status === 'pending' && r.bindingKey === key)
        .sort((a, b) => a.dueAt - b.dueAt)
        .map(r => ({ id: r.id, text: r.text, due: formatLocal(r.dueAt) }));
      return { reminders };
    },
  });

  const cancelReminder = define({
    name: 'wecom_reminder_cancel',
    description: '企业微信机器人专用：取消当前这个私聊或群里的一条提醒（id 来自 wecom_reminder_list）。',
    parameters: { id: { type: 'string', required: true, description: '提醒 id。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, cancelled: { type: 'boolean' } } },
      render: (_a: unknown, v: { id: string; cancelled: boolean }) => [{ type: 'text', text: v.cancelled ? '已取消提醒 ' + v.id + '。' : '没找到待发的提醒 ' + v.id + '。' }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { id?: unknown }, exec: Exec) {
      const { sessionId, key } = reminderTarget(exec);
      const id = String(args.id ?? '').trim();
      const owned = tc.store.reminders().find(r => r.id === id && r.status === 'pending' && r.bindingKey === key);
      if (!owned) return { id, cancelled: false };
      await tc.store.settleReminder(id, 'cancelled');
      tc.journal.write({ event: 'soul.reminder.cancel', sessionId, binding: key, id });
      return { id, cancelled: true };
    },
  });

  return [remember, recall, forget, setReminder, listReminders, cancelReminder];
}
