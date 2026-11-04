import { randomUUID } from 'node:crypto';
import type { ApprovalRequest, HostContext, InteractionGateway, InteractionPeer, QuestionRequest } from './dsh.js';
import type { Journal } from './journal.js';

/** A Gateway ACK means submitted, never that this channel won the race. */
export type InteractionSubmission = 'accepted' | 'submitted' | 'closed';

export interface InteractionDelivery {
  readonly id: string;
  readonly signal: AbortSignal;
  submit(value: unknown): Promise<InteractionSubmission>;
  decline(): Promise<void>;
}

export interface InteractionTransport {
  ready(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface DeliveryState {
  readonly controller: AbortController;
  open: boolean;
  submitting: boolean;
}

const EMPTY_UPLINK: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() {} };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * Participate in the SAME pending-event broker as the DSH browser. WeCom is a
 * separate, explicitly owned Peer, not a competing waterfall listener. The
 * Gateway atomically accepts one result and cancels all other deliveries.
 *
 * Uses only inspected public Host APIs. In particular `$events/result` is a
 * carrier endpoint, not a business Remote method: `gateway.invoke` cannot call
 * it. Connection's public shared Fetch handler is the in-process carrier.
 */
export function createInteractionTransport(options: {
  readonly ctx: HostContext;
  readonly journal: Journal;
  onQuestion(request: QuestionRequest, delivery: InteractionDelivery): Promise<unknown>;
  onApproval(request: ApprovalRequest, delivery: InteractionDelivery): Promise<unknown>;
}): InteractionTransport | undefined {
  const { ctx, journal } = options;
  const gateway = ctx.get?.('typertGateway') as InteractionGateway | undefined;
  const connection = ctx.connection;
  if (!gateway?.wireStream?.open || !connection.createPeer || !connection.createSharedFetchHandler) return undefined;
  const handler = connection.createSharedFetchHandler('/api');
  const lifetime = new AbortController();
  const pending = new Map<string, DeliveryState>();
  let peer: InteractionPeer | undefined;
  let clientId = '';
  let pump: Promise<void> | undefined;
  let started = false;
  let stopped = false;

  function close(id: string): void {
    const state = pending.get(id);
    if (!state) return;
    state.open = false;
    pending.delete(id);
    // Cancel means another answerer settled OR the request ended; the protocol
    // does not identify a winner, and the plugin must not invent one.
    state.controller.abort();
  }

  async function result(id: string, outcome: { kind: 'result'; value: unknown } | { kind: 'next' }): Promise<void> {
    if (!peer || !clientId || lifetime.signal.aborted) throw new Error('Interaction transport is unavailable');
    const response = await handler.fetch(new Request('http://dsh.internal/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: lifetime.signal,
      body: JSON.stringify({
        type: 'client-request', rpcId: randomUUID(), method: '$events/result',
        payload: { args: { clientId, eventId: id, outcome } },
      }),
    }), peer);
    if (!response.ok) throw new Error('Interaction result carrier rejected the request');
    const envelope: unknown = await response.json();
    if (!record(envelope) || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('Interaction result was not acknowledged');
    }
  }

  function delivery(id: string): InteractionDelivery {
    const state: DeliveryState = { controller: new AbortController(), open: true, submitting: false };
    pending.set(id, state);
    return {
      id, signal: state.controller.signal,
      async submit(value) {
        if (!state.open || state.submitting || lifetime.signal.aborted) return 'closed';
        state.submitting = true;
        try {
          await result(id, { kind: 'result', value });
          if (!state.open) return 'closed';
          state.open = false;
          pending.delete(id);
          // A late-result ACK is deliberately indistinguishable in Gateway.
          return 'submitted';
        } catch {
          close(id);
          return 'closed';
        }
      },
      async decline() {
        if (!state.open) return;
        state.open = false;
        pending.delete(id);
        state.controller.abort();
        try { await result(id, { kind: 'next' }); } catch { /* Native UI remains authoritative. */ }
      },
    };
  }

  async function consume(source: AsyncIterable<unknown>): Promise<void> {
    for await (const value of source) {
      if (lifetime.signal.aborted) return;
      if (!record(value)) throw new Error('Invalid interaction frame');
      if (value.type === 'ready' && typeof value.clientId === 'string') {
        clientId = value.clientId;
        journal.write({ event: 'interaction.ready' });
        continue;
      }
      if (value.type === 'cancel' && typeof value.eventId === 'string') { close(value.eventId); continue; }
      if (value.type !== 'waterfall') continue;
      if (typeof value.eventId !== 'string' || typeof value.agentId !== 'string' || !record(value.request)) {
        throw new Error('Invalid interaction request');
      }
      const request = value.request;
      const target = delivery(value.eventId);
      const base = { agent: { id: value.agentId }, signal: target.signal };
      let task: Promise<unknown>;
      if (value.event === 'user-questions/request' && Array.isArray(request.questions)
        && request.questions.every(question => record(question) && typeof question.id === 'string' && typeof question.question === 'string')) {
        task = options.onQuestion({ ...request, ...base } as unknown as QuestionRequest, target);
      } else if (value.event === 'approval/request' && typeof request.toolName === 'string') {
        task = options.onApproval({ ...request, ...base } as ApprovalRequest, target);
      } else {
        task = target.decline();
      }
      // Do not await a human: the pump MUST consume cancellation while this
      // handler waits, or browser-first completion could not retire the nonce.
      void Promise.resolve(task).catch(async () => {
        journal.write({ event: 'interaction.error', stage: 'dispatch', eventId: target.id });
        await target.decline();
      });
    }
  }

  return {
    ready: () => Boolean(clientId && !lifetime.signal.aborted),
    async start() {
      if (started || stopped) return;
      started = true;
      peer = connection.createPeer!({ principal: { kind: 'owner' }, interactions: 'answer' });
      try {
        const source = await gateway.wireStream.open('$events', { args: {} }, EMPTY_UPLINK, peer, lifetime.signal);
        pump = consume(source).catch(() => {
          if (!lifetime.signal.aborted) journal.write({ event: 'interaction.error', stage: 'stream' });
        }).finally(() => {
          clientId = '';
          for (const id of [...pending.keys()]) close(id);
          if (!lifetime.signal.aborted) journal.write({ event: 'interaction.offline' });
        });
      } catch {
        journal.write({ event: 'interaction.error', stage: 'start' });
        await peer.dispose();
        peer = undefined;
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      lifetime.abort();
      for (const id of [...pending.keys()]) close(id);
      await peer?.dispose();
      await pump;
    },
  };
}
