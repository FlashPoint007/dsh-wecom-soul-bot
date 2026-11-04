// The routing route's op guard: the half of the contract the page cannot test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGroup, addMember, archiveMember, deleteGroup, removeMember, setLabel, setMemberModel, setMemberPermission, setSettings, updateGroup, updateMember,
} from '../src/client/model.ts';
import { isStoreOp } from '../dist/host/routes.js';

/**
 * Every op the settings page can post. A missing `case` in `isStoreOp`
 * rejects the whole batch with 400, which disables a page feature without any
 * visible error — precisely how a 备注 edit once failed while looking fine.
 */
const SAMPLE_OPS = [
  addGroup(),
  addGroup('朋友'),
  updateGroup('default', { name: '默认' }),
  updateGroup('default', { workspace: '/srv/app' }),
  updateGroup('default', { provider: 'p', model: 'm', reasoningEffort: 'high' }),
  updateGroup('default', { preset: 'ptc' }),
  updateGroup('default', { permission: 'danger-full-access' }),
  deleteGroup('g1'),
  addMember('default', 'user', 'alice'),
  addMember('default', 'group', 'chat-1', '研发群'),
  updateMember('user:alice', { sessionId: 's1' }),
  updateMember('user:alice', { groupId: 'g1' }),
  removeMember('user:alice'),
  archiveMember('user:alice'),
  setMemberModel('user:alice', 's1', { provider: 'p', model: 'm' }),
  setMemberPermission('user:alice', 's1', 'workspace-write'),
  setLabel('user:alice', '爱丽丝'),
  setLabel('user:alice', ''),
  setSettings({ adminUserIds: ['alice'] }),
  setSettings({ questionTimeoutMs: 30000, remoteApprovals: true }),
  setSettings({ adminWorkspaces: ['/w/alpha'] }),
  setSettings({ wsUrl: 'wss://openws.example' }),
  setSettings({ logEnabled: false, logRetentionDays: 7 }),
];

test('every op the page can build is accepted by the route', () => {
  for (const op of SAMPLE_OPS) assert.equal(isStoreOp(op), true, JSON.stringify(op));
});

test('every op variant is represented, so a new one cannot slip through', () => {
  const covered = new Set(SAMPLE_OPS.map(op => op.op));
  assert.deepEqual([...covered].sort(), [
    'group.add', 'group.delete', 'group.update', 'label.set', 'member.add', 'member.archive',
    'member.model', 'member.permission', 'member.remove', 'member.update', 'settings.set',
  ]);
});

test('junk is rejected before it reaches the store', () => {
  for (const value of [
    undefined, null, 0, 'group.delete', [], {}, { op: 'explode' },
    { op: 'group.update' }, { op: 'group.update', id: 'default', patch: null },
    { op: 'group.delete' }, { op: 'group.delete', id: 7 },
    { op: 'member.add', groupId: 'default', kind: 'nonsense', id: 'x' },
    { op: 'member.add', kind: 'user', id: 'x' },
    { op: 'member.update', key: 'user:alice' },
    { op: 'member.permission', key: 'user:alice', sessionId: 's1' }, { op: 'member.permission', key: 'user:alice', permission: 'read-only' },
    { op: 'member.remove' }, { op: 'member.archive' }, { op: 'member.archive', key: 7 },
    { op: 'label.set', key: 'user:alice' }, { op: 'label.set', label: 'x' },
    { op: 'label.set', key: 'user:alice', label: 42 },
    { op: 'group.add', name: 42 },
    { op: 'settings.set' }, { op: 'settings.set', patch: null },
    { op: 'settings.set', patch: 'adminUserIds' }, { op: 'settings.set', patch: [] },
  ]) {
    assert.equal(isStoreOp(value), false, JSON.stringify(value));
  }
});
