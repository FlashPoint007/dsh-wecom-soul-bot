import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTitler, SESSION_TITLE_PREFIX, sessionTitleFor } from '../dist/host/session-title.js';

/**
 * Session naming is a decoration on top of Session creation: it must be exact
 * when it can work, and silent when it cannot.
 */

test('a title names the principal it belongs to', () => {
  assert.equal(SESSION_TITLE_PREFIX, 'wecom-soul-bot-');
  assert.equal(sessionTitleFor('alice'), 'wecom-soul-bot-alice');
  assert.equal(sessionTitleFor('wrOgAAAAexample'), 'wecom-soul-bot-wrOgAAAAexample');
});

test('a deployment without the services journals the attempt instead of throwing', () => {
  const records = [];
  const titler = createSessionTitler({ ctx: { get: () => undefined }, journal: { write: record => records.push(record) } });
  titler.name('session-1', 'wecom-soul-bot-alice');
  assert.deepEqual(records, [
    { event: 'dsh.session.title', sessionId: 'session-1', title: 'wecom-soul-bot-alice', outcome: 'unavailable' },
  ]);
});

test('a Session that is not live cannot be named', () => {
  const records = [];
  const title = { rename() { throw new Error('should not be called'); } };
  const ctx = { get: name => (name === 'sessions' ? { get: () => undefined } : title) };
  createSessionTitler({ ctx, journal: { write: record => records.push(record) } }).name('session-1', 'wecom-soul-bot-alice');
  assert.equal(records[0].outcome, 'unavailable', 'a cold Session has no log to pin a title into');
});

test('the live Session object is renamed, and the outcome is recorded', () => {
  const records = [];
  const live = { id: 'session-1' };
  const renames = [];
  const ctx = {
    get: name => (name === 'sessions'
      ? { get: id => (id === 'session-1' ? live : undefined) }
      : { rename: (session, title) => { renames.push({ session, title }); return { title }; } }),
  };
  createSessionTitler({ ctx, journal: { write: record => records.push(record) } }).name('session-1', 'wecom-soul-bot-alice');
  assert.deepEqual(renames, [{ session: live, title: 'wecom-soul-bot-alice' }]);
  assert.equal(records[0].outcome, 'renamed');
});

test('a rejected title is journaled, never propagated', () => {
  const records = [];
  const ctx = {
    get: name => (name === 'sessions'
      ? { get: () => ({ id: 'session-1' }) }
      : { rename() { throw new Error('title too long'); } }),
  };
  createSessionTitler({ ctx, journal: { write: record => records.push(record) } }).name('session-1', 'wecom-soul-bot-alice');
  assert.equal(records[0].level, 'warn');
  assert.match(records[0].error.message, /title too long/);
});
