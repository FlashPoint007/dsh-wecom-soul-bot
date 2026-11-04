import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStoreOps, buildRoutingView } from '../dist/host/groups-view.js';
import { createStore } from '../dist/host/store.js';
import { createObservationStore } from '../dist/host/observation.js';
import { createWorkspaceService } from '../dist/host/workspaces.js';
import { fakeHost, scratchDirectory, TEST_WORKSPACE_PATH } from './helpers.js';

const silent = { warn() {} };

/** A view context with a real store, the fake Workspace registry and a catalog-free provisioner. */
async function context(extra = {}) {
  const ctx = fakeHost({ workspaces: [] });
  const store = createStore({ directory: scratchDirectory(), onError: () => {} });
  await store.load();
  const workspaces = createWorkspaceService({
    registry: () => ctx.registry,
    defaultPath: TEST_WORKSPACE_PATH,
    log: silent,
  });
  const provisioner = {
    desired: group => (group.provider && group.model
      ? { provider: group.provider, model: group.model, ...(group.reasoningEffort ? { reasoningEffort: group.reasoningEffort } : {}) }
      : undefined),
    describe: extra.describe ?? (async sessionId => ({
      title: `标题 ${sessionId}`, state: 'bound', workspace: '企业微信', workspacePath: TEST_WORKSPACE_PATH, running: false,
    })),
  };
  const observations = extra.observations ?? createObservationStore();
  // The roster the page reads; `null` means this deployment has no registry.
  const presets = extra.presets === null ? undefined : {
    snapshot: () => presetView,
    async load() { return presetView; },
    known: id => presetView.presets.some(preset => preset.id === id),
  };
  const presetView = extra.presets ?? { presets: [{ id: 'standard', isDefault: true }, { id: 'ptc', isDefault: false }], fetchedAt: 1 };
  // Archiving reaches DSH through this seam; `null` means the deployment has none.
  const archived = [];
  const ops = extra.ops === null ? undefined : {
    async archive(sessionId) {
      if (extra.archiveError) throw extra.archiveError;
      archived.push(sessionId);
    },
  };
  const deps = {
    store, provisioner, workspaces, observations, presets, ops,
    models: { snapshot: () => undefined }, catalogs: { async load() { throw new Error('unused'); } },
    isAdmin: user => user === 'root',
  };
  return {
    ctx, store, observations, workspaces, archived,
    view: () => buildRoutingView(deps),
    apply: ops => applyStoreOps(deps, ops),
  };
}

test('the default group comes first, then the others oldest first, and members sort by activity', async () => {
  const { store, view } = await context();
  await store.createGroup('先建');
  const later = await store.createGroup('后来');
  await store.updateGroup(later.id, { workspace: TEST_WORKSPACE_PATH });
  await store.create('user', 'quiet', { groupId: 'default', label: '安静' });
  await store.create('user', 'active', { groupId: 'default', label: '活跃' });
  await store.create('group', 'chat-1', { groupId: 'default' });
  await store.load();

  const routing = await view();
  assert.deepEqual(routing.groups.map(group => group.name), ['默认分组', '先建', '后来']);
  assert.equal(routing.total, 3);
  assert.equal(routing.full, false);
  const [first] = routing.groups;
  assert.equal(first.isDefault, true);
  assert.equal(first.memberCount, 3);
  assert.equal(first.workspacePath, TEST_WORKSPACE_PATH, 'the plugin Workspace is resolved for a group that configures none');
  assert.equal(first.workspaceTitle, '企业微信');
  assert.deepEqual(first.members.map(member => member.displayName), ['chat-1', '安静', '活跃'],
    'a note replaces the id, and members fall back to name order without activity');
});

