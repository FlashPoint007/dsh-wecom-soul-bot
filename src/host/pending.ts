import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SessionEvent } from './dsh.js';

/**
 * Prompts submitted to DSH whose reply has not reached WeCom yet, kept on disk.
 *
 * A turn that ends while the plugin is stopped (a restart, a DSH reload) used to
 * lose its reply: the in-memory round tracker was gone. On start the runtime
 * reads each pending prompt back from its Session log; a completed turn that
 * consumed it is delivered late, once, and the entry is dropped either way.
 */

export interface PendingPrompt {
  readonly requestId: string;
  readonly sessionId: string;
  /** WeCom chat the reply belongs to (userid or chatid). */
  readonly chat: string;
  readonly at: number;
}

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 500;

export interface PendingLedger {
  load(): Promise<void>;
  add(entry: PendingPrompt): Promise<void>;
  remove(requestIds: readonly string[]): Promise<void>;
  entries(): readonly PendingPrompt[];
}

export function createPendingLedger(options: { readonly file: string; readonly now?: () => number }): PendingLedger {
  const now = options.now ?? Date.now;
  let items: PendingPrompt[] = [];
  let writes: Promise<unknown> = Promise.resolve();
  const persist = () => {
    const run = writes.then(async () => {
      await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
      const temp = options.file + '.' + process.pid + '.tmp';
      await writeFile(temp, JSON.stringify({ version: 1, pending: items }) + '\n', { encoding: 'utf8', mode: 0o600 });
      await rename(temp, options.file);
      await chmod(options.file, 0o600).catch(() => {});
    });
    writes = run.catch(() => {});
    return run;
  };
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(options.file, 'utf8')) as { pending?: unknown };
        const cutoff = now() - PENDING_TTL_MS;
        items = (Array.isArray(parsed.pending) ? parsed.pending : []).filter((p): p is PendingPrompt => {
          const r = p as Partial<PendingPrompt> | null;
          return Boolean(r) && typeof r!.requestId === 'string' && typeof r!.sessionId === 'string'
            && typeof r!.chat === 'string' && typeof r!.at === 'number' && r!.at >= cutoff;
        });
      } catch {
        items = [];
      }
    },
    async add(entry) {
      items = [...items.filter(p => p.requestId !== entry.requestId), entry].slice(-MAX_PENDING);
      await persist();
    },
    async remove(requestIds) {
      if (!requestIds.length) return;
      const drop = new Set(requestIds);
      const next = items.filter(p => !drop.has(p.requestId));
      if (next.length === items.length) return;
      items = next;
      await persist();
    },
    entries: () => items,
  };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n').trim();
}

/**
 * What a Session log says about one prompt: still running, finished with a
 * final answer, finished without one, or not consumed at all.
 */
export function outcomeOf(events: readonly SessionEvent[], requestId: string):
  | { readonly state: 'running' | 'unconsumed' }
  | { readonly state: 'ended'; readonly reason: string; readonly text: string } {
  let turn: number | undefined;
  let last = '';
  for (const event of events) {
    const data = event.data;
    if (turn === undefined) {
      if (event.type === 'user/message' && data?.source?.rpcId === requestId) turn = typeof data.turn === 'number' ? data.turn : -1;
      continue;
    }
    if (event.type === 'assistant/message' && (turn < 0 || data?.turn === turn)) {
      const text = textOf(data?.message?.content);
      if (text) last = text;
    } else if (event.type === 'turn/end' && (turn < 0 || data?.turn === turn)) {
      return { state: 'ended', reason: data?.reason?.kind ?? 'unknown', text: last };
    }
  }
  return { state: turn === undefined ? 'unconsumed' : 'running' };
}
