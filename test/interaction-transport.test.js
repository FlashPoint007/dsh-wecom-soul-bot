import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionTransport } from '../dist/host/interaction-transport.js';
import { createInteractionRegistry } from '../dist/host/bridge/interactions.js';
import { memoryJournal, settle } from './helpers.js';

function queue() {
  const items = [];
  let waiting;
  let closed = false;
  return {
    push(value) { if (waiting) { const resolve = waiting; waiting = undefined; resolve({ value, done: false }); } else items.push(value); },
    close() { closed = true; waiting?.({ done: true }); waiting = undefined; },
    [Symbol.asyncIterator]() { return this; },
    next() { return items.length ? Promise.resolve({ value: items.shift(), done: false }) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => { waiting = resolve; }); },
    return() { this.close(); return Promise.resolve({ done: true }); },
  };
}

/** A carrier model of the inspected Gateway's one shared pending-event broker. */
function broker() {
  const frames = queue();
  const life = new AbortController();
  const pending = new Map();
  const decisions = [];
  const posts = [];
  let beforeResult;
  let peerDisposed = 0;
  const peer = { signal: life.signal, async dispose() { peerDisposed++; life.abort(); frames.close(); } };
  const connection = {
    createPeer(options) { assert.deepEqual(options, { principal: { kind: 'owner' }, interactions: 'answer' }); return peer; },
    createSharedFetchHandler(channel) {
      assert.equal(channel, '/api');
      return { async fetch(request, caller) {
        assert.equal(caller, peer);
        assert.equal(new URL(request.url).pathname, '/api/$events/result');
        const message = await request.json();
        assert.equal(message.type, 'client-request');
        assert.equal(message.method, '$events/result');
        const result = message.payload.args;
        assert.equal(result.clientId, 'wecom-peer-stream');
        posts.push(result);
        await beforeResult?.();
        const entry = pending.get(result.eventId);
        if (entry?.open && result.outcome.kind === 'result') {
          entry.open = false;
          decisions.push({ eventId: result.eventId, source: 'wecom', value: result.outcome.value });
          // Gateway cancels browser deliveries, not the submitting delivery.
          entry.browserCancelled = true;
        } else if (entry?.open && result.outcome.kind === 'next') entry.wecomDeclined = true;
        // Native ACK is void for both accepted and ignored late results.
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true } });
      } };
    },
  };
  const gateway = { wireStream: { async open(endpoint, payload, _uplink, caller, signal) {
    assert.equal(endpoint, '$events');
    assert.deepEqual(payload, { args: {} });
    assert.equal(caller, peer);
    signal.addEventListener('abort', () => frames.close(), { once: true });
    frames.push({ type: 'ready', clientId: 'wecom-peer-stream' });
    return frames;
  } } };
  return {
    ctx: { connection, get: name => name === 'typertGateway' ? gateway : undefined },
    decisions, posts, pending,
    setBeforeResult(fn) { beforeResult = fn; },
    get peerDisposed() { return peerDisposed; },
    emit(event, eventId, request = {}) {
      pending.set(eventId, { open: true });
      frames.push({ type: 'waterfall', event, eventId, agentId: 's1', request });
    },
    browserAnswer(eventId, value, deliverCancel = true) {
      const entry = pending.get(eventId);
      if (!entry?.open) return false;
      entry.open = false;
      decisions.push({ eventId, source: 'browser', value });
      if (deliverCancel) frames.push({ type: 'cancel', eventId });
      return true;
    },
  };
}

async function harness() {
  const host = broker();
  const deliveries = new Map();
  const requests = [];
  const transport = createInteractionTransport({ ctx: host.ctx, journal: memoryJournal(),
    async onQuestion(request, delivery) { requests.push(request); deliveries.set(delivery.id, delivery); },
    async onApproval(request, delivery) { requests.push(request); deliveries.set(delivery.id, delivery); },
  });
  await transport.start();
  await settle();
  return { host, transport, deliveries, requests };
}

const approval = { toolName: 'bash', callId: 'tool-1' };
const question = { questions: [{ id: 'q', question: 'Which?' }], wait: { callId: 'ask-1', timed: true } };

