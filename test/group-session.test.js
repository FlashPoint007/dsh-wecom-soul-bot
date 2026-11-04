import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createStore } from '../dist/host/store.js';
import { createSessionProvisioner } from '../dist/host/sessions.js';
import { createRouter } from '../dist/host/routing.js';
import { applyStoreOps, buildRoutingView } from '../dist/host/groups-view.js';

const groupModel = { provider: 'p', model: 'base', reasoningEffort: 'low' };
const customModel = { provider: 'p', model: 'custom', reasoningEffort: 'high' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wecom-history-'));
  const store = createStore({ directory, onError: error => assert.fail(String(error)) });
  t.after(async () => {
    await store.flush();
    assert.equal(dirname(directory), tmpdir().replace(/\/$/, ''));
    assert.ok(basename(directory).startsWith('wecom-history-'));
    await rm(directory, { recursive: true, force: true });
  });
  await store.load();
  const states = new Map();
  const selected = [];
  const created = [];
  const choices = [
    { provider: 'p', model: 'base', name: 'Base', efforts: [{ id: 'low', name: '低' }] },
    { provider: 'p', model: 'custom', name: 'Custom', efforts: [{ id: 'high', name: '高' }] },
  ];
  const models = {
    snapshot: () => ({ choices }),
    known: selection => choices.some(choice => choice.provider === selection.provider && choice.model === selection.model),
    async select(id, selection) { selected.push({ id, selection }); return selection; },
  };
  const workspaces = {
    async resolve(path) { return { id: path || '/workspace', path: path || '/workspace' }; },
    async describe(path) { return { path: path || '/workspace', title: 'Workspace', registered: true }; },
  };
  const catalogs = {
    invalidate() {},
    async load() { return {
      get(id) {
        const state = states.get(id);
        return state?.state === 'bound' ? { title: id, group: { title: 'Workspace', path: state.path }, running: false } : undefined;
      },
      getBlank(id) {
        const state = states.get(id);
        return state?.state === 'blank' ? { title: id, group: { title: 'Workspace', path: state.path }, running: false } : undefined;
      },
      hiddenReason: id => states.get(id)?.state === 'bound' ? undefined : states.get(id)?.state ?? 'missing',
      titleOf: id => id,
    }; },
  };
  const provisioner = createSessionProvisioner({
    bindings: store, bindingKey: binding => `${binding.kind}:${binding.id}`, workspaces, models, catalogs,
    sessionController: {
      async create(request) {
        const sessionId = `created-${created.length + 1}`;
        created.push(request);
        states.set(sessionId, { state: 'bound', path: request.workspaceId });
        return { sessionId };
      },
    },
  });
  const router = createRouter({ store, provisioner });
  const deps = { store, provisioner, workspaces, models, catalogs, router, isAdmin: () => false };
  return { store, states, selected, created, provisioner, router, deps, directory,
    apply: ops => applyStoreOps(deps, ops), view: () => buildRoutingView(deps) };
}

for (const kind of ['user', 'group']) {
  for (const method of ['create', 'update']) {
    test(`${method}: switching a ${kind} back restores only its own per-group Session and survives reload`, async t => {
      const f = await fixture(t);
      const other = await f.store.createGroup('Other');
      const key = `${kind}:principal`;
      await f.store.create(kind, 'principal', { groupId: 'default' });
      await f.store.update(key, { sessionId: 'session-a', sessionSelection: customModel });
      const move = groupId => method === 'create'
        ? f.store.create(kind, 'principal', { groupId }) : f.store.update(key, { groupId, sessionId: 'untrusted' });
      assert.equal((await move(other.id)).sessionId, '');
      await f.store.update(key, { sessionId: 'session-b' });
      const restored = await move('default');
      assert.equal(restored.sessionId, 'session-a');
      assert.deepEqual(restored.sessionSelection, customModel);
      await f.store.flush();
      const reloaded = createStore({ directory: f.directory });
      await reloaded.load();
      assert.equal((await reloaded.update(key, { groupId: other.id })).sessionId, 'session-b');
      await reloaded.flush();
      await f.store.remove(key);
      assert.equal((await f.store.create(kind, 'principal', { groupId: 'default' })).sessionId, '', 'revocation forgets old membership history');
      await f.store.create(kind, 'someone-else', { groupId: 'default' });
      assert.equal(f.store.get(`${kind}:someone-else`).sessionId, '', 'history is never shared with another principal');
    });
  }
}

