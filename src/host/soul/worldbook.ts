/**
 * Worldbook (SillyTavern character_book style): persona lines that are only
 * injected when the current message mentions one of their trigger words.
 *
 * Written inside the persona card under a "## 世界书" heading, one entry per line:
 *   触发词1, 触发词2 | 内容
 * Lines without "|" are skipped, so a malformed line never breaks the persona.
 */

export interface LoreEntry {
  readonly keys: readonly string[];
  readonly text: string;
}

export const MAX_LORE_HITS = 6;
export const MAX_LORE_CHARS = 2000;

const HEADING = /(?:^|\n)#{1,3}\s*世界书[^\n]*\r?\n([\s\S]*?)(?=\r?\n#{1,3}\s|$)/;

/** Split a persona into the always-on body and its worldbook entries. */
export function splitPersona(text: string): { readonly body: string; readonly lore: readonly LoreEntry[] } {
  const hit = HEADING.exec(text);
  if (!hit) return { body: text.trim(), lore: [] };
  const body = (text.slice(0, hit.index) + text.slice(hit.index + hit[0].length)).trim();
  const lore: LoreEntry[] = [];
  for (const raw of hit[1]!.split(/\r?\n/)) {
    const line = raw.replace(/^[-*·]\s*/, '').trim();
    const bar = line.search(/[|｜]/);
    if (bar < 0) continue;
    const keys = line.slice(0, bar).split(/[,，、]/).map(k => k.trim()).filter(Boolean);
    const content = line.slice(bar + 1).trim();
    if (keys.length && content) lore.push({ keys, text: content.slice(0, 500) });
  }
  return { body, lore };
}

/** Entries whose trigger words appear in the text (case-insensitive), within budget. */
export function matchLore(lore: readonly LoreEntry[], text: string): LoreEntry[] {
  const hay = text.toLowerCase();
  if (!hay) return [];
  const out: LoreEntry[] = [];
  let used = 0;
  for (const entry of lore) {
    if (!entry.keys.some(k => hay.includes(k.toLowerCase()))) continue;
    if (used + entry.text.length > MAX_LORE_CHARS || out.length >= MAX_LORE_HITS) break;
    out.push(entry);
    used += entry.text.length;
  }
  return out;
}