test('browser-first cancels the same WeCom delivery and late approval cannot override it', async () => {
  const h = await harness();
  h.host.emit('approval/request', 'e1', approval);
  await settle();
  const delivery = h.deliveries.get('e1');
  assert.equal(h.host.browserAnswer('e1', 'rejected'), true);
  await settle();
  assert.equal(delivery.signal.aborted, true);
  assert.equal(await delivery.submit('allowed-once'), 'closed');
  assert.deepEqual(h.host.decisions, [{ eventId: 'e1', source: 'browser', value: 'rejected' }]);
  assert.equal(h.host.posts.length, 0);
  await h.transport.stop();
});

test('WeCom-first uses the shared broker, cancels browser ownership, and only acknowledges submission', async () => {
  const h = await harness();
  h.host.emit('approval/request', 'e1', approval);
  await settle();
  assert.equal(await h.deliveries.get('e1').submit('allowed-once'), 'submitted');
  assert.equal(h.host.browserAnswer('e1', 'rejected'), false);
  assert.equal(await h.deliveries.get('e1').submit('rejected'), 'closed');
  assert.equal(h.host.pending.get('e1').browserCancelled, true);
  assert.equal(h.host.decisions.length, 1);
  await h.transport.stop();
  assert.equal(h.host.peerDisposed, 1);
});

test('an opposite browser decision while a WeCom result is in flight still wins exactly once', async () => {
  const h = await harness();
  h.host.emit('approval/request', 'e1', approval);
  await settle();
  let release;
  h.host.setBeforeResult(() => new Promise(resolve => { release = resolve; }));
  const result = h.deliveries.get('e1').submit('allowed-once');
  await settle();
  h.host.browserAnswer('e1', 'rejected');
  await settle();
  release();
  assert.equal(await result, 'closed');
  assert.deepEqual(h.host.decisions.map(item => item.value), ['rejected']);
  await h.transport.stop();
});

test('a void ACK for a late result is never exposed as accepted or allowed', async () => {
  const h = await harness();
  h.host.emit('approval/request', 'e1', approval);
  await settle();
  h.host.browserAnswer('e1', 'rejected', false); // cancellation is delayed on the downlink
  assert.equal(await h.deliveries.get('e1').submit('allowed-once'), 'submitted');
  assert.deepEqual(h.host.decisions.map(item => item.value), ['rejected']);
  await h.transport.stop();
});

test('questions preserve timed call identity; declining one channel leaves native UI actionable', async () => {
  const h = await harness();
  h.host.emit('user-questions/request', 'q1', question);
  await settle();
  assert.deepEqual(h.requests[0].wait, { callId: 'ask-1', timed: true });
  await h.deliveries.get('q1').decline();
  assert.equal(h.host.pending.get('q1').wecomDeclined, true);
  assert.equal(h.host.browserAnswer('q1', { answers: [] }), true);
  await h.transport.stop();
});

test('registry handles multiple same-Session requests, atomic submissions, and late nonce tombstones', async () => {
  const registry = createInteractionRegistry();
  const first = new AbortController();
  const second = new AbortController();
  let release;
  let calls = 0;
  const delivery = { id: 'e1', signal: first.signal, decline: async () => {}, submit: async () => { calls++; await new Promise(resolve => { release = resolve; }); return 'submitted'; } };
  const one = registry.waitApproval('s1', { toolName: 'bash', privateChats: ['root'] }, 60_000, first.signal, delivery);
  const two = registry.waitApproval('s1', { toolName: 'edit', privateChats: ['root'] }, 60_000, second.signal, { ...delivery, id: 'e2', signal: second.signal });
  assert.ok(one && two);
  assert.notEqual(one.nonce, two.nonce);
  const pending = registry.findApproval(one.nonce);
  const submitted = pending.submit('allowed-once');
  assert.equal(await pending.submit('rejected'), 'closed');
  assert.equal(calls, 1);
  release();
  assert.equal(await submitted, 'submitted');
  assert.equal(await one.result, 'allowed-once');
  assert.equal(registry.wasClosed(one.nonce), true);
  second.abort();
  assert.equal(await two.result, null);
  assert.equal(registry.wasClosed(two.nonce), true);
  assert.equal(registry.approvals.size, 0);
});

test('missing public transport capabilities fail closed without fabricating remote interaction support', () => {
  assert.equal(createInteractionTransport({ ctx: { connection: {}, get() {} }, journal: memoryJournal(), onQuestion: async () => {}, onApproval: async () => {} }), undefined);
});
