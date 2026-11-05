import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Conversation closing (borrowed from dsh-roost, which took it from SurfCore):
 * the persona can mark that a private chat has wound down, recording where it
 * stopped and how to pick it up next time. Closing sends nothing and changes no
 * memory; it only (1) gives the next turn a resume hint and (2) keeps proactive
 * chat quiet for a cool-down, so "good night" is not followed by a ping.
 *
 * Private chats only, and refused while the other side is still asking.
 */

export const CLOSING_TTL_MS = 7 * 86_400_000;
export const CLOSING_COOL_MS = 90 * 60_000;

export interface ClosingRecord {
  readonly point: string;
  readonly resume: string;
  readonly at: number;
}

/** Hard signals only: a question mark, or an explicit question or request word. */
export function looksLikeQuestion(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (/[?？]\s*$/.test(s)) return true;
  return /(怎么|为什么|为啥|能不能|可不可以|是不是|要不要|有没有|多少|几点|怎么办|请问|帮我|教我)/.test(s);
}

export interface ClosingStore {
  load(): Promise<void>;
  get(key: string, now: number): ClosingRecord | undefined;
  set(key: string, record: ClosingRecord): Promise<void>;
  clear(key: string): Promise<void>;
}

export function createClosingStore(options: { readonly file: string }): ClosingStore {
  let chats: Record<string, ClosingRecord> = {};
  const persist = async () => {
    await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
    const temp = options.file + '.' + process.pid + '.tmp';
    await writeFile(temp, JSON.stringify({ version: 1, chats }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temp, options.file);
    await chmod(options.file, 0o600).catch(() => {});
  };
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(options.file, 'utf8')) as { chats?: Record<string, ClosingRecord> };
        chats = parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {};
      } catch {
        chats = {};
      }
    },
    get(key, now) {
      const rec = chats[key];
      return rec && now - rec.at <= CLOSING_TTL_MS ? rec : undefined;
    },
    async set(key, record) {
      chats = { ...chats, [key]: record };
      const keys = Object.keys(chats);
      if (keys.length > 200) {
        const oldest = keys.sort((a, b) => chats[a]!.at - chats[b]!.at).slice(0, keys.length - 200);
        for (const k of oldest) delete chats[k];
      }
      await persist();
    },
    async clear(key) {
      if (!chats[key]) return;
      const next = { ...chats };
      delete next[key];
      chats = next;
      await persist();
    },
  };
}