test('a Workspace edit invalidates inactive history even if the Workspace is later changed back', async t => {
  const f = await fixture(t);
  const other = await f.store.createGroup('Other');
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  await f.store.update('user:alice', { groupId: other.id });
  await f.store.updateGroup('default', { workspace: '/changed' });
  await f.store.updateGroup('default', { workspace: '' });
  assert.equal((await f.store.update('user:alice', { groupId: 'default' })).sessionId, '');
});

for (const state of ['bound', 'blank', 'archived', 'missing', 'subagent']) {
  test(`page group switch restores ${state} history only when usable`, async t => {
    const f = await fixture(t);
    const other = await f.store.createGroup('Other');
    await f.store.create('user', 'alice', { groupId: 'default' });
    await f.store.update('user:alice', { sessionId: 'session-a' });
    f.states.set('session-a', { state, path: '/workspace' });
    await f.apply([{ op: 'member.update', key: 'user:alice', patch: { groupId: other.id } }]);
    const result = await f.apply([{ op: 'member.update', key: 'user:alice', patch: { groupId: 'default' } }]);
    assert.equal(result.ok, true);
    assert.equal(f.store.get('user:alice').sessionId, ['bound', 'blank'].includes(state) ? 'session-a' : '');
    assert.equal(f.created.length, 0, 'switching itself never creates a Session');
    const binding = f.store.get('user:alice');
    await f.provisioner.ensure(binding, f.store.group('default'));
    assert.equal(f.created.length, ['bound', 'blank'].includes(state) ? 0 : 1);
  });
}

test('a remembered Session moved to another Workspace is not rebound', async t => {
  const f = await fixture(t);
  const other = await f.store.createGroup('Other');
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  await f.store.update('user:alice', { groupId: other.id });
  f.states.set('session-a', { state: 'bound', path: '/elsewhere' });
  await f.apply([{ op: 'member.update', key: 'user:alice', patch: { groupId: 'default' } }]);
  assert.equal(f.store.get('user:alice').sessionId, '');
});

