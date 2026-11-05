import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SoulMemoryStats, SoulSettings, SoulSettingsPatch } from '../../shared/protocol.js';
import { validBindingId } from '../store.js';
import {
  clampImportance, evict, FADED_RETENTION, importLegacyMarkdown, normalizeText, reinforce, retention,
  type MemoryEntry, type MemoryLayer,
} from './memory.js';
import { DEFAULT_PERSONA } from './persona.js';

/**
 * Persona, memory, reminder and proactive-chat storage, kept apart from the routing store.
 *
 *   soul/settings.json            switches, persona text, owners, scheduling knobs
 *   soul/memory/shared.json       memory every bound conversation reads (written only by the owner in private)
 *   soul/memory/chats/<key>.json  memory of one WeCom conversation
 *   soul/reminders.json           reminders the persona promised to deliver
 *   soul/proactive.json           today's proactive-chat counter and the last one sent
 *
 * Memory files hold MemoryEntry rows (see memory.ts). A legacy `.md` file from
 * v0.1 is imported once, on the first read of a scope without a `.json` file.
 * Nothing here is ever an instruction: the prompt says so, and secrets are
 * refused at write time.
 */

export const MAX_PERSONA_CHARS = 20_000;
export const MAX_OWNERS = 20;
export const MAX_ENTRY_CHARS = 500;
export const MAX_PENDING_REMINDERS = 50;
export const MAX_REMINDER_CHARS = 300;

export type MemoryScope = 'chat' | 'shared';

export interface Reminder {
  readonly id: string;
  /** Binding key of the conversation the reminder goes back to (`user:<id>` or `group:<id>`). */
  readonly bindingKey: string;
  readonly text: string;
  readonly dueAt: number;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly status: 'pending' | 'sent' | 'cancelled' | 'failed';
  readonly settledAt?: number;
}

export interface ProactiveState {
  /** Local date (YYYY-MM-DD) the counter belongs to. */
  readonly day: string;
  readonly count: number;
  /** Epoch ms of the last proactive chat, 0 when none. */
  readonly lastAt: number;
}

export function defaultSoulSettings(): SoulSettings {
  return {
    enabled: true, chatMode: true, memoryEnabled: true, workMode: false,
    persona: DEFAULT_PERSONA, ownerUserIds: [],
    halfLifeDays: 7,
    remindersEnabled: true,
    proactiveEnabled: false,
    proactiveIntervalMinutes: 60,
    proactiveChance: 0.3,
    quietStartHour: 23,
    quietEndHour: 8,
    proactiveDailyLimit: 3,
    proactiveCooldownMinutes: 180,
  };
}

/** Numeric settings: [min, max, integer]. */
const NUMBER_FIELDS = {
  halfLifeDays: [0.5, 365, false],
  proactiveIntervalMinutes: [5, 1440, true],
  proactiveChance: [0, 1, false],
  quietStartHour: [0, 23, true],
  quietEndHour: [0, 23, true],
  proactiveDailyLimit: [0, 50, true],
  proactiveCooldownMinutes: [0, 1440, true],
} as const satisfies Record<string, readonly [number, number, boolean]>;

type NumberField = keyof typeof NUMBER_FIELDS;
const BOOLEAN_FIELDS = ['enabled', 'chatMode', 'memoryEnabled', 'workMode', 'remindersEnabled', 'proactiveEnabled'] as const;
type BooleanField = typeof BOOLEAN_FIELDS[number];

function owners(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (validBindingId(id)) result.add(id);
  }
  return [...result].slice(0, MAX_OWNERS);
}

