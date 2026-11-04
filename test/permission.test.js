// Workspace access: a group's mode, the Sessions it is applied to, and the page's edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, sessionPermission } from '../dist/host/catalog.js';
import { createPermissionService } from '../dist/host/permissions.js';
import { createStore } from '../dist/host/store.js';
import { createSessionProvisioner } from '../dist/host/sessions.js';
import { createRouter } from '../dist/host/routing.js';
import { applyStoreOps, buildRoutingView } from '../dist/host/groups-view.js';
import { fakeHost } from './helpers.js';

const MODES = ['read-only', 'workspace-write', 'danger-full-access'];

/** A provisioner over a fake DSH whose permission service records every Session it sets. */
async function fixture(t, { available = true, failSet } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wecom-permission-'));
  const store = createStore({ directory, onError: error => assert.fail(String(error)) });
  t.after(async () => { await store.flush(); await rm(directory, { recursive: true, force: true }); });
  await store.load();
  const states = new Map();
  const sets = [];
  const created = [];
  const permissions = {
    catalog: () => ({ available, modes: available ? MODES : [] }),
    async apply(sessionId, mode) {
      if (failSet) throw failSet;
      sets.push({ sessionId, mode });
    },
  };
  const workspaces = {
    async resolve(path) { return { id: path || '/workspace', path: path || '/workspace' }; },
    async describe(path) { return { path: path || '/workspace', title: 'Workspace', registered: true }; },
  };
  const catalogs = {
    invalidate() {},
    async load() { return {
      get: id => (states.get(id)?.state === 'bound' ? { title: id, group: { title: 'W', path: '/workspace' }, running: false } : undefined),
      getBlank: () => undefined,
      hiddenReason: id => (states.get(id)?.state === 'bound' ? undefined : states.get(id)?.state ?? 'missing'),
      titleOf: id => id,
    }; },
  };
  const provisioner = createSessionProvisioner({
    bindings: store, bindingKey: binding => `${binding.kind}:${binding.id}`, workspaces, catalogs, permissions,
    models: { snapshot: () => undefined, known: () => true, async select(_id, selection) { return selection; } },
    sessionController: {
      async create(request) {
        const sessionId = `created-${created.length + 1}`;
        created.push(request);
        states.set(sessionId, { state: 'bound' });
        return { sessionId };
      },
    },
  });
  const router = createRouter({ store, provisioner });
  const deps = { store, provisioner, workspaces, models: { snapshot: () => undefined, known: () => true }, catalogs, router, permissions, isAdmin: () => false };
  return { store, states, sets, created, provisioner, router, permissions, deps,
    apply: ops => applyStoreOps(deps, ops), view: () => buildRoutingView(deps) };
}

test('a group is read-only until the operator grants more, and an old file reads the same', async t => {
  const f = await fixture(t);
  assert.equal(f.store.group('default').permission, 'read-only');
  const group = await f.store.createGroup('朋友');
  assert.equal(group.permission, 'read-only');
  assert.equal((await f.store.updateGroup(group.id, { permission: 'workspace-write' })).permission, 'workspace-write');
  assert.equal((await f.store.updateGroup(group.id, { permission: 'root' })).permission, 'workspace-write', 'an unknown mode changes nothing');
  assert.equal((await f.view()).groups[0].permission, 'read-only');
  await f.store.flush();
  const reloaded = createStore({ directory: f.deps.store.file.replace(/\/settings\.json$/, '') });
  await reloaded.load();
  assert.equal(reloaded.group(group.id).permission, 'workspace-write', 'survives a reload');
});

test('a Session is put under its group mode before it is bound', async t => {
  const f = await fixture(t);
  const open = await f.store.createGroup('开放');
  await f.store.updateGroup(open.id, { permission: 'workspace-write' });
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.create('user', 'bob', { groupId: open.id });
  const alice = await f.provisioner.ensure(f.store.get('user:alice'), f.store.group('default'));
  const bob = await f.provisioner.ensure(f.store.get('user:bob'), f.store.group(open.id));
  assert.deepEqual(f.sets, [
    { sessionId: alice.sessionId, mode: 'read-only' },
    { sessionId: bob.sessionId, mode: 'workspace-write' },
  ]);
  // Reusing the Session never rewrites what the operator chose for it since.
  await f.provisioner.ensure(f.store.get('user:alice'), f.store.group('default'));
  assert.equal(f.sets.length, 2);
});

