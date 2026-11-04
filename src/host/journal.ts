import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PLUGIN_HOME_DIRECTORY, type JournalInfo } from '../shared/protocol.js';

/**
 * Append-only JSONL journal under `<DSH home>/wecom-soul-bot/logs/YYYY-MM-DD.jsonl`.
 *
 * Every line is one self-describing JSON object:
 *   { ts, seq, level, event, ...fields }
 * Writes are serialized, never block the caller, and never throw into the
 * bridge. Values pass through {@link sanitize} first, so credentials, reply
 * URLs and media keys never reach the disk.
 */

export type JournalLevel = 'debug' | 'info' | 'warn' | 'error';

export interface JournalRecord {
  readonly event: string;
  readonly level?: JournalLevel;
  readonly [field: string]: unknown;
}

export interface Journal {
  write(record: JournalRecord): void;
  /** Resolves once every record written so far reached the file system. */
  flush(): Promise<void>;
  close(): Promise<void>;
  info(): JournalInfo;
}

export interface JournalOptions {
  readonly directory: string;
  enabled(): boolean;
  retentionDays(): number;
  /** Strings to scrub from every value (for example the resolved Bot Secret). */
  secrets?(): readonly string[];
  now?(): Date;
  onError?(error: unknown): void;
}

/** Resolve the DSH home the same way DSH does: `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim();
  if (!configured) return join(homedir(), '.dsh');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

export function pluginHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), PLUGIN_HOME_DIRECTORY);
}

export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const SENSITIVE_KEY = /^(secret|bot_?secret|secret_?value|token|access_?token|password|passwd|authorization|cookie|aeskey|aes_?key|response_?url)$/i;
const URL_KEY = /^(url|download_?url|media_?url)$/i;
const MAX_STRING = 32_000;
const MAX_ARRAY = 200;
const MAX_DEPTH = 10;

function scrub(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) if (secret.length >= 6) result = result.split(secret).join('[redacted]');
  return result.length > MAX_STRING ? `${result.slice(0, MAX_STRING)}…[truncated ${result.length - MAX_STRING} chars]` : result;
}

/** JSON-safe, redacted, size-bounded copy of an arbitrary value. */
export function sanitize(value: unknown, secrets: readonly string[] = [], depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrub(value, secrets);
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { name: value.name, message: scrub(value.message, secrets), ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}) };
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY).map(item => sanitize(item, secrets, depth + 1, seen));
      if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more]`);
      return items;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) { result[key] = '[redacted]'; continue; }
      if (URL_KEY.test(key) && typeof item === 'string') { result[key] = '[redacted-url]'; continue; }
      const clean = sanitize(item, secrets, depth + 1, seen);
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function createJournal(options: JournalOptions): Journal {
  const now = options.now ?? (() => new Date());
  let seq = 0;
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let dropped = 0;
  let closed = false;
  let directoryReady = false;
  /**
   * The day and retention a prune last ran with. Both parts matter: a retention
   * edit on ⑤连接与日志 must be honored by the next write, not by tomorrow's first
   * write or a plugin restart, so it becomes a new prune key instead of being
   * hidden behind "today was already pruned".
   */
  let prunedFor = '';
  let lastErrorAt = 0;

  function report(error: unknown): void {
    const at = Date.now();
    if (at - lastErrorAt < 60_000) return;
    lastErrorAt = at;
    try { options.onError?.(error); } catch { /* a reporter must never break logging */ }
  }

  async function prune(today: string): Promise<void> {
    const keepDays = Math.max(1, options.retentionDays());
    const key = `${today}:${keepDays}`;
    if (prunedFor === key) return;
    prunedFor = key;
    const cutoff = new Date(`${today}T00:00:00`);
    cutoff.setDate(cutoff.getDate() - keepDays + 1);
    const oldest = localDate(cutoff);
    for (const name of await readdir(options.directory)) {
      const match = FILE_PATTERN.exec(name);
      if (match && match[1]! < oldest) await unlink(join(options.directory, name)).catch(report);
    }
  }

  function fileFor(date: Date): string {
    return join(options.directory, `${localDate(date)}.jsonl`);
  }

  function write(record: JournalRecord): void {
    if (closed || !options.enabled()) return;
    if (pending >= 5000) { dropped++; return; }
    const at = now();
    const { event, level = 'info', ...fields } = record;
    let line: string;
    try {
      const secrets = options.secrets?.() ?? [];
      const body = sanitize(fields, secrets) as Record<string, unknown>;
      line = JSON.stringify({
        ts: at.toISOString(), seq: ++seq, level, event,
        ...(dropped ? { droppedBefore: dropped } : {}),
        ...body,
      });
      dropped = 0;
    } catch (error) {
      report(error);
      return;
    }
    pending++;
    chain = chain.then(async () => {
      try {
        if (!directoryReady) {
          await mkdir(options.directory, { recursive: true, mode: 0o700 });
          directoryReady = true;
        }
        await prune(localDate(at)).catch(report);
        await appendFile(fileFor(at), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        directoryReady = false;
        report(error);
      } finally {
        pending--;
      }
    });
  }

  return {
    write,
    flush: () => chain,
    async close() {
      closed = true;
      await chain;
    },
    info: () => ({
      enabled: options.enabled(),
      directory: options.directory,
      file: fileFor(now()),
      retentionDays: options.retentionDays(),
    }),
  };
}

/** A journal that records nothing; the default for unit tests. */
export const nullJournal: Journal = {
  write() {},
  flush: async () => {},
  close: async () => {},
  info: () => ({ enabled: false, directory: '', file: '', retentionDays: 0 }),
};
