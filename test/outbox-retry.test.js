import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, definiteFailure, MAX_SEND_ATTEMPTS } from '../dist/host/bridge/outbox.js';
import { memoryJournal, until } from './helpers.js';

function outboxWith(send) {
  const journal = memoryJournal();
  const calls = [];
  const client = { async sendMessage(chat, body) { calls.push(chat); return send(calls.length); } };
  const status = { count() {}, set() {} };
  const outbox = createOutbox({ client, journal, log: { warn() {}, error() {} }, status, retryDelayMs: 0 });
  outbox.setOnline(true);
  return { outbox, calls, journal };
}

test('a refused send (errcode != 0) is retried up to the cap, then given up', async () => {
  const h = outboxWith(() => ({ errcode: 40001, errmsg: 'busy' }));
  h.outbox.enqueue({ chat: 'a', text: 'hi', kind: 'turn-complete' });
  assert.ok(await until(() => h.journal.find('wecom.send.gave-up').length === 1));
  assert.equal(h.calls.length, MAX_SEND_ATTEMPTS);
});

test('a definite error is retried and stops at the first success', async () => {
  const h = outboxWith(n => { if (n === 1) throw new Error('connection not authenticated'); return { errcode: 0 }; });
  h.outbox.enqueue({ chat: 'a', text: 'hi', kind: 'turn-complete' });
  assert.ok(await until(() => h.calls.length === 2));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.calls.length, 2);
  assert.equal(h.journal.find('wecom.send.gave-up').length, 0);
});

test('an uncertain failure (timeout) is never retried, to avoid duplicates', async () => {
  const h = outboxWith(() => { throw new Error('Reply ack timeout after 5000ms'); });
  h.outbox.enqueue({ chat: 'a', text: 'hi', kind: 'turn-complete' });
  assert.ok(await until(() => h.journal.find('wecom.send.uncertain').length === 1));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.calls.length, 1);
  assert.equal(definiteFailure(new Error('ECONNRESET')), false);
  assert.equal(definiteFailure(new Error('invalid chatid')), true);
});
