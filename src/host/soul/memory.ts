/**
 * Three-layer memory with a forgetting curve.
 *
 *   working   the DSH Session context itself (compacted by DSH; not stored here)
 *   episodic  dated notes that fade: retention = 0.5 ^ (days since last use / effective half-life)
 *   core      stable facts (names, preferences, promises) that never fade
 *
 * The effective half-life grows with importance and with every deliberate recall
 * (spaced repetition): a note the persona keeps coming back to lasts longer, one
 * nobody needs fades out. Being injected into the prompt is NOT a use, otherwise
 * nothing would ever fade. A faded note (retention below FADED_RETENTION) is no
 * longer injected but stays on disk and can still be found by an explicit recall.
 */

export type MemoryLayer = 'core' | 'episodic';

export interface MemoryEntry {
  readonly id: string;
  readonly text: string;
  readonly layer: MemoryLayer;
  /** 1 (trivia) .. 5 (must not forget). */
  readonly importance: number;
  readonly createdAt: number;
  /** Last deliberate use (creation, recall, or a duplicate remember). */
  readonly lastUsedAt: number;
  readonly uses: number;
  /** WeCom userid that asked for it, when known. */
  readonly by?: string;
}

export const FADED_RETENTION = 0.05;
export const MAX_ENTRIES_PER_FILE = 300;
const DAY_MS = 86_400_000;

export function clampImportance(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 3;
  return Math.min(5, Math.max(1, n));
}

/** Effective half-life in days for one entry. */
export function halfLifeDays(entry: Pick<MemoryEntry, 'importance' | 'uses'>, baseDays: number): number {
  // importance 3 keeps the base half-life; 1 shortens it to 2/3, 5 stretches it to 4/3.
  const importanceFactor = 0.5 + clampImportance(entry.importance) / 6;
  const repetitionFactor = 1 + Math.min(entry.uses, 20);                // each recall lengthens it
  return Math.max(0.5, baseDays) * importanceFactor * repetitionFactor;
}

/** 1 for core memory; Ebbinghaus-style exponential decay for episodic memory. */
export function retention(entry: MemoryEntry, now: number, baseDays: number): number {
  if (entry.layer === 'core') return 1;
  const days = Math.max(0, now - entry.lastUsedAt) / DAY_MS;
  return Math.pow(0.5, days / halfLifeDays(entry, baseDays));
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Latin words plus CJK bigrams: enough for local keyword relevance without a tokenizer. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? []) out.add(word);
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** Share of the entry's tokens that also appear in the query, 0..1. */
export function relevance(entry: Pick<MemoryEntry, 'text'>, query: Set<string>): number {
  if (!query.size) return 0;
  const own = tokens(entry.text);
  if (!own.size) return 0;
  let hit = 0;
  for (const token of own) if (query.has(token)) hit++;
  return hit / own.size;
}

export interface RankedEntry {
  readonly entry: MemoryEntry;
  readonly retention: number;
  readonly relevance: number;
  readonly score: number;
}

/** Episodic entries worth injecting now: not faded, ordered by retention weighted by relevance. */
export function rankEpisodic(entries: readonly MemoryEntry[], query: string, now: number, baseDays: number, limit: number): RankedEntry[] {
  const q = tokens(query);
  return entries
    .filter(entry => entry.layer === 'episodic')
    .map(entry => {
      const r = retention(entry, now, baseDays);
      const rel = relevance(entry, q);
      return { entry, retention: r, relevance: rel, score: r * (0.4 + rel) * (0.6 + clampImportance(entry.importance) / 10) };
    })
    .filter(item => item.retention >= FADED_RETENTION)
    .sort((a, b) => b.score - a.score || b.entry.lastUsedAt - a.entry.lastUsedAt)
    .slice(0, Math.max(0, limit));
}

/** Search every entry (faded included) for an explicit recall. */
export function searchEntries(entries: readonly MemoryEntry[], query: string, now: number, baseDays: number, limit: number): RankedEntry[] {
  const q = tokens(query);
  return entries
    .map(entry => {
      const r = retention(entry, now, baseDays);
      const rel = relevance(entry, q);
      return { entry, retention: r, relevance: rel, score: rel * (0.5 + r / 2) };
    })
    .filter(item => item.relevance > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

/** Reinforce: a deliberate use resets the clock and lengthens the half-life. */
export function reinforce(entry: MemoryEntry, now: number): MemoryEntry {
  return { ...entry, uses: entry.uses + 1, lastUsedAt: now };
}

/** Make room: drop the most faded episodic entries first; core memory is never evicted. */
export function evict(entries: readonly MemoryEntry[], now: number, baseDays: number, max = MAX_ENTRIES_PER_FILE): MemoryEntry[] {
  if (entries.length <= max) return [...entries];
  const episodic = entries.filter(e => e.layer === 'episodic')
    .sort((a, b) => retention(a, now, baseDays) - retention(b, now, baseDays));
  const drop = new Set(episodic.slice(0, entries.length - max).map(e => e.id));
  return entries.filter(e => !drop.has(e.id));
}

function dateLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatCore(entry: MemoryEntry): string {
  return `- ${entry.text}`;
}

export function formatEpisodic(item: RankedEntry): string {
  const clarity = Math.round(item.retention * 100);
  return `- ${item.entry.text}（${dateLabel(item.entry.createdAt)}，清晰度 ${clarity}%）`;
}

/** Parse the legacy one-line Markdown format (`- text [YYYY-MM-DD]`) into episodic entries. */
export function importLegacyMarkdown(text: string, now: number, newId: () => string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^- (.+?)(?: \[(\d{4}-\d{2}-\d{2})\])?$/);
    if (!m) continue;
    const at = m[2] ? Date.parse(`${m[2]}T12:00:00`) : now;
    const ts = Number.isFinite(at) ? at : now;
    out.push({ id: newId(), text: normalizeText(m[1]!), layer: 'episodic', importance: 3, createdAt: ts, lastUsedAt: ts, uses: 0 });
  }
  return out;
}
