import type { BindingKind, RejectedObservation } from '../shared/protocol.js';
import { bindingKey } from './store.js';

/**
 * Host-lifetime, bounded memory of the WeCom senders that messaged the Bot.
 *
 * Two things are read back from here: the member rows' activity counters, and
 * the 「未授权用户」 card, which lists every *refused* sender together with the
 * latest message so the operator can recognize who is knocking. Message text is
 * kept for refused senders only — an accepted message is never stored, and
 * nothing here is persisted. A Host restart empties the refusals, which is
 * harmless because authorizing a sender writes a durable membership instead.
 */

export interface MessageSighting {
  readonly chat: string;
  readonly user: string;
  readonly chatType: 'single' | 'group';
  readonly accepted: boolean;
  /** Latest message text; only kept while the sender is refused. */
  readonly text?: string;
}

export interface SenderStats {
  readonly messages: number;
  readonly lastSeenAt?: number;
}

export interface ObservationStore {
  /** Record one message from a valid Bot callback, accepted or refused. */
  record(sighting: MessageSighting): void;
  /** Activity of one member row. */
  stats(kind: BindingKind, id: string): SenderStats;
  /**
   * Refused senders, newest first. `authorized` filters out senders that have
   * since been put into a group.
   */
  rejected(authorized: (key: string) => boolean): readonly RejectedObservation[];
}

export interface ObservationOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  /** Longest kept message excerpt, in characters. */
  readonly maxTextChars?: number;
  now?(): number;
}

interface Entry {
  id: string;
  kind: BindingKind;
  chatType: 'single' | 'group';
  firstSeenAt: number;
  lastSeenAt: number;
  messages: number;
  /** True while the latest decision for this sender was a refusal. */
  refused: boolean;
  text?: string;
}

export const OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_OBSERVED = 200;
export const MAX_TEXT_CHARS = 120;

/** One line, no control characters, bounded — safe to render as plain text. */
function excerpt(value: string, maxChars: number): string {
  const squashed = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!squashed) return '';
  return squashed.length > maxChars ? `${squashed.slice(0, maxChars)}…` : squashed;
}

export function createObservationStore(options: ObservationOptions = {}): ObservationStore {
  const ttl = options.ttlMs ?? OBSERVATION_TTL_MS;
  const max = options.maxEntries ?? MAX_OBSERVED;
  const maxText = options.maxTextChars ?? MAX_TEXT_CHARS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function prune(at: number): void {
    for (const [key, entry] of entries) if (entry.lastSeenAt <= at - ttl) entries.delete(key);
  }

  return {
    record(sighting) {
      const at = now();
      prune(at);
      const kind: BindingKind = sighting.chatType === 'group' ? 'group' : 'user';
      const id = kind === 'group' ? sighting.chat : sighting.user;
      const key = bindingKey(kind, id);
      const existing = entries.get(key);
      const entry: Entry = existing ?? {
        id, kind, chatType: sighting.chatType, firstSeenAt: at, lastSeenAt: at, messages: 0, refused: false,
      };
      entries.delete(key); // re-insert to keep Map order = recency
      entry.lastSeenAt = at;
      entry.messages++;
      entry.chatType = sighting.chatType;
      entry.refused = !sighting.accepted;
      const text = !sighting.accepted && sighting.text ? excerpt(sighting.text, maxText) : '';
      if (text) entry.text = text; else delete entry.text;
      entries.set(key, entry);
      if (entries.size > max) entries.delete(entries.keys().next().value!);
    },
    stats(kind, id) {
      prune(now());
      const entry = entries.get(bindingKey(kind, id));
      return entry ? { messages: entry.messages, lastSeenAt: entry.lastSeenAt } : { messages: 0 };
    },
    rejected(authorized) {
      prune(now());
      const rows: RejectedObservation[] = [];
      for (const [key, entry] of [...entries].reverse()) {
        if (!entry.refused || authorized(key)) continue;
        rows.push(Object.freeze({
          key,
          kind: entry.kind,
          id: entry.id,
          chatType: entry.chatType,
          ...(entry.text ? { text: entry.text } : {}),
          messages: entry.messages,
          firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt,
        }));
      }
      return rows;
    },
  };
}
