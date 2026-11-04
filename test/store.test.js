import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bindingKey, bindingKeyFor, createStore, normalizeLabel, parseBindingKey, validBindingId,
} from '../dist/host/store.js';
import { createSessionProvisioner, SessionBindingChangedError } from '../dist/host/sessions.js';
import { createRouter } from '../dist/host/routing.js';

const directory = async () => await mkdtemp(join(tmpdir(), 'wecom-store-'));
const fail = () => assert.fail('no error expected');

test('keys are namespaced by kind, and only valid WeCom ids are accepted', () => {
  assert.equal(bindingKey('user', 'alice'), 'user:alice');
  assert.equal(bindingKey('group', 'chat-1'), 'group:chat-1');
  assert.equal(bindingKeyFor({ chat: 'alice', user: 'alice', chatType: 'single' }), 'user:alice');
  assert.equal(bindingKeyFor({ chat: 'chat-1', user: 'alice', chatType: 'group' }), 'group:chat-1');
  assert.deepEqual(parseBindingKey('group:chat-1'), { kind: 'group', id: 'chat-1' });
  assert.deepEqual(parseBindingKey('user:a:b'), { kind: 'user', id: 'a:b' });
  assert.equal(parseBindingKey('nope:1'), undefined);
  assert.equal(parseBindingKey(''), undefined);
  assert.equal(validBindingId('alice'), true);
  assert.equal(validBindingId('  '), false);
  assert.equal(validBindingId('bad\nid'), false);
  assert.equal(validBindingId('x'.repeat(513)), false);
  assert.equal(validBindingId(42), false);
});

test('a note is one bounded line, or nothing at all', () => {
  assert.equal(normalizeLabel('  张三  '), '张三');
  assert.equal(normalizeLabel('张\n三'), '张 三');
  assert.equal(normalizeLabel('a'.repeat(200)).length, 60);
  assert.equal(normalizeLabel('bad\u0000note'), '');
  assert.equal(normalizeLabel(42), '');
  assert.equal(normalizeLabel(null), '');
});

test('the default group always exists and cannot be removed', async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  assert.deepEqual(store.groups().map(group => group.id), ['default']);
  assert.equal(store.group('default').name, '默认分组');
  assert.deepEqual(await store.removeGroup('default'), { ok: false, removed: 0 });
  assert.equal(store.group('default').id, 'default');
  // It is created in memory, so a file only appears once something is written.
  assert.equal(await store.updateGroup('default', { workspace: '/srv/app' }) !== undefined, true);
  await store.flush();
  const parsed = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(parsed.version, '0.5');
  assert.deepEqual(parsed.groups.map(group => group.id), ['default']);
});

test('groups are created, renamed and described', async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, now: () => 1000, onError: fail });
  await store.load();
  const created = await store.createGroup('  朋友  ');
  assert.equal(created.name, '朋友');
  assert.equal(created.workspace, '');
  assert.notEqual(created.id, 'default');
  assert.equal(store.groups().length, 2);
  assert.equal(await store.updateGroup('default', { name: '  默认  ' }).then(group => group.name), '默认');
  assert.equal(await store.updateGroup('default', { name: '   ' }).then(group => group.name), '默认', 'a blank rename keeps the old name');
  assert.equal(await store.updateGroup('nope', { name: 'x' }), undefined);
  assert.deepEqual(store.groups().map(group => group.name).sort(), ['朋友', '默认'].sort());
});

