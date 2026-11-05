import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPendingLedger, outcomeOf, PENDING_TTL_MS } from '../dist/host/pending.js';
import { scratchDirectory } from './helpers.js';

const log = (rpcId, { reason = 'completed', text = '好的', ended = true } = {}) => [
  { type: 'turn/start', data: { turn: 3 } },
  { type: 'user/message', data: { turn: 3, source: { kind: 'user', rpcId }, content: [{ type: 'text', text: 'hi' }] } },
  { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '中间' }] } } },
  { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text }] } } },
  ...(ended ? [{ type: 'turn/end', data: { turn: 3, reason: { kind: reason } } }] : []),
];

test('outcomeOf reads the final answer of the turn that consumed a prompt', () => {
  assert.deepEqual(outcomeOf(log('r1'), 'r1'), { state: 'ended', reason: 'completed', text: '好的' });
  assert.deepEqual(outcomeOf(log('r1', { ended: false }), 'r1'), { state: 'running' });
  assert.deepEqual(outcomeOf(log('r1'), 'other'), { state: 'unconsumed' });
  assert.equal(outcomeOf(log('r1', { reason: 'cancelled' }), 'r1').reason, 'cancelled');
});

test('the ledger survives a restart, drops settled prompts and expires old ones', async () => {
  let now = 10 * PENDING_TTL_MS;
  const file = join(scratchDirectory(), 'pending.json');
  const a = createPendingLedger({ file, now: () => now });
  await a.load();
  await a.add({ requestId: 'r1', sessionId: 's', chat: 'c', at: now });
  await a.add({ requestId: 'r2', sessionId: 's', chat: 'c', at: now - PENDING_TTL_MS - 1 });
  await a.remove(['missing']);
  const b = createPendingLedger({ file, now: () => now });
  await b.load();
  assert.deepEqual(b.entries().map(p => p.requestId), ['r1'], 'r2 is past the TTL');
  await b.remove(['r1']);
  const c = createPendingLedger({ file, now: () => now });
  await c.load();
  assert.equal(c.entries().length, 0);
});
