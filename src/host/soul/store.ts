import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SoulMemoryStats, SoulSettings, SoulSettingsPatch } from '../../shared/protocol.js';
import { validBindingId } from '../store.js';
import { DEFAULT_PERSONA } from './persona.js';

/**
 * Persona and memory storage, kept apart from the routing store.
 *
 * `<plugin home>/soul/settings.json` holds the persona switches, the persona
 * text and the owner list. Memory is plain Markdown, one entry per line:
 * `soul/memory/shared.md` (read in every bound conversation, written only
 * when the owner is speaking) and `soul/memory/chats/<kind>-<id>.md` (one per
 * WeCom conversation, read and written only there). Nothing here is ever an
 * instruction: the prompt says so, and secrets are refused at write time.
 */

export const MAX_PERSONA_CHARS = 20_000;
export const MAX_OWNERS = 20;
export const MAX_ENTRY_CHARS = 500;
export const MAX_MEMORY_FILE_CHARS = 16_000;

export type MemoryScope = 'chat' | 'shared';

export function defaultSoulSettings(): SoulSettings {
  return { enabled: true, chatMode: true, memoryEnabled: true, workMode: false, persona: DEFAULT_PERSONA, ownerUserIds: [] };
}

function owners(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (validBindingId(id)) result.add(id);
  }
  return [...result].slice(0, MAX_OWNERS);
}

/** Re-type a hand-edited or missing file; never trusts its shape. */
export function normalizeSoulSettings(value: unknown): SoulSettings {
  const fallback = defaultSoulSettings();
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  const flag = (key: keyof SoulSettings, def: boolean) => (typeof raw[key] === 'boolean' ? raw[key] as boolean : def);
  return {
    enabled: flag('enabled', fallback.enabled),
    chatMode: flag('chatMode', fallback.chatMode),
    memoryEnabled: flag('memoryEnabled', fallback.memoryEnabled),
    workMode: flag('workMode', fallback.workMode),
    persona: typeof raw.persona === 'string' ? raw.persona.slice(0, MAX_PERSONA_CHARS) : fallback.persona,
    ownerUserIds: owners(raw.ownerUserIds),
  };
}

/** Validate one page edit; an unknown field or a wrong type rejects the whole patch. */
export function validateSoulPatch(value: unknown): { ok: true; patch: SoulSettingsPatch } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '修改格式不正确。' };
  const raw = value as Record<string, unknown>;
  const patch: { -readonly [K in keyof SoulSettingsPatch]: SoulSettingsPatch[K] } = {};
  for (const [key, item] of Object.entries(raw)) {
    switch (key) {
      case 'enabled': case 'chatMode': case 'memoryEnabled': case 'workMode':
        if (typeof item !== 'boolean') return { ok: false, error: `${key} 必须是开关值。` };
        patch[key] = item;
        break;
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
  return { ok: true, patch };
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

export function memoryFileName(scope: MemoryScope, bindingKey: string): string {
  if (scope === 'shared') return 'shared.md';
  return join('chats', `${bindingKey.replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120)}.md`);
}

export interface SoulStore {
  load(): Promise<void>;
  settings(): SoulSettings;
  update(patch: SoulSettingsPatch): Promise<SoulSettings>;
  /** Synchronous read for prompt rendering; '' when the file is missing. */
  readMemory(scope: MemoryScope, bindingKey: string): string;
  /** Append one entry; returns the file length after the write. */
  appendMemory(scope: MemoryScope, bindingKey: string, entry: string): Promise<number>;
  /** Remove every entry containing `match`; returns how many were removed. */
  forgetMemory(scope: MemoryScope, bindingKey: string, match: string): Promise<number>;
  stats(): SoulMemoryStats;
}

export function createSoulStore(options: { readonly directory: string; readonly now?: () => Date }): SoulStore {
  const root = options.directory;
  const settingsFile = join(root, 'settings.json');
  const memoryRoot = join(root, 'memory');
  const now = options.now ?? (() => new Date());
  let current = defaultSoulSettings();
  let loaded: Promise<void> | undefined;
  const cache = new Map<string, { mtimeMs: number; text: string }>();
  let writes: Promise<unknown> = Promise.resolve();

  /** One write at a time: a remember and a forget must not interleave. */
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = writes.then(task, task);
    writes = run.catch(() => {});
    return run;
  }

  async function atomicWrite(file: string, text: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
    await chmod(file, 0o600).catch(() => {});
  }

  function readSync(file: string): string {
    try {
      const stat = statSync(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === stat.mtimeMs) return hit.text;
      const text = readFileSync(file, 'utf8');
      cache.set(file, { mtimeMs: stat.mtimeMs, text });
      return text;
    } catch {
      return '';
    }
  }

  const fileOf = (scope: MemoryScope, key: string) => join(memoryRoot, memoryFileName(scope, key));

  return {
    load() {
      loaded ??= (async () => {
        try {
          current = normalizeSoulSettings(JSON.parse(await readFile(settingsFile, 'utf8')));
        } catch {
          current = defaultSoulSettings();
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
    readMemory: (scope, key) => readSync(fileOf(scope, key)),
    appendMemory(scope, key, entry) {
      return serialized(async () => {
        const file = fileOf(scope, key);
        const existing = readSync(file);
        const d = now();
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const line = `- ${entry.replace(/\s+/g, ' ').trim()} [${stamp}]`;
        const next = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`;
        if (next.length > MAX_MEMORY_FILE_CHARS) {
          throw new Error(`记忆已满（上限 ${MAX_MEMORY_FILE_CHARS} 字符），先用 wecom_memory_forget 删掉过时的条目。`);
        }
        await atomicWrite(file, next);
        cache.delete(file);
        return next.length;
      });
    },
    forgetMemory(scope, key, match) {
      return serialized(async () => {
        const file = fileOf(scope, key);
        const lines = readSync(file).split('\n');
        const kept = lines.filter(line => !line.includes(match));
        const removed = lines.length - kept.length;
        if (removed > 0) {
          await atomicWrite(file, kept.join('\n'));
          cache.delete(file);
        }
        return removed;
      });
    },
    stats() {
      const shared = readSync(join(memoryRoot, 'shared.md'));
      return { sharedEntries: shared.split('\n').filter(line => line.startsWith('- ')).length, directory: memoryRoot };
    },
  };
}