test('a member is created once per principal and survives a reload', async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  const group = await store.createGroup('客人');
  const first = await store.create('user', 'alice', { groupId: group.id, label: '爱丽丝' });
  assert.equal(first.kind, 'user');
  assert.equal(first.id, 'alice');
  assert.equal(first.groupId, group.id);
  assert.equal(first.sessionId, '');
  assert.equal(store.label('user:alice'), '爱丽丝', 'a note typed while authorizing belongs to the person');
  const again = await store.create('user', 'alice', { groupId: 'default', label: '爱丽丝' });
  assert.equal(again.sessionId, '', 'the same row, moved rather than duplicated');
  assert.equal(again.groupId, 'default');
  await store.create('group', 'chat-1', { groupId: 'default' });
  await store.update('user:alice', { sessionId: 'session-1' });
  await store.setLabel('user:alice', ' 新备注 ');
  await store.flush();
  assert.deepEqual(store.bindings().map(record => `${record.kind}:${record.id}`), ['user:alice', 'group:chat-1']);
  assert.equal(store.label('user:alice'), '新备注');
  assert.deepEqual(store.inGroup('default').map(record => record.id), ['alice', 'chat-1']);
  const raw = await readFile(store.file, 'utf8');
  assert.match(raw, /\n$/, 'the file ends with a newline');
  assert.equal((await stat(store.file)).mode & 0o777, 0o600, 'the file is private to the user');

  const reloaded = createStore({ directory: dir, onError: fail });
  await reloaded.load();
  assert.deepEqual(reloaded.bindings().map(record => record.sessionId), ['session-1', '']);
  assert.equal(reloaded.label('user:alice'), '新备注', 'notes are durable');
  assert.deepEqual(reloaded.forSession('session-1').map(record => record.id), ['alice']);
  assert.deepEqual(reloaded.groups().map(group => group.name).sort(), ['客人', '默认分组'].sort());
  assert.equal(reloaded.full(), false);
});

test('deleting a group de-authorizes its members and keeps the others', async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  const guests = await store.createGroup('客人');
  await store.create('user', 'alice', { groupId: 'default' });
  await store.create('user', 'bob', { groupId: guests.id });
  await store.create('group', 'chat-1', { groupId: guests.id });
  assert.deepEqual(await store.removeGroup(guests.id), { ok: true, removed: 2 });
  assert.deepEqual(store.bindings().map(record => record.id), ['alice']);
  assert.deepEqual(store.groups().map(group => group.id), ['default']);
});

test('the store refuses to grow past its cap instead of dropping the oldest silently', async () => {
  const dir = await directory();
  const errors = [];
  const store = createStore({ directory: dir, maxEntries: 2, onError: (error, stage) => errors.push(stage) });
  await store.load();
  await store.create('user', 'a', { groupId: 'default' });
  await store.create('user', 'b', { groupId: 'default' });
  assert.equal(store.full(), true);
  await assert.rejects(store.create('user', 'c', { groupId: 'default' }), /limit/);
  assert.deepEqual(store.bindings().map(record => record.id), ['a', 'b']);
  assert.deepEqual(errors, ['limit']);
  assert.equal(store.get('user:c'), undefined);
});

test('group creation is capped too', async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, maxGroups: 2, onError: fail });
  await store.load();
  await store.createGroup('a');
  await assert.rejects(store.createGroup('b'), /group limit/);
  assert.equal(store.groups().length, 2);
});

test('an unreadable file is quarantined instead of being overwritten', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'settings.json'), '{ not json', { mode: 0o600 });
  const stages = [];
  const store = createStore({ directory: dir, onError: (error, stage) => stages.push(stage) });
  await store.load();
  assert.deepEqual(store.bindings(), []);
  assert.deepEqual(stages, ['parse']);
  await stat(join(dir, 'settings.json.corrupt'));
  await store.create('user', 'alice', { groupId: 'default' });
  assert.equal(store.bindings().length, 1);
  assert.equal(store.group('default').id, 'default');
});

test('a file of another version is set aside instead of being read or overwritten', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'settings.json'), JSON.stringify({
    version: 5,
    groups: [{ id: 'default', name: '默认分组' }],
    bindings: [{ kind: 'user', id: 'alice', groupId: 'default', sessionId: 's1' }],
    labels: { 'user:alice': '爱丽丝' },
  }));
  const stages = [];
  const store = createStore({ directory: dir, onError: (error, stage) => stages.push(stage) });
  await store.load();
  assert.deepEqual(store.bindings(), [], 'nothing from an unread file is trusted');
  assert.equal(store.group('default').name, '默认分组');
  assert.deepEqual(stages, ['version']);
  // The old integer counter is exactly the file v0.4.1 wrote, so it must be
  // parked under its own name rather than read as the current layout.
  await stat(join(dir, 'settings.json.v5'));
  await assert.rejects(stat(join(dir, 'settings.json')), 'the old file is moved, not clobbered');

  // Starting fresh writes the current version and keeps the old file around.
  await store.create('user', 'bob', { groupId: 'default' });
  await store.flush();
  const parsed = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(parsed.version, '0.5');
  assert.deepEqual(parsed.bindings.map(record => record.id), ['bob']);
  await stat(join(dir, 'settings.json.v5'));
});