test('a group reports the model its members will use, and the DSH default when it picks none', async () => {
  const { store, view } = await context();
  const guests = await store.createGroup('客人');
  await store.updateGroup(guests.id, { provider: 'p', model: 'm', reasoningEffort: 'low' });
  await store.load();
  const routing = await view();
  const picked = routing.groups.find(group => group.id === guests.id);
  assert.equal(picked.effectiveProvider, 'p');
  assert.equal(picked.effectiveModel, 'm');
  assert.equal(picked.effectiveReasoningEffort, 'low');
  const fallback = routing.groups.find(group => group.isDefault);
  assert.deepEqual([fallback.effectiveProvider, fallback.effectiveModel], ['', ''],
    'no model means the page shows 「跟随 DSH 默认模型」');
});

test('member rows carry the activity the observation store saw, and an unresolvable Workspace is reported', async () => {
  let clock = 1000;
  const observations = createObservationStore({ now: () => clock });
  const { store, view } = await context({ observations });
  await store.create('user', 'alice', { groupId: 'default' });
  await store.create('user', 'bob', { groupId: 'default' });
  await store.updateGroup('default', { workspace: '/definitely/not/here' });
  await store.load();
  observations.record({ chat: 'alice', user: 'alice', chatType: 'single', accepted: true, text: 'hi' });
  clock = 2000;
  observations.record({ chat: 'alice', user: 'alice', chatType: 'single', accepted: true, text: 'again' });
  observations.record({ chat: 'bob', user: 'bob', chatType: 'single', accepted: true });

  const routing = await view();
  const [group] = routing.groups;
  assert.match(group.workspaceError, /Workspace 目录不存在或不是目录/);
  assert.equal(group.workspaceTitle, '企业微信', 'the plugin Workspace stands in while the configured one is broken');
  assert.equal(group.memberCount, 2);
  assert.equal(group.messages, 3);
  assert.equal(group.lastSeenAt, 2000);
  assert.deepEqual(group.members.map(member => [member.displayName, member.messages, member.lastSeenAt]),
    [['alice', 2, 2000], ['bob', 1, 2000]]);
  assert.equal(group.members[0].sessionState, 'auto');
});

test('a member of another group is not listed, and an administrator flag follows the user id', async () => {
  const { store, view } = await context();
  const guests = await store.createGroup('客人');
  await store.create('user', 'root', { groupId: guests.id });
  await store.load();
  const routing = await view();
  assert.deepEqual(routing.groups.find(group => group.isDefault).members, [],
    'a member of another group is not listed here');
  const [member] = routing.groups.find(group => group.id === guests.id).members;
  assert.equal(member.admin, true, 'the administrator flag is a property of the person');
});

test('a note is a property of the person, not of the membership', async () => {
  const { store, view, apply } = await context();
  await store.create('user', 'alice', { groupId: 'default' });

  // An administrator who is in no group still has a name the page can show.
  assert.deepEqual(await apply([{ op: 'label.set', key: 'user:root', label: ' 运维 ' }]).then(result => result.ok), true);
  assert.equal(store.label('user:root'), '运维');

  // The member's note is edited the same way, and it outlives the membership.
  await apply([{ op: 'label.set', key: 'user:alice', label: '爱丽丝' }]);
  assert.equal((await view()).groups[0].members[0].displayName, '爱丽丝');
  await apply([{ op: 'member.remove', key: 'user:alice' }]);
  assert.equal(store.label('user:alice'), '爱丽丝');
  await store.create('user', 'alice', { groupId: 'default' });
  assert.equal((await view()).groups[0].members[0].label, '爱丽丝', 're-authorizing keeps the note');

  // Clearing it, and refusing what a note cannot be.
  assert.deepEqual((await apply([{ op: 'label.set', key: 'user:root', label: '' }])).ok, true);
  assert.equal(store.label('user:root'), '');
  const bad = await apply([{ op: 'label.set', key: 'nope', label: 'x' }]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /无法识别的人员 id/);
  const multiline = await apply([{ op: 'label.set', key: 'user:root', label: '两\u0000行' }]);
  assert.equal(multiline.ok, false);
  assert.match(multiline.error, /单行/);
});

