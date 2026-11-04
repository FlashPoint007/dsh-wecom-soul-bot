import type { WsFrame } from '@wecom/aibot-node-sdk';
import { validIdentifier } from './format.js';

/**
 * Validated identity of one `aibot_msg_callback` frame. Frames for another
 * Bot, with malformed or control-character IDs, or of an unknown chat type
 * are dropped before anything is recorded.
 */
export interface InboundMessage {
  readonly frame: WsFrame;
  readonly reqId: string;
  readonly msgId: string;
  readonly chat: string;
  readonly user: string;
  readonly chatType: 'single' | 'group';
  readonly msgtype: string;
  /** Text content of `text` messages (untrimmed). */
  readonly text?: string;
  /** Flattened text of a WeCom "quote" (reply-to) reference, when the
   * sender replied to an earlier message instead of sending a fresh one. */
  readonly quotedText?: string;
}

/** WeCom quotes carry the quoted content, not its id — flatten whatever text
 * it holds (text, or the text items of a mixed message) so the bridge can
 * look for its own `/use <token>` hint inside it. */
function flattenQuote(quote: unknown): string | undefined {
  if (!quote || typeof quote !== 'object') return undefined;
  const q = quote as { msgtype?: unknown; text?: { content?: unknown }; mixed?: { msg_item?: unknown } };
  if (q.msgtype === 'text' && typeof q.text?.content === 'string') return q.text.content;
  if (q.msgtype === 'mixed' && Array.isArray(q.mixed?.msg_item)) {
    const texts = q.mixed.msg_item
      .map(item => (item as { msgtype?: unknown; text?: { content?: unknown } } | null))
      .filter(item => item?.msgtype === 'text' && typeof item.text?.content === 'string')
      .map(item => item!.text!.content as string);
    return texts.length ? texts.join('\n') : undefined;
  }
  return undefined;
}

// A group message is only ever delivered to this Bot when it was @-mentioned
// (WeCom never forwards a group message otherwise), and WeCom leaves that
// mention as literal "@DisplayName " text wherever the sender's cursor was —
// most people mention the Bot first, then type. One or more such tokens at
// the very start are addressing, not content: stripped so a command typed
// right after "@Bot" still parses, and so DSH is not handed stray "@Bot "
// text as if the sender had written it. A mid-message mention is left
// alone — it was clearly meant as part of what was said.
const LEADING_MENTIONS_RE = /^(?:@\S+\s*)+/;

function stripLeadingMentions(text: string): string {
  return text.replace(LEADING_MENTIONS_RE, '');
}

export function parseInbound(frame: WsFrame | undefined, botId: string): InboundMessage | null {
  if (frame?.cmd !== 'aibot_msg_callback' || !validIdentifier(frame.headers?.req_id, 512)) return null;
  const body = frame.body as Record<string, unknown> | undefined;
  if (!body || body.aibotid !== botId || !validIdentifier(body.msgid, 512)) return null;
  if (typeof body.msgtype !== 'string' || !body.msgtype) return null;
  if (body.chattype !== 'single' && body.chattype !== 'group') return null;
  const user = (body.from as { userid?: unknown } | undefined)?.userid;
  if (!validIdentifier(user)) return null;
  const chat = body.chattype === 'group' ? body.chatid : user;
  if (!validIdentifier(chat)) return null;
  const rawText = body.msgtype === 'text' ? (body.text as { content?: unknown } | undefined)?.content : undefined;
  const text = typeof rawText === 'string' && body.chattype === 'group' ? stripLeadingMentions(rawText) : rawText;
  const quotedText = flattenQuote(body.quote);
  return {
    frame,
    reqId: frame.headers.req_id,
    msgId: body.msgid,
    chat,
    user,
    chatType: body.chattype,
    msgtype: body.msgtype,
    ...(typeof text === 'string' ? { text } : {}),
    ...(quotedText !== undefined ? { quotedText } : {}),
  };
}

/** Bounded replay guard for callback `msgid`s. */
export function createReplayGuard(windowMs = 5 * 60 * 1000, maxEntries = 1000) {
  const seen = new Map<string, number>();
  return {
    /** True the first time an id is seen within the window. */
    first(id: string, now = Date.now()): boolean {
      for (const [key, time] of seen) {
        if (time > now - windowMs && seen.size <= maxEntries) break;
        seen.delete(key);
      }
      if (seen.has(id)) return false;
      seen.set(id, now);
      return true;
    },
  };
}