test('a version string is never allowed to choose the path it is parked under', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: '../../escape', bindings: [] }));
  const store = createStore({ directory: dir, onError: () => {} });
  await store.load();
  assert.deepEqual(store.bindings(), []);
  assert.deepEqual((await readdir(dir)).filter(name => name !== 'settings.json'), ['settings.json.v.._.._escape']);
});

test("an administrator's default Workspace is stored as a { workspace } object", async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  await store.setAdminWorkspace('root', '/srv/orion');
  await store.flush();
  const parsed = JSON.parse(await readFile(store.file, 'utf8'));
  assert.deepEqual(parsed.adminDefaults, { root: { workspace: '/srv/orion' } }, 'an object, so more can join later');

  const reloaded = createStore({ directory: dir, onError: fail });
  await reloaded.load();
  assert.equal(reloaded.adminWorkspace('root'), '/srv/orion');

  await reloaded.setAdminWorkspace('root', '');
  await reloaded.flush();
  assert.deepEqual(JSON.parse(await readFile(store.file, 'utf8')).adminDefaults, {}, 'clearing drops the entry');

  // A bare string is the shape this layout never shipped with; it is ignored
  // rather than half-guessed, exactly like an unknown file version.
  await writeFile(store.file, JSON.stringify({
    version: '0.5', adminDefaults: { alice: '/srv/old' }, groups: [], bindings: [], labels: {},
  }));
  const strict = createStore({ directory: dir, onError: fail });
  await strict.load();
  assert.equal(strict.adminWorkspace('alice'), '');
});

test('a group keeps its Workspace, model, effort and preset across a reload', async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  const guests = await store.createGroup('客人');
  await store.updateGroup(guests.id, {
    workspace: '/srv/app', provider: 'p', model: 'm', reasoningEffort: 'low', preset: 'standard',
  });
  await store.flush();

  const reloaded = createStore({ directory: dir, onError: fail });
  await reloaded.load();
  const group = reloaded.group(guests.id);
  assert.deepEqual(
    [group.workspace, group.provider, group.model, group.reasoningEffort, group.preset],
    ['/srv/app', 'p', 'm', 'low', 'standard'],
  );
  assert.equal(reloaded.group('default').preset, '', 'a group that picks none follows the DSH default');
  // The preset is trimmed like every other group field.
  assert.equal((await reloaded.updateGroup(guests.id, { preset: '  ptc  ' })).preset, 'ptc');
  await reloaded.createGroup('空');
  assert.equal(reloaded.groups().at(-1).preset, '');
});

test('corrupt entries and duplicates are dropped while loading', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'settings.json'), JSON.stringify({
    version: '0.5',
    groups: [{ id: 'g1', name: ' 朋友 ' }, { id: 'g1', name: '重复' }, null, { id: 'x'.repeat(80) }, { name: '没有 id' }],
    bindings: [
      { kind: 'user', id: 'alice', groupId: 'missing', sessionId: 'session-1', createdAt: 1, updatedAt: 2 },
      { kind: 'user', id: 'alice', groupId: 'g1', sessionId: 'session-2', createdAt: 3, updatedAt: 4 },
      { kind: 'nonsense', id: 'x', createdAt: 1, updatedAt: 2 },
      { kind: 'group', id: 'bad\nid', createdAt: 1, updatedAt: 2 },
      null,
      { kind: 'group', id: ' chat-1 ', groupId: 'g1', createdAt: 'x', updatedAt: 2 },
      { kind: 'user', id: 'nobody', groupId: 'g1' },
    ],
  }));
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  assert.deepEqual(store.bindings().map(record => `${record.kind}:${record.id}`),
    ['user:alice', 'group:chat-1', 'user:nobody']);
  assert.equal(store.get('user:alice').sessionId, 'session-1', 'the first record wins');
  assert.equal(store.get('user:alice').groupId, 'default', 'a member never points at a missing group');
  assert.equal(store.get('group:chat-1').createdAt, 0, 'an unusable timestamp becomes 0');
  assert.deepEqual(store.groups().map(group => group.name).sort(), ['朋友', '默认分组'].sort(), 'a duplicate group id is ignored');
  assert.equal(await store.remove('user:alice'), true);
  assert.equal(await store.remove('user:alice'), false);
  assert.equal(await store.update('user:nonexistent', { sessionId: 'x' }), undefined);
  assert.deepEqual(store.bindings().map(record => record.id), ['chat-1', 'nobody']);
});