test('a group preset is validated against the DSH roster', async () => {
  const { store, apply, view } = await context();
  assert.equal((await view()).groups[0].preset, '', 'a new group follows the DSH default');
  assert.equal((await apply([{ op: 'group.update', id: 'default', patch: { preset: 'ptc' } }])).ok, true);
  assert.equal(store.group('default').preset, 'ptc');
  assert.equal((await view()).groups[0].preset, 'ptc');

  const unknown = await apply([{ op: 'group.update', id: 'default', patch: { preset: 'nope' } }]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /没有 preset nope/);
  assert.equal(store.group('default').preset, 'ptc', 'a rejected edit leaves the group alone');

  assert.equal((await apply([{ op: 'group.update', id: 'default', patch: { preset: '' } }])).ok, true);
  assert.equal(store.group('default').preset, '');

  // A deployment without a preset registry cannot judge ids, so it accepts them.
  const bare = await context({ presets: null });
  assert.equal((await bare.apply([{ op: 'group.update', id: 'default', patch: { preset: 'anything' } }])).ok, true);
});

test('a member row reports the preset and context of the Session it owns', async () => {
  const describe = async sessionId => ({
    title: `标题 ${sessionId}`, state: 'bound', workspace: '企业微信', workspacePath: TEST_WORKSPACE_PATH,
    running: true, model: { provider: 'p', model: 'm' }, preset: 'ptc',
    context: { used: 12_000, window: 200_000 },
  });
  const { store, view } = await context({ describe });
  await store.create('user', 'alice', { groupId: 'default' });
  await store.update('user:alice', { sessionId: 's1' });
  const [member] = (await view()).groups[0].members;
  assert.equal(member.sessionPreset, 'ptc');
  assert.deepEqual(member.sessionContext, { used: 12_000, window: 200_000 });
  assert.equal(member.sessionRunning, true);
});

test('archiving a member Session is one op: DSH archives it and the binding is cleared', async () => {
  const { store, apply, archived } = await context();
  await store.create('user', 'alice', { groupId: 'default' });
  await store.update('user:alice', { sessionId: 's1' });

  const result = await apply([{ op: 'member.archive', key: 'user:alice' }]);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(archived, ['s1']);
  assert.equal(store.get('user:alice').sessionId, '', 'the next message creates a fresh Session');

  // Nothing to archive, an unknown principal and a DSH refusal are all explained.
  const twice = await apply([{ op: 'member.archive', key: 'user:alice' }]);
  assert.equal(twice.ok, false);
  assert.match(twice.error, /还没有会话可以归档/);
  const unknown = await apply([{ op: 'member.archive', key: 'user:nobody' }]);
  assert.match(unknown.error, /成员不存在/);

  const refused = await context({ archiveError: new Error('会话正在运行，无法归档') });
  await refused.store.create('user', 'alice', { groupId: 'default' });
  await refused.store.update('user:alice', { sessionId: 's1' });
  const failed = await refused.apply([{ op: 'member.archive', key: 'user:alice' }]);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /无法归档/);
  assert.equal(refused.store.get('user:alice').sessionId, 's1', 'a refused archive keeps the binding');

  const bare = await context({ ops: null });
  await bare.store.create('user', 'alice', { groupId: 'default' });
  await bare.store.update('user:alice', { sessionId: 's1' });
  assert.match((await bare.apply([{ op: 'member.archive', key: 'user:alice' }])).error, /不支持归档会话/);
});

test('a created group reports its id, and an authorization reports who was let in', async () => {
  const { apply } = await context();
  const added = await apply([{ op: 'group.add', name: '朋友' }]);
  assert.equal(added.ok, true);
  assert.ok(added.createdGroupId, 'the page opens the new group form with this id');

  const authorized = await apply([{ op: 'member.add', groupId: 'default', kind: 'user', id: 'alice' }]);
  assert.deepEqual(authorized.authorized, [{ kind: 'user', id: 'alice', groupId: 'default' }],
    'the Host greets exactly the principals it authorized');
  const moved = await apply([{ op: 'member.update', key: 'user:alice', patch: { groupId: 'default' } }]);
  assert.equal(moved.authorized, undefined, 'moving somebody is not an authorization');
});