test('a restored candidate becomes routable only after its validation finishes', async t => {
  const f = await fixture(t);
  const other = await f.store.createGroup('Other');
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  await f.store.update('user:alice', { groupId: other.id });
  f.states.set('session-a', { state: 'bound', path: '/workspace' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = f.deps.provisioner.describe;
  f.deps.provisioner.describe = async (...args) => { await gate; return original(...args); };
  const pending = f.apply([{ op: 'member.update', key: 'user:alice', patch: { groupId: 'default' } }]);
  await new Promise(resolve => setImmediate(resolve));
  const during = f.store.get('user:alice');
  assert.equal(during.groupId, other.id, 'the move is not committed while validation is in flight');
  assert.equal(during.sessionId, '', 'so no unvalidated Session can be routed to');
  release();
  assert.equal((await pending).ok, true);
  assert.equal(f.store.get('user:alice').sessionId, 'session-a');
});

test('an unreadable target Workspace refuses the switch and keeps the old membership', async t => {
  const f = await fixture(t);
  const other = await f.store.createGroup('Other');
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  await f.store.update('user:alice', { groupId: other.id });
  f.states.set('session-a', { state: 'bound', path: '/workspace' });
  const original = f.deps.workspaces.describe;
  f.deps.workspaces.describe = async path => {
    if (!path) throw new Error('目录不可用');
    return original(path);
  };
  const result = await f.apply([{ op: 'member.update', key: 'user:alice', patch: { groupId: 'default' } }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /目录不可用/);
  assert.equal(f.store.get('user:alice').groupId, other.id, 'the old membership remains');
  assert.equal(f.store.get('user:alice').sessionId, '', 'and nothing was bound in the target group');
  await f.store.flush();
  const reloaded = createStore({ directory: f.directory });
  await reloaded.load();
  assert.equal(reloaded.get('user:alice').groupId, other.id);
});

test('per-Session model editing survives reuse and return but does not affect other members or replacements', async t => {
  const f = await fixture(t);
  await f.store.updateGroup('default', groupModel);
  const other = await f.store.createGroup('Other');
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.create('user', 'bob', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  await f.store.update('user:bob', { sessionId: 'session-b' });
  f.states.set('session-a', { state: 'bound', path: '/workspace' });
  f.states.set('session-b', { state: 'bound', path: '/workspace' });
  const result = await f.apply([{ op: 'member.model', key: 'user:alice', sessionId: 'session-a', selection: customModel }]);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(f.store.get('user:alice').sessionSelection, customModel);
  assert.equal(f.store.get('user:bob').sessionSelection, undefined);
  assert.equal(f.store.group('default').model, 'base');
  assert.deepEqual((await f.view()).groups[0].members.find(row => row.id === 'alice').sessionSelection, customModel);
  await f.store.update('user:alice', { groupId: other.id });
  await f.apply([{ op: 'member.update', key: 'user:alice', patch: { groupId: 'default' } }]);
  assert.deepEqual(f.store.get('user:alice').sessionSelection, customModel);
  await f.provisioner.ensure(f.store.get('user:alice'), f.store.group('default'));
  await f.router.reapplyGroup('default');
  assert.equal(f.selected.some(row => row.id === 'session-a' && row.selection.model === 'base'), false);
  assert.equal(f.selected.some(row => row.id === 'session-b' && row.selection.model === 'base'), true);
  f.states.set('session-a', { state: 'archived', path: '/workspace' });
  await f.provisioner.ensure(f.store.get('user:alice'), f.store.group('default'));
  assert.equal(f.store.get('user:alice').sessionSelection, undefined);
  assert.deepEqual(f.selected.at(-1).selection, groupModel, 'replacement uses group defaults');
});

test('model edits reject wrong Session ids, malformed models and unsupported efforts before side effects', async t => {
  const f = await fixture(t);
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  f.states.set('session-a', { state: 'bound', path: '/workspace' });
  for (const patch of [
    { sessionId: 'old-session', selection: customModel },
    { selection: { provider: 'p', model: 'missing' } },
    { selection: { provider: 'p', model: 'custom', reasoningEffort: 'low' } },
    { selection: { provider: 42, model: 'custom' } },
  ]) {
    const result = await f.apply([{ op: 'member.model', key: 'user:alice', sessionId: 'session-a', ...patch }]);
    assert.equal(result.ok, false);
  }
  assert.deepEqual(f.selected, []);
});

test('an asynchronous model update cannot save its override onto a replacement binding', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await f.store.create('user', 'alice', { groupId: 'default' });
  await f.store.update('user:alice', { sessionId: 'session-a' });
  f.states.set('session-a', { state: 'bound', path: '/workspace' });
  let resume;
  let entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  f.deps.provisioner.applyModel = async () => { entered(); await gate; return customModel; };
  const operation = f.apply([{ op: 'member.model', key: 'user:alice', sessionId: 'session-a', selection: customModel }]);
  await ready;
  await f.store.update('user:alice', { sessionId: 'session-new' });
  resume();
  const result = await operation;
  assert.equal(result.ok, false);
  assert.equal(f.store.get('user:alice').sessionId, 'session-new');
  assert.equal(f.store.get('user:alice').sessionSelection, undefined);
});