test('a note belongs to the person: it survives removal, deletion and having no group', async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  const guests = await store.createGroup('客人');
  await store.create('user', 'alice', { groupId: guests.id, label: '爱丽丝' });
  assert.equal(await store.setLabel('user:alice', '  爱丽丝  '), '爱丽丝');

  // Removing the membership (or deleting the whole group) must not forget who
  // Alice is: the settings page still shows her under her note.
  assert.equal(await store.remove('user:alice'), true);
  assert.equal(store.label('user:alice'), '爱丽丝');
  await store.create('user', 'bob', { groupId: guests.id, label: '鲍勃' });
  await store.removeGroup(guests.id);
  assert.equal(store.label('user:bob'), '鲍勃');

  // An administrator who belongs to no group has a note too.
  await store.setLabel('user:root', '运维');
  await store.setLabel('user:root', '   ');
  assert.equal(store.label('user:root'), '', 'a blank note clears it');
  assert.equal(store.label('user:nobody'), '');

  await store.setLabel('user:root', '运维');
  const reloaded = createStore({ directory: dir, onError: fail });
  await reloaded.load();
  assert.equal(reloaded.label('user:alice'), '爱丽丝');
  assert.equal(reloaded.label('user:bob'), '鲍勃');
  assert.equal(reloaded.label('user:root'), '运维');
  assert.deepEqual(reloaded.bindings(), [], 'notes outlive every membership');
});

test('a move to an unknown group keeps the current membership', async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  const guests = await store.createGroup('客人');
  await store.create('user', 'alice', { groupId: guests.id });
  assert.equal((await store.update('user:alice', { groupId: 'nope' })).groupId, guests.id);
  assert.equal((await store.create('user', 'bob', { groupId: 'nope' })).groupId, 'default');
});

for (const kind of ['user', 'group']) {
  for (const mutation of ['create', 'update']) {
    test(`${mutation}: moving a ${kind} detaches its Session, preserves its note and survives reload`, async () => {
      const dir = await directory();
      const store = createStore({ directory: dir, now: () => 1000, onError: fail });
      await store.load();
      const target = await store.createGroup('新分组');
      const key = bindingKey(kind, 'principal');
      const original = await store.create(kind, 'principal', { groupId: 'default', label: '保留备注' });
      await store.update(key, { sessionId: 'old-session' });
      const same = mutation === 'create'
        ? await store.create(kind, 'principal', { groupId: 'default' })
        : await store.update(key, { groupId: 'default' });
      assert.equal(same.sessionId, 'old-session', 'a same-group write does not detach');
      const moved = mutation === 'create'
        ? await store.create(kind, 'principal', { groupId: target.id })
        : await store.update(key, { groupId: target.id, sessionId: 'old-session' });
      assert.equal(moved.groupId, target.id);
      assert.equal(moved.sessionId, '', 'a move wins over a Session id in the same patch');
      assert.equal(moved.createdAt, original.createdAt);
      assert.equal(store.label(key), '保留备注');
      assert.deepEqual(store.forSession('old-session'), []);
      await store.flush();
      const reloaded = createStore({ directory: dir, onError: fail });
      await reloaded.load();
      assert.equal(reloaded.get(key).groupId, target.id);
      assert.equal(reloaded.get(key).sessionId, '');
      assert.equal(reloaded.label(key), '保留备注');
    });
  }
}

test('same-group and unknown-group patches preserve Sessions unless explicitly replaced', async () => {
  const store = createStore({ directory: await directory(), onError: fail });
  await store.load();
  await store.create('user', 'alice', { groupId: 'default' });
  await store.update('user:alice', { sessionId: 'session-1' });
  assert.equal((await store.update('user:alice', { groupId: 'default' })).sessionId, 'session-1');
  assert.equal((await store.update('user:alice', { groupId: 'missing' })).sessionId, 'session-1');
  assert.equal((await store.update('user:alice', { groupId: 'default', sessionId: ' session-2 ' })).sessionId, 'session-2');
  await store.flush();
});