test('a settings edit reports exactly the administrators it promoted', async () => {
  const { apply } = await context();
  const first = await apply([{ op: 'settings.set', patch: { adminUserIds: ['root'] } }]);
  assert.deepEqual(first.promotedAdmins, ['root']);
  const second = await apply([{ op: 'settings.set', patch: { adminUserIds: ['root', 'second'] } }]);
  assert.deepEqual(second.promotedAdmins, ['second'], 'only the person added is promoted');
  const untouched = await apply([{ op: 'settings.set', patch: { remoteApprovals: true } }]);
  assert.equal(untouched.promotedAdmins, undefined, 'a patch that does not name the list promotes nobody');
  const removed = await apply([{ op: 'settings.set', patch: { adminUserIds: [] } }]);
  assert.equal(removed.promotedAdmins, undefined, 'removal is not a promotion');
});

test('joining and moving groups are reported for notification, while a repeat add is not', async () => {
  const { apply } = await context();
  const joined = await apply([{ op: 'member.add', groupId: 'default', kind: 'user', id: 'alice' }]);
  assert.deepEqual(joined.authorized, [{ kind: 'user', id: 'alice', groupId: 'default' }]);
  const repeat = await apply([{ op: 'member.add', groupId: 'default', kind: 'user', id: 'alice' }]);
  assert.equal(repeat.authorized, undefined, 'an existing member is not greeted twice');
  assert.equal(repeat.assigned, undefined);

  const friends = await apply([{ op: 'group.add', name: '朋友' }]);
  const moved = await apply([
    { op: 'member.update', key: 'user:alice', patch: { groupId: friends.createdGroupId } },
  ]);
  assert.deepEqual(moved.assigned, [{
    kind: 'user', id: 'alice', groupId: friends.createdGroupId, previousGroupId: 'default',
  }]);
  const back = await apply([{ op: 'member.add', groupId: 'default', kind: 'user', id: 'alice' }]);
  assert.deepEqual(back.assigned, [{
    kind: 'user', id: 'alice', groupId: 'default', previousGroupId: friends.createdGroupId,
  }], 're-adding a known member into another group is a move');
  assert.equal(back.authorized, undefined, 'and not a first authorization');
});

