/** Text helpers shared by bridge replies and notifications. */

const encoder = new TextEncoder();

export const MAX_INBOUND_BYTES = 6000;
export const MAX_NOTICE_BYTES = 3500;
export const MAX_REPLY_BYTES = 4000;

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Longest prefix within `maxBytes` UTF-8 bytes, never splitting a code point. */
export function limitBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const marker = '…';
  const budget = Math.max(0, maxBytes - byteLength(marker));
  let used = 0;
  let result = '';
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > budget) break;
    used += size;
    result += char;
  }
  return result + marker;
}

/** Escape Markdown so untrusted text renders literally in WeCom. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+.!>|~-]/g, '\\$&');
}

/** A Markdown-safe, length-bounded fragment of untrusted text. */
export function plain(text: string, maxBytes = MAX_NOTICE_BYTES): string {
  return limitBytes(escapeMarkdown(text), maxBytes);
}

export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** DSH Session ids all share this marker, so a naive `slice(0, N)` shows the
 * same characters for every Session — both helpers below skip it first. */
const SESSION_ID_PREFIX = 'session-';

function splitSessionId(id: string): { readonly prefix: string; readonly rest: string } {
  return id.startsWith(SESSION_ID_PREFIX)
    ? { prefix: SESSION_ID_PREFIX, rest: id.slice(SESSION_ID_PREFIX.length) }
    : { prefix: '', rest: id };
}

/** A short, ellipsis-trimmed fragment for display (`/sessions` rows). Not
 * guaranteed to be a valid {@link SessionDirectory.resolve} prefix. */
export function shortId(id: string): string {
  const { prefix, rest } = splitSessionId(id);
  return `${prefix}${rest.length > 10 ? `${rest.slice(0, 10)}…` : rest}`;
}

/** A plain (no ellipsis) Session id prefix long enough to resolve uniquely
 * through {@link SessionDirectory.resolve} (≥ 6 chars past a shared marker) —
 * safe to paste after `/use`, and what {@link extractSessionPointer} looks
 * for inside a WeCom "quote" (reply-to) reference. */
export function sessionToken(id: string, visibleChars = 12): string {
  const { prefix, rest } = splitSessionId(id);
  return `${prefix}${rest.slice(0, visibleChars)}`;
}

// Session ids use only ASCII letters, digits, "-" and "_"; the class below
// stops at the first other character (Chinese punctuation included — `\S`
// alone would swallow it, since it matches any non-whitespace character).
const SESSION_POINTER_RE = /\/use\s+([\w-]{1,80})/;

/** Recovers the {@link sessionToken} embedded in a notice's "quote this
 * message to jump back here" hint, from the quoted text WeCom echoes back
 * on a reply. `undefined` when the quoted text carries no such hint. */
export function extractSessionPointer(quotedText: string): string | undefined {
  return SESSION_POINTER_RE.exec(quotedText)?.[1];
}

export const UNTITLED_SESSION = '未命名会话';

export function displayTitle(title: string | null | undefined): string {
  return title?.trim() ? oneLine(title) : UNTITLED_SESSION;
}

/** Bounded identifier without control characters, as WeCom IDs are. */
export function validIdentifier(value: unknown, maxBytes = 256): value is string {
  return typeof value === 'string' && Boolean(value.trim())
    && byteLength(value) <= maxBytes && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** Shorten a home-directory prefix for display: /Users/me/x → ~/x. */
export function displayPath(path: string | undefined): string {
  return (path ?? '').replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}

/** Compact token count: 812, 12.3k, 200k, 1.2M. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 100_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `12.3k / 200k（6%）`, or the bare used count when no window is known. */
export function formatContext(used: number, window: number | undefined): string {
  const tokens = formatTokens(used);
  if (!window) return tokens;
  return `${tokens} / ${formatTokens(window)}（${Math.round((used / window) * 100)}%）`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