test('expected binding updates refuse stale snapshots, including same-timestamp ABA and reauthorization', async () => {
  const store = createStore({ directory: await directory(), now: () => 1000, onError: fail });
  await store.load();
  const target = await store.createGroup('其他分组');
  const original = await store.create('user', 'alice', { groupId: 'default' });
  await store.update('user:alice', { groupId: target.id });
  await store.update('user:alice', { groupId: 'default' });
  assert.deepEqual(store.get('user:alice'), original, 'values and timestamps can return to the original snapshot');
  assert.equal(await store.update('user:alice', { sessionId: 'stale' }, original), undefined);
  assert.equal(store.get('user:alice').sessionId, '');
  const beforeRemoval = store.get('user:alice');
  await store.remove('user:alice');
  assert.equal(await store.update('user:alice', { sessionId: 'stale' }, beforeRemoval), undefined);
  await store.create('user', 'alice', { groupId: 'default' });
  assert.deepEqual(store.get('user:alice'), beforeRemoval);
  assert.equal(await store.update('user:alice', { sessionId: 'stale' }, beforeRemoval), undefined);
  const current = store.get('user:alice');
  const updated = await store.update('user:alice', { sessionId: 'current' }, current);
  assert.equal(updated.sessionId, 'current', 'the exact current row admits the write');
  await store.flush();
});

// Provisioner/router tests live here because there are no separate sessions or
// routing test files. Deferred seams exercise real store CAS without timers.
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function testProvisioner(store, hooks = {}) {
  return createSessionProvisioner({
    bindings: store,
    bindingKey: binding => bindingKey(binding.kind, binding.id),
    sessionController: {
      create: hooks.create ?? (async () => ({ sessionId: 'created-session' })),
      async selectModel() { assert.fail('models.select is the provisioner seam'); },
    },
    workspaces: {
      resolve: hooks.resolve ?? (async path => ({ id: 'workspace-id', path: path || '/workspace' })),
    },
    catalogs: {
      load: hooks.load ?? (async () => ({ hiddenReason: () => undefined })),
    },
    models: { select: hooks.select ?? (async (_id, selection) => selection) },
  });
}

for (const kind of ['user', 'group']) {
  for (const edit of ['move', 'remove', 'rebind', 'reauthorize']) {
    test(`Session creation cannot overwrite a ${kind} binding during ${edit}`, async () => {
      const store = createStore({ directory: await directory(), now: () => 1000, onError: fail });
      await store.load();
      const target = await store.createGroup('新分组');
      const binding = await store.create(kind, 'principal', { groupId: 'default', label: '备注' });
      const key = bindingKey(kind, 'principal');
      const entered = deferred();
      const complete = deferred();
      const provisioner = testProvisioner(store, {
        async create() {
          entered.resolve();
          await complete.promise;
          return { sessionId: 'old-group-session' };
        },
      });
      const pending = provisioner.ensure(binding, store.group('default'));
      const rejected = assert.rejects(pending, SessionBindingChangedError);
      await entered.promise;
      if (edit === 'move') await store.update(key, { groupId: target.id });
      if (edit === 'remove' || edit === 'reauthorize') await store.remove(key);
      if (edit === 'reauthorize') await store.create(kind, 'principal', { groupId: 'default' });
      if (edit === 'rebind') await store.update(key, { sessionId: 'operator-session' });
      const operatorBinding = store.get(key);
      complete.resolve();
      await rejected;
      assert.equal(store.get(key), operatorBinding, 'the in-flight create does not touch the new membership');
      assert.notEqual(store.get(key)?.sessionId, 'old-group-session');
      assert.equal(store.label(key), '备注');
      await store.flush();
      const reloaded = createStore({ directory: dirname(store.file), onError: fail });
      await reloaded.load();
      assert.deepEqual(reloaded.get(key), operatorBinding, 'the operator edit wins durably');
    });
  }
}