test('a Session whose access cannot be set is never bound: DSH starts it with write access', async t => {
  const f = await fixture(t, { failSet: new Error('boom') });
  await f.store.create('user', 'alice', { groupId: 'default' });
  await assert.rejects(f.provisioner.ensure(f.store.get('user:alice'), f.store.group('default')), /boom/);
  assert.equal(f.store.get('user:alice').sessionId, '', 'nothing is bound');
  const routed = await f.router.route({ chat: 'alice', user: 'alice', chatType: 'single' }, 'default');
  assert.equal(routed.ok, false);
  assert.match(routed.message, /boom/);
});

test('without DSH permission presets Sessions are still created', async t => {
  const f = await fixture(t, { available: false });
  await f.store.create('user', 'alice', { groupId: 'default' });
  const provisioned = await f.provisioner.ensure(f.store.get('user:alice'), f.store.group('default'));
  assert.equal(provisioned.created, true);
  assert.deepEqual(f.sets, []);
});

test('changing a group mode applies it to the Sessions the group owns, and tells the operator when one refuses', async t => {
  const f = await fixture(t);
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.create('user', 'bob', { groupId: 'default' });
  await f.store.create('user', 'carol', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  await f.store.update('user:bob', { sessionId: 'session-b' });
  await f.store.update('user:carol', { sessionId: 'session-gone' });
  f.states.set('session-a', { state: 'bound' });
  f.states.set('session-b', { state: 'bound' });
  f.states.set('session-gone', { state: 'archived' });

  const result = await f.apply([{ op: 'group.update', id: 'default', patch: { permission: 'danger-full-access' } }]);
  assert.equal(result.ok, true, result.error);
  assert.equal(f.store.group('default').permission, 'danger-full-access');
  assert.deepEqual(f.sets.sort((a, b) => a.sessionId.localeCompare(b.sessionId)), [
    { sessionId: 'session-a', mode: 'danger-full-access' },
    { sessionId: 'session-b', mode: 'danger-full-access' },
  ], 'archived Sessions are left alone');

  // Saving the same mode again touches nothing.
  f.sets.length = 0;
  assert.equal((await f.apply([{ op: 'group.update', id: 'default', patch: { name: '改名' } }])).ok, true);
  assert.deepEqual(f.sets, []);

  // A refusing Session does not undo the group edit, but the operator hears of it.
  f.deps.permissions.apply = async () => { throw new Error('无法设置'); };
  const refused = await f.apply([{ op: 'group.update', id: 'default', patch: { permission: 'read-only' } }]);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /分组已保存.*2 个会话.*无法设置/);
  assert.equal(f.store.group('default').permission, 'read-only');
});

