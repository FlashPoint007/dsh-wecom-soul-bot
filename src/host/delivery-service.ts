import type { BindingRecord } from '../shared/protocol.js';

/**
 * Host service other plugins use to reach WeCom through this Bot, modelled on
 * dsh-im's dshIm service: proactive text delivery and session -> conversation
 * lookup. Registered as ctx.provide('wecomSoulBot', ...).
 *
 * Delivery targets are the WeCom conversations already authorized on the plugin
 * page (a binding), addressed as user:<userid> or group:<chatid>. A caller cannot
 * reach anyone the operator has not authorized.
 */

export interface ConversationIdentity {
  readonly channel: 'wecom';
  readonly bindingKey: string;
  readonly chatType: 'dm' | 'group';
  readonly chatId: string;
  /** Last WeCom userid that sent a message into this Session, when known. */
  readonly senderId: string | null;
  readonly sessionId: string;
}

export interface DeliveryTarget {
  readonly targetId: string;
  readonly chatType: 'dm' | 'group';
  readonly label: string;
}

export interface WecomDeliveryService {
  readonly contractVersion: 1;
  /** Send markdown text to one authorized conversation. */
  send(targetId: string, text: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  listTargets(): readonly DeliveryTarget[];
  describeConversation(sessionId: string): ConversationIdentity | null;
  describeConversationSync(sessionId: string): ConversationIdentity | null;
}

export const MAX_DELIVERY_CHARS = 4000;

export interface DeliveryServiceOptions {
  bindings(): readonly BindingRecord[];
  get(key: string): BindingRecord | undefined;
  forSession(sessionId: string): readonly BindingRecord[];
  label(key: string): string;
  lastSender(sessionId: string): string | undefined;
  /** Enqueue one proactive message; false when the WeCom connection is not available. */
  notify(chat: string, text: string): boolean;
  journal?: { write(record: Record<string, unknown>): void };
}

function identityOf(binding: BindingRecord, sessionId: string, sender: string | undefined): ConversationIdentity {
  return {
    channel: 'wecom',
    bindingKey: binding.kind + ':' + binding.id,
    chatType: binding.kind === 'group' ? 'group' : 'dm',
    chatId: binding.id,
    senderId: sender ?? (binding.kind === 'user' ? binding.id : null),
    sessionId,
  };
}

export function createDeliveryService(options: DeliveryServiceOptions): WecomDeliveryService {
  const describe = (sessionId: string): ConversationIdentity | null => {
    const binding = options.forSession(sessionId)[0];
    return binding ? identityOf(binding, sessionId, options.lastSender(sessionId)) : null;
  };
  return Object.freeze({
    contractVersion: 1 as const,
    async send(targetId: string, text: string) {
      const binding = options.get(String(targetId ?? '').trim());
      if (!binding) return { ok: false as const, error: 'unknown-target: authorize the conversation on the plugin page first' };
      const body = String(text ?? '').trim();
      if (!body) return { ok: false as const, error: 'empty-text' };
      if (body.length > MAX_DELIVERY_CHARS) return { ok: false as const, error: 'text-too-long' };
      if (!options.notify(binding.id, body)) return { ok: false as const, error: 'offline' };
      options.journal?.write({ event: 'wecom.delivery.service', target: targetId, chars: body.length });
      return { ok: true as const };
    },
    listTargets: () => options.bindings().map(b => ({
      targetId: b.kind + ':' + b.id,
      chatType: b.kind === 'group' ? 'group' as const : 'dm' as const,
      label: options.label(b.kind + ':' + b.id) || b.id,
    })),
    describeConversation: describe,
    describeConversationSync: describe,
  });
}

/** Binding events, mirroring dsh-im's dsh-im/session-pre-bind and dsh-im/session-unbind. */
export const BIND_EVENT = 'wecom-soul-bot/session-bind';
export const UNBIND_EVENT = 'wecom-soul-bot/session-unbind';

/** Diff two binding snapshots and announce every session that gained or lost a conversation. */
export function bindingChanges(before: readonly BindingRecord[], after: readonly BindingRecord[]):
  { readonly bound: readonly BindingRecord[]; readonly unbound: readonly BindingRecord[] } {
  const key = (b: BindingRecord) => b.kind + ':' + b.id;
  const prev = new Map(before.map(b => [key(b), b.sessionId]));
  const next = new Map(after.map(b => [key(b), b.sessionId]));
  const bound = after.filter(b => b.sessionId && prev.get(key(b)) !== b.sessionId);
  const unbound = before.filter(b => b.sessionId && next.get(key(b)) !== b.sessionId);
  return { bound, unbound };
}