test('binding CAS also guards edits between the provisioner check and the store mutation', async () => {
  const store = createStore({ directory: await directory(), onError: fail });
  await store.load();
  const target = await store.createGroup('新分组');
  const binding = await store.create('user', 'alice', { groupId: 'default' });
  const provisioner = createSessionProvisioner({
    bindings: {
      get: key => store.get(key),
      async update(key, patch, expected) {
        await store.update(key, { groupId: target.id });
        return await store.update(key, patch, expected);
      },
    },
    bindingKey: binding => bindingKey(binding.kind, binding.id),
    sessionController: { async create() { return { sessionId: 'stale' }; } },
    workspaces: { async resolve() { return { id: 'w', path: '/workspace' }; } },
    catalogs: { async load() { return { hiddenReason: () => undefined }; } },
    models: { async select(_id, selection) { return selection; } },
  });
  await assert.rejects(provisioner.ensure(binding, store.group('default')), SessionBindingChangedError);
  assert.equal(store.get('user:alice').groupId, target.id);
  assert.equal(store.get('user:alice').sessionId, '');
  await store.flush();
});

test('reusing a Session refuses a binding changed during catalog or model awaits', async () => {
  for (const stage of ['catalog', 'model']) {
    const store = createStore({ directory: await directory(), onError: fail });
    await store.load();
    const target = await store.createGroup('新分组');
    await store.updateGroup('default', { provider: 'p', model: 'm' });
    await store.create('user', 'alice', { groupId: 'default' });
    const binding = await store.update('user:alice', { sessionId: 'existing-session' });
    const entered = deferred();
    const complete = deferred();
    const provisioner = testProvisioner(store, {
      async load() {
        if (stage === 'catalog') { entered.resolve(); await complete.promise; }
        return { hiddenReason: () => undefined };
      },
      async select(_id, selection) {
        if (stage === 'model') { entered.resolve(); await complete.promise; }
        return selection;
      },
    });
    const pending = provisioner.ensure(binding, store.group('default'));
    const rejected = assert.rejects(pending, SessionBindingChangedError);
    await entered.promise;
    await store.update('user:alice', { groupId: target.id });
    complete.resolve();
    await rejected;
    assert.equal(store.get('user:alice').sessionId, '');
    await store.flush();
  }
});

test('routing refuses an old-group Session after an operator moves or removes its binding', async () => {
  for (const edit of ['move', 'remove']) {
    const store = createStore({ directory: await directory(), onError: fail });
    await store.load();
    const target = await store.createGroup('新分组');
    await store.create('user', 'alice', { groupId: 'default' });
    const entered = deferred();
    const complete = deferred();
    const provisioner = testProvisioner(store, {
      async create() {
        entered.resolve();
        await complete.promise;
        return { sessionId: 'old-group-session' };
      },
    });
    const router = createRouter({ store, provisioner });
    const pending = router.route({ chat: 'alice', user: 'alice', chatType: 'single' }, 'default');
    await entered.promise;
    if (edit === 'move') await store.update('user:alice', { groupId: target.id });
    else await store.remove('user:alice');
    complete.resolve();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.sessionId, undefined, 'the current message is not submitted to the abandoned Session');
    assert.match(result.message, /变更|变化/);
    assert.equal(result.binding, store.get('user:alice'));
    await store.flush();
  }
});

test('routing never creates or restores a missing membership', async () => {
  const store = createStore({ directory: await directory(), onError: fail });
  await store.load();
  const router = createRouter({
    store,
    provisioner: testProvisioner(store, { async create() { assert.fail('an absent member cannot create a Session'); } }),
  });
  const parts = { chat: 'alice', user: 'alice', chatType: 'single' };
  assert.equal((await router.route(parts, 'default')).ok, false);
  assert.equal(store.get('user:alice'), undefined);
  await store.create('user', 'alice', { groupId: 'default' });
  await store.remove('user:alice');
  const result = await router.route(parts, 'default');
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, undefined);
  assert.equal(store.get('user:alice'), undefined, 'routing does not undo the operator removal');
  await store.flush();
});