test('a batch that fails later still reports the settings and authorizations it applied', async () => {
  const { store, apply } = await context();
  const result = await apply([
    { op: 'settings.set', patch: { adminUserIds: ['root'] } },
    { op: 'member.add', groupId: 'default', kind: 'user', id: 'alice' },
    { op: 'settings.set', patch: { questionTimeoutMs: 1 } },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.settingsChanged, true);
  assert.deepEqual(result.promotedAdmins, ['root']);
  assert.deepEqual(result.authorized, [{ kind: 'user', id: 'alice', groupId: 'default' }]);
  assert.deepEqual(store.settings().adminUserIds, ['root'], 'the earlier edit stays applied');
  assert.ok(store.get('user:alice'), 'and so does the authorization before the failing op');
});

test('notifications describe only the final net assignment of a batch', async () => {
  const { store, apply } = await context();
  const group = await store.createGroup('朋友');
  const removed = await apply([
    { op: 'settings.set', patch: { adminUserIds: ['temporary'] } },
    { op: 'settings.set', patch: { adminUserIds: [] } },
    { op: 'member.add', kind: 'user', id: 'temporary', groupId: 'default' },
    { op: 'member.remove', key: 'user:temporary' },
  ]);
  assert.equal(removed.ok, true);
  assert.equal(removed.authorized, undefined);
  assert.equal(removed.promotedAdmins, undefined);
  const joined = await apply([
    { op: 'member.add', kind: 'user', id: 'alice', groupId: 'default' },
    { op: 'member.update', key: 'user:alice', patch: { groupId: group.id } },
  ]);
  assert.deepEqual(joined.authorized, [{ kind: 'user', id: 'alice', groupId: group.id }]);
  assert.equal(joined.assigned, undefined, 'first authorization greets the user in their final group');
  const returned = await apply([
    { op: 'member.update', key: 'user:alice', patch: { groupId: 'default' } },
    { op: 'member.update', key: 'user:alice', patch: { groupId: group.id } },
  ]);
  assert.equal(returned.assigned, undefined, 'no misleading move notification for a round trip');
});

test('the Workspace list counts live Sessions only', async () => {
  const { ctx, workspaces } = await context();
  ctx.registry.rows.push({ id: 'w9', path: '/w/live', title: 'Live', sessionIds: ['s1', 's2', 's3'] });
  ctx.registry.archivedSessionIds.push('s2', 's3');
  const listed = workspaces.list().find(workspace => workspace.title === 'Live');
  assert.deepEqual([listed.sessionCount, listed.archivedSessionCount], [1, 2]);
});

/* ------------------------------------------------------------------ *
 * settings.set: the settings block, edited through the same ops route *
 * as the groups it now shares a document with                         *
 * ------------------------------------------------------------------ */

test('a settings edit is applied to the store and reported as such', async () => {
  const { store, apply } = await context();
  const result = await apply([
    { op: 'settings.set', patch: { adminUserIds: ['root', 'second'], adminWorkspaces: ['/w/a'] } },
    { op: 'settings.set', patch: { remoteApprovals: true, questionTimeoutMs: 45000, logEnabled: false } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.settingsChanged, true);
  assert.equal(result.changed, 2);
  assert.deepEqual(store.settings().adminUserIds, ['root', 'second']);
  assert.deepEqual(store.settings().adminWorkspaces, ['/w/a']);
  assert.equal(store.settings().remoteApprovals, true);
  assert.equal(store.settings().questionTimeoutMs, 45000);
  assert.equal(store.settings().logEnabled, false);
  assert.equal(store.settings().logRetentionDays, 14, 'a field the patch omitted keeps its value');
});

test('a settings patch that cannot be used is refused before it reaches the store', async () => {
  const { store, apply } = await context();
  const cases = [
    [{ wsUrl: 'ws://plaintext.example' }, /wss:\/\//, 'a plaintext endpoint is not an endpoint'],
    [{ wsUrl: 'wss://user:pass@openws.example' }, /wss:\/\//, 'a credentialed endpoint is refused too'],
    [{ questionTimeoutMs: 999 }, /等待企微回复/, 'below the documented minimum'],
    [{ questionTimeoutMs: 300001 }, /等待企微回复/, 'above the documented maximum'],
    [{ logRetentionDays: 0 }, /日志保留天数/, 'not a day'],
    [{ logRetentionDays: 1.5 }, /日志保留天数/, 'not a whole day'],
    [{ adminUserIds: [42] }, /userid/, 'not an id at all'],
    [{ adminUserIds: [''] }, /userid/, 'an empty id is not an id'],
    [{ adminWorkspaces: [null] }, /Workspace 路径/, 'a scope entry must be a path'],
    [{ remoteApprovals: 'yes' }, /远程审批/, 'a switch is on or off'],
    [{ logEnabled: 1 }, /对话日志/, 'a switch is on or off'],
    [{ logRetentionDays: 7, nope: true }, /无法识别的设置项/, 'an unknown field is a version mismatch, not a typo to ignore'],
  ];
  for (const [patch, pattern, why] of cases) {
    const result = await apply([{ op: 'settings.set', patch }]);
    assert.equal(result.ok, false, why);
    assert.match(result.error, pattern, why);
    assert.equal(result.changed, 0, why);
  }
  assert.equal(store.settings().wsUrl, '', 'nothing was half-applied');
  assert.equal(store.settings().questionTimeoutMs, 60000);
});

test('a refused settings patch does not stop the ops that precede it', async () => {
  const { store, apply } = await context();
  const result = await apply([
    { op: 'settings.set', patch: { adminUserIds: ['root'] } },
    { op: 'settings.set', patch: { questionTimeoutMs: 1 } },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.changed, 1);
  assert.deepEqual(store.settings().adminUserIds, ['root'], 'the accepted op stays applied');
  assert.equal(store.settings().questionTimeoutMs, 60000, 'the refused one changed nothing');
});