function clampNumber(field: NumberField, value: unknown, fallback: number): number {
  const [min, max, integer] = NUMBER_FIELDS[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const bounded = Math.min(max, Math.max(min, value));
  return integer ? Math.round(bounded) : bounded;
}

/** Re-type a hand-edited or missing file; never trusts its shape. */
export function normalizeSoulSettings(value: unknown): SoulSettings {
  const fallback = defaultSoulSettings();
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  const flag = (key: BooleanField) => (typeof raw[key] === 'boolean' ? raw[key] as boolean : fallback[key]);
  const num = (key: NumberField) => clampNumber(key, raw[key], fallback[key]);
  return {
    enabled: flag('enabled'),
    chatMode: flag('chatMode'),
    memoryEnabled: flag('memoryEnabled'),
    workMode: flag('workMode'),
    persona: typeof raw.persona === 'string' ? raw.persona.slice(0, MAX_PERSONA_CHARS) : fallback.persona,
    ownerUserIds: owners(raw.ownerUserIds),
    halfLifeDays: num('halfLifeDays'),
    remindersEnabled: flag('remindersEnabled'),
    proactiveEnabled: flag('proactiveEnabled'),
    proactiveIntervalMinutes: num('proactiveIntervalMinutes'),
    proactiveChance: num('proactiveChance'),
    quietStartHour: num('quietStartHour'),
    quietEndHour: num('quietEndHour'),
    proactiveDailyLimit: num('proactiveDailyLimit'),
    proactiveCooldownMinutes: num('proactiveCooldownMinutes'),
  };
}

/** Validate one page edit; an unknown field, a wrong type or an out-of-range number rejects the whole patch. */
export function validateSoulPatch(value: unknown): { ok: true; patch: SoulSettingsPatch } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '修改格式不正确。' };
  const raw = value as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(raw)) {
    if ((BOOLEAN_FIELDS as readonly string[]).includes(key)) {
      if (typeof item !== 'boolean') return { ok: false, error: `${key} 必须是开关值。` };
      patch[key] = item;
      continue;
    }
    if (Object.hasOwn(NUMBER_FIELDS, key)) {
      const [min, max, integer] = NUMBER_FIELDS[key as NumberField];
      if (typeof item !== 'number' || !Number.isFinite(item)) return { ok: false, error: `${key} 必须是数字。` };
      if (item < min || item > max) return { ok: false, error: `${key} 必须在 ${min} 到 ${max} 之间。` };
      if (integer && !Number.isInteger(item)) return { ok: false, error: `${key} 必须是整数。` };
      patch[key] = item;
      continue;
    }
    switch (key) {
      case 'persona':
        if (typeof item !== 'string') return { ok: false, error: '人设必须是文本。' };
        if (item.length > MAX_PERSONA_CHARS) return { ok: false, error: `人设最多 ${MAX_PERSONA_CHARS} 个字符。` };
        patch.persona = item;
        break;
      case 'ownerUserIds': {
        if (!Array.isArray(item)) return { ok: false, error: '主人列表格式不正确。' };
        const ids = item.map(id => (typeof id === 'string' ? id.trim() : ''));
        const bad = ids.find(id => !validBindingId(id));
        if (bad !== undefined) return { ok: false, error: `主人 userid 不合法：${bad || '（空）'}` };
        if (new Set(ids).size > MAX_OWNERS) return { ok: false, error: `最多 ${MAX_OWNERS} 个主人。` };
        patch.ownerUserIds = [...new Set(ids)];
        break;
      }
      default:
        return { ok: false, error: `未知字段：${key}` };
    }
  }
  return { ok: true, patch: patch as SoulSettingsPatch };
}