test('routing re-checks the exact provisioned binding before returning a successful route', async () => {
  const store = createStore({ directory: await directory(), onError: fail });
  await store.load();
  await store.create('user', 'alice', { groupId: 'default' });
  await store.update('user:alice', { sessionId: 'existing-session' });
  const provisioner = testProvisioner(store);
  const router = createRouter({
    store,
    provisioner: {
      ...provisioner,
      async ensure(binding, group) {
        const resolved = await provisioner.ensure(binding, group);
        await store.remove('user:alice');
        return resolved;
      },
    },
  });
  const result = await router.route({ chat: 'alice', user: 'alice', chatType: 'single' }, 'default');
  assert.equal(result.ok, false);
  assert.equal(result.binding, undefined);
  assert.equal(result.sessionId, undefined);
  await store.flush();
});

for (const kind of ['user', 'group']) {
  test(`the next ${kind} route after a move uses only the new group's creation defaults`, async () => {
    const store = createStore({ directory: await directory(), onError: fail });
    await store.load();
    const target = await store.createGroup('新分组');
    await store.updateGroup(target.id, { workspace: '/new-workspace', preset: 'new-preset', provider: 'p', model: 'm' });
    await store.create(kind, 'principal', { groupId: 'default', label: '备注' });
    const key = bindingKey(kind, 'principal');
    await store.update(key, { sessionId: 'old-session' });
    await store.update(key, { groupId: target.id, sessionId: 'old-session' });
    const calls = [];
    const provisioner = testProvisioner(store, {
      async resolve(path) { calls.push(['workspace', path]); return { id: 'new-workspace', path }; },
      async create(request) { calls.push(['create', request]); return { sessionId: 'new-session' }; },
      async select(id, selection) { calls.push(['model', id, selection]); return selection; },
    });
    const router = createRouter({ store, provisioner });
    const parts = kind === 'group'
      ? { chat: 'principal', user: 'sender', chatType: 'group' }
      : { chat: 'principal', user: 'principal', chatType: 'single' };
    const result = await router.route(parts, 'default');
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.sessionId, 'new-session');
    assert.equal(result.group.id, target.id, 'the current membership wins over the caller fallback group');
    assert.equal(result.binding, store.get(key), 'the bridge receives the exact current snapshot');
    assert.deepEqual(calls, [
      ['workspace', '/new-workspace'],
      ['create', { workspaceId: 'new-workspace', agentPreset: 'new-preset' }],
      ['model', 'new-session', { provider: 'p', model: 'm' }],
    ]);
    assert.equal(store.label(key), '备注');
    await store.flush();
  });
}

test('creation refuses a binding moved while resolving its Workspace or applying its new Session model', async () => {
  for (const stage of ['workspace', 'model']) {
    const store = createStore({ directory: await directory(), onError: fail });
    await store.load();
    const target = await store.createGroup('新分组');
    await store.updateGroup('default', { provider: 'p', model: 'm' });
    const binding = await store.create('user', 'alice', { groupId: 'default' });
    const entered = deferred();
    const complete = deferred();
    let creates = 0;
    const provisioner = testProvisioner(store, {
      async resolve(path) {
        if (stage === 'workspace') { entered.resolve(); await complete.promise; }
        return { id: 'w', path };
      },
      async create() { creates++; return { sessionId: 'new-session' }; },
      async select(_id, selection) {
        if (stage === 'model') { entered.resolve(); await complete.promise; }
        return selection;
      },
    });
    const pending = provisioner.ensure(binding, store.group('default'));
    const rejected = assert.rejects(pending, SessionBindingChangedError);
    await entered.promise;
    await store.update('user:alice', { groupId: target.id });
    complete.resolve();
    await rejected;
    assert.equal(creates, stage === 'workspace' ? 0 : 1);
    assert.equal(store.get('user:alice').groupId, target.id);
    assert.equal(store.get('user:alice').sessionId, '');
    await store.flush();
  }
});

test('a fresh store tolerates a missing directory and creates it privately', async () => {
  const dir = await directory();
  await chmod(dir, 0o700);
  const store = createStore({ directory: join(dir, 'nested', 'here'), onError: fail });
  await store.load();
  await store.create('user', 'alice', { groupId: 'default' });
  await store.flush();
  const parsed = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(parsed.bindings.length, 1);
  assert.equal(parsed.groups.length, 1);
});

/* ------------------------------------------------------------------ *
 * The settings block: everything the operator edits but the           *
 * connection identity, in the same document as the groups             *
 * ------------------------------------------------------------------ */

