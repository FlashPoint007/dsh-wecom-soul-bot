import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingChanges, createDeliveryService, MAX_DELIVERY_CHARS } from '../dist/host/delivery-service.js';

const rows = [
  { kind: 'user', id: 'owner', groupId: 'default', sessionId: 's1' },
  { kind: 'group', id: 'g1', groupId: 'default', sessionId: 's2' },
];

function service({ online = true } = {}) {
  const sent = [];
  const svc = createDeliveryService({
    bindings: () => rows,
    get: key => rows.find(b => b.kind + ':' + b.id === key),
    forSession: id => rows.filter(b => b.sessionId === id),
    label: key => (key === 'group:g1' ? '研发群' : ''),
    lastSender: id => (id === 's2' ? 'bob' : undefined),
    notify(chat, text) { if (!online) return false; sent.push({ chat, text }); return true; },
  });
  return { svc, sent };
}

test('other plugins can only deliver to conversations the operator authorized', async () => {
  const { svc, sent } = service();
  assert.deepEqual(await svc.send('group:g1', '构建完成'), { ok: true });
  assert.deepEqual(sent, [{ chat: 'g1', text: '构建完成' }]);
  assert.equal((await svc.send('user:stranger', 'hi')).ok, false);
  assert.equal((await svc.send('group:g1', '  ')).error, 'empty-text');
  assert.equal((await svc.send('group:g1', 'x'.repeat(MAX_DELIVERY_CHARS + 1))).error, 'text-too-long');
  assert.deepEqual(svc.listTargets().map(t => t.targetId + '|' + t.label), ['user:owner|owner', 'group:g1|研发群']);
});

test('delivery reports offline instead of pretending it was sent', async () => {
  const { svc } = service({ online: false });
  assert.deepEqual(await svc.send('user:owner', 'hi'), { ok: false, error: 'offline' });
});

test('session -> conversation lookup returns channel, chat and last sender', () => {
  const { svc } = service();
  assert.deepEqual(svc.describeConversation('s2'), {
    channel: 'wecom', bindingKey: 'group:g1', chatType: 'group', chatId: 'g1', senderId: 'bob', sessionId: 's2',
  });
  assert.equal(svc.describeConversation('s1').senderId, 'owner', 'a private chat falls back to its user');
  assert.equal(svc.describeConversationSync('unknown'), null);
});

test('binding changes are announced as unbind-then-bind', () => {
  const before = [{ kind: 'user', id: 'a', sessionId: 's1' }, { kind: 'user', id: 'b', sessionId: 's2' }];
  const after = [{ kind: 'user', id: 'a', sessionId: 's3' }, { kind: 'user', id: 'b', sessionId: 's2' }, { kind: 'group', id: 'g', sessionId: 's4' }];
  const { bound, unbound } = bindingChanges(before, after);
  assert.deepEqual(unbound.map(b => b.sessionId), ['s1']);
  assert.deepEqual(bound.map(b => b.sessionId), ['s3', 's4']);
});