// Things that look like credentials are never remembered, whoever asks.
const SECRET_PATTERNS = [
  /\b(sk|pk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{12,}/i,
  /(password|passwd|secret|token|api[-_ ]?key|密码|口令|验证码|身份证)\s*[:：=是为]/i,
  /[A-Za-z0-9+/_-]{32,}/,
  /\b\d{15,19}\b/,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

export function memoryBaseName(scope: MemoryScope, bindingKey: string): string {
  if (scope === 'shared') return 'shared';
  return join('chats', bindingKey.replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120));
}

export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface RememberInput {
  readonly text: string;
  readonly layer: MemoryLayer;
  readonly importance: number;
  readonly by?: string;
}

export interface SoulStore {
  load(): Promise<void>;
  settings(): SoulSettings;
  update(patch: SoulSettingsPatch): Promise<SoulSettings>;
  /** Synchronous read for prompt rendering; [] when the scope has no memory. */
  entries(scope: MemoryScope, bindingKey: string): readonly MemoryEntry[];
  /** Add an entry, or reinforce an identical one (and promote it when asked for a higher layer or importance). */
  remember(scope: MemoryScope, bindingKey: string, input: RememberInput): Promise<{ entry: MemoryEntry; reinforced: boolean }>;
  /** Reinforce the given entries: a deliberate recall lengthens their half-life. */
  reinforce(scope: MemoryScope, bindingKey: string, ids: readonly string[]): Promise<number>;
  /** Remove every entry containing `match`; returns how many were removed. */
  forget(scope: MemoryScope, bindingKey: string, match: string): Promise<number>;
  reminders(): readonly Reminder[];
  addReminder(input: { bindingKey: string; text: string; dueAt: number; createdBy: string }): Promise<Reminder>;
  settleReminder(id: string, status: 'sent' | 'cancelled' | 'failed'): Promise<Reminder | undefined>;
  proactive(): ProactiveState;
  recordProactive(at: number): Promise<ProactiveState>;
  stats(): SoulMemoryStats;
}

export function createSoulStore(options: { readonly directory: string; readonly now?: () => number }): SoulStore {
  const root = options.directory;
  const settingsFile = join(root, 'settings.json');
  const memoryRoot = join(root, 'memory');
  const remindersFile = join(root, 'reminders.json');
  const proactiveFile = join(root, 'proactive.json');
  const now = options.now ?? Date.now;
  let current = defaultSoulSettings();
  let reminders: Reminder[] = [];
  let proactiveState: ProactiveState = { day: '', count: 0, lastAt: 0 };
  let loaded: Promise<void> | undefined;
  const cache = new Map<string, { mtimeMs: number; entries: MemoryEntry[] }>();
  let writes: Promise<unknown> = Promise.resolve();

  /** One write at a time: a remember and a forget must not interleave. */
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = writes.then(task, task);
    writes = run.catch(() => {});
    return run;
  }

  async function atomicWrite(file: string, text: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
    await chmod(file, 0o600).catch(() => {});
  }

  function sanitizeEntry(value: unknown): MemoryEntry | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const text = typeof raw.text === 'string' ? normalizeText(raw.text).slice(0, MAX_ENTRY_CHARS) : '';
    if (!text) return undefined;
    const at = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
    const createdAt = at(raw.createdAt, now());
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
      text,
      layer: raw.layer === 'core' ? 'core' : 'episodic',
      importance: clampImportance(raw.importance),
      createdAt,
      lastUsedAt: at(raw.lastUsedAt, createdAt),
      uses: Math.max(0, Math.floor(at(raw.uses, 0))),
      ...(typeof raw.by === 'string' && raw.by ? { by: raw.by } : {}),
    };
  }

  const jsonFile = (scope: MemoryScope, key: string) => join(memoryRoot, `${memoryBaseName(scope, key)}.json`);
  const legacyFile = (scope: MemoryScope, key: string) => join(memoryRoot, `${memoryBaseName(scope, key)}.md`);

  function readEntriesFile(file: string): MemoryEntry[] | undefined {
    try {
      const stat = statSync(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === stat.mtimeMs) return hit.entries;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown })?.entries;
      const entries = Array.isArray(list) ? list.map(sanitizeEntry).filter((e): e is MemoryEntry => Boolean(e)) : [];
      cache.set(file, { mtimeMs: stat.mtimeMs, entries });
      return entries;
    } catch {
      return undefined;
    }
  }

  /** Entries of one scope; a v0.1 Markdown file stands in until the first write migrates it. */
  function readScope(scope: MemoryScope, key: string): MemoryEntry[] {
    const fromJson = readEntriesFile(jsonFile(scope, key));
    if (fromJson) return fromJson;
    try {
      return importLegacyMarkdown(readFileSync(legacyFile(scope, key), 'utf8'), now(), randomUUID);
    } catch {
      return [];
    }
  }

  async function writeScope(scope: MemoryScope, key: string, entries: readonly MemoryEntry[]): Promise<void> {
    const file = jsonFile(scope, key);
    const kept = evict(entries, now(), current.halfLifeDays);
    await atomicWrite(file, `${JSON.stringify({ version: 1, entries: kept }, null, 2)}\n`);
    cache.delete(file);
  }

  async function writeReminders(): Promise<void> {
    // Settled reminders older than a week are history nobody reads.
    const cutoff = now() - 7 * 86_400_000;
    reminders = reminders.filter(r => r.status === 'pending' || (r.settledAt ?? r.dueAt) >= cutoff);
    await atomicWrite(remindersFile, `${JSON.stringify({ version: 1, reminders }, null, 2)}\n`);
  }

  function sanitizeReminder(value: unknown): Reminder | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== 'string' || typeof raw.bindingKey !== 'string' || typeof raw.text !== 'string') return undefined;
    if (typeof raw.dueAt !== 'number' || !Number.isFinite(raw.dueAt)) return undefined;
    const status = raw.status === 'sent' || raw.status === 'cancelled' || raw.status === 'failed' ? raw.status : 'pending';
    return {
      id: raw.id, bindingKey: raw.bindingKey, text: raw.text.slice(0, MAX_REMINDER_CHARS), dueAt: raw.dueAt,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : raw.dueAt,
      createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
      status,
      ...(typeof raw.settledAt === 'number' ? { settledAt: raw.settledAt } : {}),
    };
  }

  function allMemoryFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      let names: import('node:fs').Dirent[];
      try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of names) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
      }
    };
    walk(memoryRoot);
    return files;
  }

  return {
    load() {
      loaded ??= (async () => {
        try {
          current = normalizeSoulSettings(JSON.parse(await readFile(settingsFile, 'utf8')));
        } catch {
          current = defaultSoulSettings();
        }
        try {
          const parsed = JSON.parse(await readFile(remindersFile, 'utf8')) as { reminders?: unknown };
          reminders = Array.isArray(parsed.reminders)
            ? parsed.reminders.map(sanitizeReminder).filter((r): r is Reminder => Boolean(r)) : [];
        } catch {
          reminders = [];
        }
        try {
          const parsed = JSON.parse(await readFile(proactiveFile, 'utf8')) as Partial<ProactiveState>;
          proactiveState = {
            day: typeof parsed.day === 'string' ? parsed.day : '',
            count: typeof parsed.count === 'number' ? Math.max(0, Math.floor(parsed.count)) : 0,
            lastAt: typeof parsed.lastAt === 'number' ? parsed.lastAt : 0,
          };
        } catch {
          proactiveState = { day: '', count: 0, lastAt: 0 };
        }
      })();
      return loaded;
    },
    settings: () => current,
    update(patch) {
      return serialized(async () => {
        const next = normalizeSoulSettings({ ...current, ...patch });
        await atomicWrite(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
        current = next;
        return next;
      });
    },
    entries: (scope, key) => readScope(scope, key),
    remember(scope, key, input) {
      return serialized(async () => {
        const text = normalizeText(input.text).slice(0, MAX_ENTRY_CHARS);
        const entries = [...readScope(scope, key)];
        const at = now();
        const index = entries.findIndex(e => e.text === text);
        if (index >= 0) {
          const existing = entries[index]!;
          const promoted: MemoryEntry = {
            ...reinforce(existing, at),
            layer: existing.layer === 'core' || input.layer === 'core' ? 'core' : 'episodic',
            importance: Math.max(existing.importance, clampImportance(input.importance)),
          };
          entries[index] = promoted;
          await writeScope(scope, key, entries);
          return { entry: promoted, reinforced: true };
        }
        const entry: MemoryEntry = {
          id: randomUUID(), text, layer: input.layer, importance: clampImportance(input.importance),
          createdAt: at, lastUsedAt: at, uses: 0, ...(input.by ? { by: input.by } : {}),
        };
        entries.push(entry);
        await writeScope(scope, key, entries);
        return { entry, reinforced: false };
      });
    },
    reinforce(scope, key, ids) {
      return serialized(async () => {
        if (!ids.length) return 0;
        const wanted = new Set(ids);
        const at = now();
        let changed = 0;
        const entries = readScope(scope, key).map(e => {
          if (!wanted.has(e.id)) return e;
          changed++;
          return reinforce(e, at);
        });
        if (changed) await writeScope(scope, key, entries);
        return changed;
      });
    },
    forget(scope, key, match) {
      return serialized(async () => {
        const entries = readScope(scope, key);
        const kept = entries.filter(e => !e.text.includes(match));
        const removed = entries.length - kept.length;
        if (removed > 0) await writeScope(scope, key, kept);
        return removed;
      });
    },
    reminders: () => reminders,
    addReminder(input) {
      return serialized(async () => {
        if (reminders.filter(r => r.status === 'pending').length >= MAX_PENDING_REMINDERS) {
          throw new Error(`待发送的提醒已达上限（${MAX_PENDING_REMINDERS} 条），先取消一些。`);
        }
        const reminder: Reminder = {
          id: randomUUID().slice(0, 8), bindingKey: input.bindingKey,
          text: normalizeText(input.text).slice(0, MAX_REMINDER_CHARS),
          dueAt: input.dueAt, createdAt: now(), createdBy: input.createdBy, status: 'pending',
        };
        reminders = [...reminders, reminder];
        await writeReminders();
        return reminder;
      });
    },
    settleReminder(id, status) {
      return serialized(async () => {
        const index = reminders.findIndex(r => r.id === id && r.status === 'pending');
        if (index < 0) return undefined;
        const settled: Reminder = { ...reminders[index]!, status, settledAt: now() };
        reminders = reminders.map((r, i) => (i === index ? settled : r));
        await writeReminders();
        return settled;
      });
    },
    proactive: () => (proactiveState.day === localDay(now()) ? proactiveState : { day: localDay(now()), count: 0, lastAt: proactiveState.lastAt }),
    recordProactive(at) {
      return serialized(async () => {
        const day = localDay(at);
        proactiveState = { day, count: (proactiveState.day === day ? proactiveState.count : 0) + 1, lastAt: at };
        await atomicWrite(proactiveFile, `${JSON.stringify(proactiveState, null, 2)}\n`);
        return proactiveState;
      });
    },
    stats() {
      let core = 0;
      let episodic = 0;
      let faded = 0;
      const at = now();
      for (const file of allMemoryFiles()) {
        for (const entry of readEntriesFile(file) ?? []) {
          if (entry.layer === 'core') core++;
          else {
            episodic++;
            if (retention(entry, at, current.halfLifeDays) < FADED_RETENTION) faded++;
          }
        }
      }
      const shared = readScope('shared', '');
      const today = localDay(at);
      return {
        sharedEntries: shared.length,
        coreEntries: core,
        episodicEntries: episodic,
        fadedEntries: faded,
        pendingReminders: reminders.filter(r => r.status === 'pending').length,
        proactiveToday: proactiveState.day === today ? proactiveState.count : 0,
        directory: memoryRoot,
      };
    },
  };
}