test('a fresh store starts from the documented settings defaults', async () => {
  const store = createStore({ directory: await directory(), onError: fail });
  await store.load();
  assert.deepEqual(store.settings(), {
    wsUrl: '',
    adminUserIds: [],
    adminWorkspaces: [],
    questionTimeoutMs: 60000,
    remoteApprovals: true,
    logEnabled: true,
    logRetentionDays: 14,
  });
  assert.equal(store.file.endsWith('settings.json'), true, 'the plugin owns one document');
});

test('a settings edit merges, and an explicit empty list clears a list', async () => {
  const store = createStore({ directory: await directory(), onError: fail });
  await store.load();
  await store.setSettings({ adminUserIds: ['root'] });
  await store.setSettings({ remoteApprovals: true });
  await store.setSettings({ adminWorkspaces: ['/w/a', '/w/a', ' '] });
  const settings = store.settings();
  assert.deepEqual(settings.adminUserIds, ['root'], 'an earlier patch survives a later one');
  assert.equal(settings.remoteApprovals, true);
  assert.deepEqual(settings.adminWorkspaces, ['/w/a']);
  // `[]` is a value the operator chose, not a missing field.
  await store.setSettings({ adminUserIds: [] });
  assert.deepEqual(store.settings().adminUserIds, []);
  assert.equal(store.settings().remoteApprovals, true, 'the fields the patch omitted are untouched');
});

test('settings share the file with the groups and survive a reload', async () => {
  const dir = await directory();
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  await store.setSettings({ wsUrl: 'wss://openws.example', questionTimeoutMs: 120000, logRetentionDays: 3 });
  await store.createGroup('朋友');
  await store.flush();
  const parsed = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(parsed.settings.wsUrl, 'wss://openws.example');
  assert.equal(parsed.settings.questionTimeoutMs, 120000);
  assert.equal(parsed.groups.length, 2, 'one document holds both');
  const reloaded = createStore({ directory: dir, onError: fail });
  await reloaded.load();
  assert.equal(reloaded.settings().wsUrl, 'wss://openws.example');
  assert.equal(reloaded.settings().logRetentionDays, 3);
  assert.equal(reloaded.groups().length, 2);
});

test('hand-edited settings are re-typed and clamped, never trusted', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'settings.json'), JSON.stringify({
    version: '0.5',
    settings: {
      wsUrl: 42,
      adminUserIds: ['root', 'root', '', 7, '  root2  '],
      adminWorkspaces: 'not-an-array',
      questionTimeoutMs: 10 ** 9,
      remoteApprovals: 'yes',
      logEnabled: 0,
      logRetentionDays: 0,
    },
    groups: [], bindings: [], labels: {}, adminDefaults: {},
  }));
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  const settings = store.settings();
  assert.equal(settings.wsUrl, '', 'a non-string endpoint is not an endpoint');
  assert.deepEqual(settings.adminUserIds, ['root', 'root2']);
  assert.deepEqual(settings.adminWorkspaces, []);
  assert.equal(settings.questionTimeoutMs, 300000, 'clamped to the documented maximum');
  assert.equal(settings.remoteApprovals, true, 'legacy approval flags never disable scoped administrator interactions');
  assert.equal(settings.logEnabled, true, 'only a real false turns the journal off');
  assert.equal(settings.logRetentionDays, 1, 'clamped to the documented minimum');
});

test('a file without a settings block keeps its groups and gets the defaults', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'settings.json'), JSON.stringify({
    version: '0.5',
    groups: [{ id: 'g1', name: '朋友', workspace: '/srv/app' }],
    bindings: [{ kind: 'user', id: 'alice', groupId: 'g1', sessionId: 's1' }],
    labels: { 'user:alice': '爱丽丝' },
    adminDefaults: {},
  }));
  const store = createStore({ directory: dir, onError: fail });
  await store.load();
  assert.deepEqual(store.settings(), {
    wsUrl: '',
    adminUserIds: [],
    adminWorkspaces: [],
    questionTimeoutMs: 60000,
    remoteApprovals: true,
    logEnabled: true,
    logRetentionDays: 14,
  });
  assert.equal(store.group('g1').name, '朋友');
  assert.equal(store.label('user:alice'), '爱丽丝');
});