test('group edits refuse a mode DSH does not know', async t => {
  const f = await fixture(t);
  for (const permission of ['root', '', 7, 'auto']) {
    const result = await f.apply([{ op: 'group.update', id: 'default', patch: { permission } }]);
    assert.equal(result.ok, false, String(permission));
  }
  assert.equal(f.store.group('default').permission, 'read-only');
  f.deps.permissions = { catalog: () => ({ available: true, modes: ['read-only'] }), async apply() {} };
  const result = await f.apply([{ op: 'group.update', id: 'default', patch: { permission: 'danger-full-access' } }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /没有这个权限模式/);
});

test('a member edit targets only the exact bound Session and is never stored on the membership', async t => {
  const f = await fixture(t);
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.create('user', 'bob', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  await f.store.update('user:bob', { sessionId: 'session-b' });
  f.states.set('session-a', { state: 'bound' });
  f.states.set('session-b', { state: 'bound' });
  const edit = (key, sessionId, permission) => f.apply([{ op: 'member.permission', key, sessionId, permission }]);

  assert.equal((await edit('user:alice', 'session-a', 'workspace-write')).ok, true);
  assert.deepEqual(f.sets, [{ sessionId: 'session-a', mode: 'workspace-write' }], 'bob is untouched');
  assert.equal(f.store.group('default').permission, 'read-only', 'and so is the group');
  assert.equal('sessionPermission' in f.store.get('user:alice'), false);

  f.sets.length = 0;
  for (const [key, sessionId, permission, pattern] of [
    ['user:alice', 'session-b', 'workspace-write', /已变化/],
    ['user:nobody', 'session-a', 'workspace-write', /已变化/],
    ['nope', 'session-a', 'workspace-write', /无法识别/],
    ['user:alice', 'session-a', 'root', /工作区权限只能是/],
  ]) {
    const result = await edit(key, sessionId, permission);
    assert.equal(result.ok, false, `${key} ${sessionId} ${permission}`);
    assert.match(result.error, pattern);
  }
  f.states.set('session-a', { state: 'archived' });
  assert.match((await edit('user:alice', 'session-a', 'read-only')).error, /已不可用/);
  assert.deepEqual(f.sets, [], 'a refused edit never reaches DSH');
});

test('the view reports the access each Session runs under, live from DSH', async t => {
  const f = await fixture(t);
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  f.deps.provisioner.describe = async () => ({ title: 'T', state: 'bound', workspace: 'W', workspacePath: '/workspace', running: false, permission: 'workspace-write' });
  const [group] = (await f.view()).groups;
  assert.equal(group.permission, 'read-only');
  assert.equal(group.members[0].sessionPermission, 'workspace-write', 'what the Session runs under, not what the group says');
});

test('the catalog reads the Session permission from the wire view or the folded knobs', () => {
  const read = permissions => sessionPermission({ sessionId: 's', projections: { values: { permissions } } });
  assert.equal(read({ currentValue: 'read-only' }), 'read-only');
  assert.equal(read({ preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask', seeded: true }), 'workspace-write');
  assert.equal(read({ preset: null, sandbox: 'read-only', approval: 'ask' }), 'read-only', 'matched by the knobs when no preset was recorded');
  assert.equal(read({ preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' }), 'danger-full-access');
  assert.equal(read({ preset: 'read-only', sandbox: 'danger-full-access', approval: 'never' }), 'danger-full-access', 'a stale preset name never wins over the knobs');
  assert.equal(read({ preset: null, sandbox: 'read-only', approval: 'never' }), 'custom');
  assert.equal(read({ preset: 'auto', sandbox: 'danger-full-access', approval: 'ask' }), 'auto');
  assert.equal(read(null), undefined);
  assert.equal(sessionPermission({ sessionId: 's' }), undefined);
  const catalog = buildCatalog([{ sessionId: 's1', updatedAt: 1, running: false, blank: false, projections: { values: { title: 'A', permissions: { currentValue: 'workspace-write' } } } }], undefined, 1);
  assert.equal(catalog.get('s1').permission, 'workspace-write');
});

test('the permission service sets a live Session through DSH, resuming a cold one first', async () => {
  const ctx = fakeHost({ sessions: [] });
  const service = createPermissionService({ ctx, sessionController: ctx.sessionController });
  assert.deepEqual(service.catalog(), { available: true, modes: MODES });
  ctx.rows.push({ sessionId: 'live', updatedAt: 1, running: false, blank: false });
  ctx.liveSessions.set('live', { id: 'live' });
  await service.apply('live', 'workspace-write');
  assert.deepEqual(ctx.permissionSets, [{ sessionId: 'live', name: 'workspace-write' }]);
  assert.deepEqual(ctx.agentResolutions, [], 'a live Session needs no resume');
  await service.apply('cold', 'read-only');
  assert.deepEqual(ctx.agentResolutions, ['cold'], 'a cold Session is resumed to get its live object');
  assert.deepEqual(ctx.permissionSets.at(-1), { sessionId: 'cold', name: 'read-only' });
  await assert.rejects(service.apply('live', 'root'), /没有「root」权限模式/);
});

test('the permission service says so when DSH has no service, or when DSH refuses', async () => {
  const none = fakeHost({ permissionPresets: false });
  const absent = createPermissionService({ ctx: none, sessionController: none.sessionController });
  assert.deepEqual(absent.catalog(), { available: false, modes: [] });
  await assert.rejects(absent.apply('s', 'read-only'), /没有权限模式服务/);

  const failing = fakeHost({ permissionError: new Error('nope') });
  const journal = [];
  const service = createPermissionService({ ctx: failing, sessionController: failing.sessionController, journal: { write: record => journal.push(record) } });
  failing.liveSessions.set('s', { id: 's' });
  await assert.rejects(service.apply('s', 'read-only'), /无法设置工作区权限：nope/);
  assert.equal(journal.at(-1).level, 'warn');
});
