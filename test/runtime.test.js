import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config, inject } from '../dist/host/index.js';
import { createRuntime } from '../dist/host/runtime.js';
import { storeRoute } from '../dist/host/routes.js';
import { fakeClient, fakeHost, finishedSession, frame, memoryJournal, settle, until, writeStore } from './helpers.js';

// Every runtime in this file must own a throwaway DSH home: the store writes
// <DSH home>/wecom-soul-bot/settings.json next to the real plugin's data. Tests that
// persist settings, groups or members get one of their own, so they never see
// each other's file.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-home-')));
process.env.DSH_HOME = HOME;

/** Run one test against a private DSH home. */
async function withHome(run) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-home-')));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
}

function hostWithServices(overrides = {}) {
  const ctx = fakeHost({
    workspaces: [{ id: 'w1', path: '/w/alpha', title: 'Alpha', sessionIds: ['s1'] }],
  });
  const routes = new Map();
  const reads = [];
  Object.assign(ctx, {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    connection: {
      fetch: {
        register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; },
      },
    },
    credentials: { async resolve(ref) { reads.push(ref); return { value: 'TOP-SECRET-VALUE' }; } },
    ...overrides,
  });
  return { ctx, reads, routes };
}

const silent = { info() {}, warn() {}, error() {} };
const post = (ops) => new Request('http://localhost/api/wecom-soul-bot/store', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }),
});

test('Config carries the connection identity, and nothing else', () => {
  const config = Config({});
  assert.equal(config.botId.get(), '');
  assert.equal(config.secretEnv.get(), 'WECOM_SOUL_BOT_SECRET');
  assert.equal('secret' in config, false, 'the Secret itself only ever lives in the credential store');
  // Everything the operator edits lives in the plugin's own document, so an edit
  // is a store write and never a Config write: no profile rewrite, no reconnect.
  for (const moved of [
    'adminUserIds', 'adminWorkspaces', 'wsUrl', 'questionTimeoutMs', 'remoteApprovals',
    'logEnabled', 'logRetentionDays',
  ]) {
    assert.equal(moved in config, false, `${moved} moved to the plugin store`);
  }
  for (const gone of ['chatIds', 'allowedUserIds', 'defaultWorkspace', 'defaultProvider', 'defaultModel', 'defaultReasoningEffort']) {
    assert.equal(gone in config, false, `${gone} moved to the plugin store`);
  }
  assert.deepEqual(inject, ['credentials', 'sessionController', 'connection', 'systemPrompt', 'tools']);
});

test('a plaintext or credentialed WebSocket URL is refused before the Secret is read', () => withHome(async home => {
  // The endpoint is store state now, written before the runtime reads it — the
  // same way the ⑤ card writes it while the plugin is running.
  await writeStore(home, { settings: { wsUrl: 'ws://plaintext.example' } });
  const { ctx, reads } = hostWithServices();
  const journal = memoryJournal();
  const runtime = createRuntime({
    ctx, journal, log: silent,
    config: Config({ botId: 'bot' }),
    createClient: () => assert.fail('must not connect'),
  });
  await runtime.start();
  assert.deepEqual(reads, [], 'an unusable endpoint is refused before the Secret is touched');
  assert.equal(runtime.status.connection().phase, 'invalid');
  await runtime.stop();
}));

test('runtime connects with the resolved Secret, never logs it, and serves the full state', () => withHome(async home => {
  await writeStore(home, { settings: { adminUserIds: ['root'] } });
  const { ctx } = hostWithServices();
  const client = fakeClient();
  let options;
  const journal = memoryJournal(['TOP-SECRET-VALUE']);
  const runtime = createRuntime({
    ctx, journal, log: silent,
    config: Config({ botId: 'bot' }),
    createClient: value => { options = value; return client; },
  });
  await runtime.start();
  await runtime.store.load();
  await runtime.store.updateGroup('default', { provider: 'deepseek-account', model: 'deepseek-reasoner' });
  await runtime.store.create('user', 'alice', { groupId: 'default' });
  assert.equal(options.secret, 'TOP-SECRET-VALUE');
  assert.equal(runtime.status.connection().phase, 'connecting');
  client.emit('authenticated');
  assert.equal(runtime.status.connection().phase, 'online');
  options.logger.error('Authentication failed: errcode=1, errmsg=bad TOP-SECRET-VALUE');
  assert.match(runtime.status.connection().detail, /认证失败/);
  assert.doesNotMatch(runtime.status.connection().detail, /TOP-SECRET-VALUE/);
  const applied = journal.find('config.applied')[0];
  assert.equal(applied.secretConfigured, true);
  assert.deepEqual(applied.adminUserIds, ['root']);
  assert.equal(JSON.stringify(journal.records).includes('TOP-SECRET-VALUE'), false);

  client.emit('message', frame('hi', { chat: 'alice', user: 'alice' }));
  await until(() => ctx.prompts.length > 0);
  // A Session is "blank" until its first turn starts, so DSH hides it from the
  // catalog; the page's first read (and its refresh button) force the rebuild.
  const cached = await runtime.state();
  assert.deepEqual(cached.sessions.groups.map(group => group.title), ['Alpha', '未分组'],
    'the blank Session is hidden until the turn starts');
  const state = await runtime.state({ refresh: true });
  assert.equal(state.version, '0.5');
  assert.deepEqual(state.sessions.groups.map(group => group.title).sort(), ['Alpha', '未分组', '企业微信'].sort());
  assert.deepEqual(state.rejected, []);
  assert.equal(state.traffic.prompts, 1, 'the first message created a Session and prompted it');
  const [group] = state.routing.groups;
  assert.equal(group.id, 'default');
  assert.equal(group.isDefault, true);
  assert.equal(group.name, '默认分组');
  assert.equal(group.memberCount, 1);
  assert.equal(group.workspacePath, join(home, 'wecom-soul-bot', 'workspace'));
  assert.equal(group.effectiveModel, 'deepseek-reasoner');
  const [member] = group.members;
  assert.equal(member.key, 'user:alice');
  assert.equal(member.sessionState, 'bound');
  assert.equal(member.sessionId, ctx.prompts[0].sessionId);
  assert.equal(member.sessionModel.provider, 'deepseek-account');
  assert.deepEqual(state.models.choices.map(choice => choice.model), ['deepseek-chat', 'deepseek-reasoner']);
  assert.deepEqual(state.admins, [{ id: 'root', label: '', displayName: 'root' }]);
  assert.deepEqual(state.workspaces.map(workspace => workspace.title).sort(), ['Alpha', '企业微信'].sort());
  assert.deepEqual(state.notices, [], 'an unscoped administrator is the documented default, not a problem');
  await runtime.stop();
}));

test('the store route creates groups, authorizes senders and validates every edit', () => withHome(async home => {
  {
    const { ctx, routes } = hostWithServices();
    ctx.effect = fn => { void fn(); };
    // No Bot ID: this test exercises the routes, and an unconfigured plugin
    // never builds a client (a real one would dial the WeCom endpoint).
    apply(ctx, Config({}));
    await settle();
    const route = routes.get('/api/wecom-soul-bot/store');
    assert.ok(route, 'the routing route is registered');
    assert.deepEqual(route.methods, ['POST']);

    const created = await route.fetch(post([{ op: 'member.add', groupId: 'default', kind: 'user', id: 'ZhangSan', label: ' 张三 ' }]));
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.ok, true);
    assert.equal(body.routing.total, 1);
    const [member] = body.routing.groups[0].members;
    assert.equal(member.key, 'user:ZhangSan');
    assert.equal(member.displayName, '张三');
    assert.equal(member.sessionState, 'auto');
    assert.equal(body.routing.groups[0].workspaceTitle, '企业微信');
    assert.equal(body.routing.groups[0].workspacePath, join(home, 'wecom-soul-bot', 'workspace'));

    // The default group's Workspace can be pointed at an existing directory.
    const moved = await route.fetch(post([{ op: 'group.update', id: 'default', patch: { workspace: home } }]));
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).routing.groups[0].workspacePath, home);
    assert.equal(ctx.registry.rows.at(-1).path, home, 'the Workspace was registered on demand');

    // A second group, and a member moved into it.
    const grouped = await route.fetch(post([{ op: 'group.add', name: '朋友' }]));
    const added = await grouped.json();
    const guests = added.routing.groups.find(item => item.name === '朋友');
    assert.ok(guests, 'the new group is in the response');
    const movedMember = await route.fetch(post([{ op: 'member.update', key: 'user:ZhangSan', patch: { groupId: guests.id } }]));
    assert.equal(movedMember.status, 200);
    const routing = (await movedMember.json()).routing;
    assert.deepEqual(routing.groups.map(item => [item.name, item.memberCount]), [['默认分组', 0], ['朋友', 1]]);

    // Unknown Workspaces, groups, members and models are refused with an explanation.
    const badWorkspace = await route.fetch(post([{ op: 'group.update', id: 'default', patch: { workspace: '/does/not/exist' } }]));
    assert.equal(badWorkspace.status, 422);
    assert.match((await badWorkspace.json()).error, /Workspace 目录不存在/);
    const unknownGroup = await route.fetch(post([{ op: 'member.update', key: 'user:ZhangSan', patch: { groupId: 'nope' } }]));
    assert.equal(unknownGroup.status, 422);
    assert.match((await unknownGroup.json()).error, /分组不存在/);
    const unknownMember = await route.fetch(post([{ op: 'member.update', key: 'user:nobody', patch: { sessionId: 'x' } }]));
    assert.equal(unknownMember.status, 422);
    assert.match((await unknownMember.json()).error, /成员不存在/);
    const unknownModel = await route.fetch(post([{ op: 'group.update', id: 'default', patch: { provider: 'nope', model: 'nope' } }]));
    assert.equal(unknownModel.status, 422);
    assert.match((await unknownModel.json()).error, /DSH 当前没有模型/);
    const halfModel = await route.fetch(post([{ op: 'group.update', id: 'default', patch: { provider: 'deepseek-account' } }]));
    assert.equal(halfModel.status, 422);
    assert.match((await halfModel.json()).error, /请同时选择服务商与模型/);
    const defaultDelete = await route.fetch(post([{ op: 'group.delete', id: 'default' }]));
    assert.equal(defaultDelete.status, 422);
    assert.match((await defaultDelete.json()).error, /默认分组不能删除/);

    // Malformed bodies never reach the store.
    assert.equal((await route.fetch(new Request('http://localhost/api/wecom-soul-bot/store', { method: 'POST', body: 'nope' }))).status, 400);
    assert.equal((await route.fetch(post([]))).status, 400);
    assert.equal((await route.fetch(post([{ op: 'explode' }]))).status, 400);

    const removed = await route.fetch(post([{ op: 'member.remove', key: 'user:ZhangSan' }]));
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).routing.total, 0);

    // Whatever the page did, it is durable.
    const stored = JSON.parse(await readFile(join(home, 'wecom-soul-bot', 'settings.json'), 'utf8'));
    assert.equal(stored.version, '0.5');
    assert.deepEqual(stored.groups.map(item => item.name), ['默认分组', '朋友']);
    assert.deepEqual(stored.bindings, []);
  }
}));

test('changing a group Workspace drops the Sessions it used to own', () => withHome(async home => {
  {
    const { ctx, routes } = hostWithServices();
    ctx.effect = fn => { void fn(); };
    apply(ctx, Config({}));
    await settle();
    const route = routes.get('/api/wecom-soul-bot/store');
    await route.fetch(post([
      { op: 'member.add', groupId: 'default', kind: 'user', id: 'alice' },
      { op: 'member.update', key: 'user:alice', patch: { sessionId: 'session-1' } },
    ]));
    const moved = await route.fetch(post([{ op: 'group.update', id: 'default', patch: { workspace: home } }]));
    assert.equal((await moved.json()).routing.groups[0].members[0].sessionId, '');
  }
}));

test('the Host-level session listener completes rounds even across a bridge rebuild', () => withHome(async () => {
  const { ctx } = hostWithServices();
  const clients = [];
  const journal = memoryJournal();
  let botId = 'bot';
  const stored = Config({});
  const config = new Proxy(stored, { get: (target, key) => (key === 'botId' ? { get: () => botId } : target[key]) });
  const runtime = createRuntime({
    ctx, journal, log: silent, config,
    createClient: () => { const client = fakeClient(); clients.push(client); return client; },
  });
  await runtime.start();
  await runtime.store.load();
  await runtime.store.create('user', 'alice', { groupId: 'default' });
  clients[0].emit('message', frame('build it', { chat: 'alice', user: 'alice' }));
  await until(() => ctx.prompts.length > 0);
  const requestId = ctx.prompts[0].requestId;
  const sessionId = ctx.prompts[0].sessionId;
  botId = 'bot-2';
  ctx.handlers.get('app-boot/config-reload')();
  await settle();
  assert.equal(clients.length, 2, 'the bridge was rebuilt');
  const { session, end } = finishedSession(sessionId, { promptIds: [requestId], text: 'built' });
  ctx.handlers.get('session/event')(session, end);
  await until(() => journal.find('round.complete').some(record => record.requestId === requestId));
  const round = journal.find('round.complete').find(record => record.requestId === requestId);
  assert.equal(round.outcome, 'turn-ended', 'the round survived the rebuild');
  assert.equal(round.response.assistant, 'built');
  await runtime.stop();}));

test('a finished turn reaches the conversation bound to the Session and lands in the journal', () => withHome(async () => {
  const { ctx } = hostWithServices();
  const client = fakeClient();
  const journal = memoryJournal();
  const runtime = createRuntime({ ctx, journal, log: silent, config: Config({ botId: 'bot' }), createClient: () => client });
  await runtime.start();
  await runtime.store.load();
  await runtime.store.create('user', 'alice', { groupId: 'default' });
  client.emit('authenticated');
  client.emit('message', frame('build it', { chat: 'alice', user: 'alice' }));
  await until(() => ctx.prompts.length > 0);
  const requestId = ctx.prompts[0].requestId;
  const sessionId = ctx.prompts[0].sessionId;
  const { session, end } = finishedSession(sessionId, { promptIds: [requestId], text: 'built' });
  ctx.handlers.get('session/event')(session, end);
  await until(() => client.sends.length > 0);
  await until(() => journal.find('round.complete').some(record => record.requestId === requestId));
  const round = journal.find('round.complete').find(record => record.requestId === requestId);
  assert.equal(round.outcome, 'turn-ended');
  assert.equal(round.response.assistant, 'built');
  assert.deepEqual(round.response.notifiedChats, ['alice']);
  assert.deepEqual(client.sends.map(send => send.chat), ['alice']);
  await runtime.stop();}));

test('a refused sender shows up in the state view until the page authorizes it', () => withHome(async () => {
  const { ctx } = hostWithServices();
  const client = fakeClient();
  const runtime = createRuntime({ ctx, journal: memoryJournal(), log: silent, config: Config({ botId: 'bot' }), createClient: () => client });
  await runtime.start();
  client.emit('authenticated');
  client.emit('message', frame('我是新来的', { chat: 'mallory', user: 'mallory' }));
  await until(() => runtime.observations.rejected(() => false).length > 0);
  const before = await runtime.state();
  assert.deepEqual(before.rejected.map(row => [row.key, row.text]), [['user:mallory', '我是新来的']]);
  assert.deepEqual(before.routing.groups[0].members, []);
  assert.deepEqual(before.notices, [], 'an empty group set is said by the page itself, not as a warning');

  await runtime.applyOps([{ op: 'member.add', groupId: 'default', kind: 'user', id: 'mallory', label: '市场部小李' }]);
  const after = await runtime.state();
  assert.deepEqual(after.rejected, [], 'the row disappears once the sender is a member');
  assert.deepEqual(after.routing.groups[0].members.map(member => member.displayName), ['市场部小李']);
  assert.deepEqual(after.notices, []);
  await runtime.stop();}));

test('apply registers the authenticated routes and writes the journal under DSH_HOME', () => withHome(async home => {
  {
    const { ctx, routes } = hostWithServices();
    let setup;
    ctx.effect = fn => { setup = fn(); };
    apply(ctx, Config({}));
    const dispose = await setup;
    const state = routes.get('/api/wecom-soul-bot/state');
    assert.equal(state.path, '/api/wecom-soul-bot/state');
    assert.deepEqual(state.methods, ['GET']);
    assert.ok(routes.get('/api/wecom-soul-bot/store'), 'both routes are registered');
    const response = await state.fetch(new Request('http://localhost/api/wecom-soul-bot/state?refresh=1'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.connection.phase, 'unconfigured');
    assert.equal(body.connection.detail, '缺少 Bot ID');
    assert.equal(body.journal.directory, join(home, 'wecom-soul-bot', 'logs'));
    assert.equal(body.routing.total, 0);
    assert.deepEqual(body.routing.groups.map(group => group.name), ['默认分组']);
    assert.equal(body.routing.groups[0].workspacePath, join(home, 'wecom-soul-bot', 'workspace'));
    assert.deepEqual(body.rejected, []);
    await dispose();
    assert.equal(routes.get('/api/wecom-soul-bot/state'), undefined);
    assert.equal(routes.get('/api/wecom-soul-bot/store'), undefined);
    const lines = (await readFile(body.journal.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.event).filter(event => event.startsWith('plugin.')), ['plugin.start', 'plugin.stop']);
  }
}));

test('authorizing a sender greets them once through the live bridge', () => withHome(async () => {
  const { ctx } = hostWithServices();
  ctx.effect = fn => { void fn(); };
  const client = fakeClient();
  const runtime = createRuntime({
    ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }),
    createClient: () => client,
  });
  await runtime.start();
  client.emit('authenticated');

  const result = await runtime.applyOps([
    { op: 'member.add', groupId: 'default', kind: 'user', id: 'ZhangSan' },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.authorized, [{ kind: 'user', id: 'ZhangSan', groupId: 'default' }]);
  await settle();
  assert.deepEqual(client.sends.map(send => send.chat), ['ZhangSan'], 'sent to the chat that was authorized');
  const greeting = client.sends[0].body.markdown.content;
  assert.match(greeting, /管理员已授权，可以开始使用了/);
  assert.match(greeting, /\/help/);
  assert.match(greeting, /默认分组/);
  await runtime.stop();
}));

test('archiving a member Session through the store route clears the binding', () => withHome(async () => {
  const { ctx } = hostWithServices();
  const runtime = createRuntime({
    ctx, journal: memoryJournal(), log: silent, config: Config({}),
    createClient: () => fakeClient(),
  });
  await runtime.start();
  await runtime.store.create('user', 'alice', { groupId: 'default' });
  await runtime.store.update('user:alice', { sessionId: 's1' });

  const result = await runtime.applyOps([{ op: 'member.archive', key: 'user:alice' }]);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(ctx.registry.archivedCalls, [{ sessionId: 's1', options: { stopActivity: true } }]);
  assert.equal(runtime.store.get('user:alice').sessionId, '');
  await runtime.stop();
}));

/* ------------------------------------------------------------------ *
 * A settings edit is a store write, not a Config write: it must never *
 * cost the WeCom socket, and it must reach the running bridge         *
 * ------------------------------------------------------------------ */

test('editing the settings never reconnects the socket', () => withHome(async home => {
  await writeStore(home, { settings: { adminUserIds: ['root'] } });
  const { ctx } = hostWithServices();
  const clients = [];
  const journal = memoryJournal();
  const runtime = createRuntime({
    ctx, journal, log: silent,
    config: Config({ botId: 'bot' }),
    createClient: () => { const client = fakeClient(); clients.push(client); return client; },
  });
  await runtime.start();
  await runtime.store.load();
  clients[0].emit('authenticated');
  assert.equal(runtime.status.connection().phase, 'online');

  // What the ④ and ⑤ cards post: administrators, the notification scope, then
  // the knobs — the edits that used to rebuild the bridge on every click.
  const refused = await runtime.applyOps([{ op: 'settings.set', patch: { remoteApprovals: 'yes' } }]);
  assert.equal(refused.ok, false, 'an unusable patch never reaches the store');
  const applied = await runtime.applyOps([
    { op: 'settings.set', patch: { adminUserIds: ['root', 'second'], adminWorkspaces: ['/w/alpha'] } },
    { op: 'settings.set', patch: { remoteApprovals: true, questionTimeoutMs: 30000 } },
  ]);
  assert.equal(applied.ok, true);
  assert.equal(applied.settingsChanged, true);
  await settle();

  assert.equal(clients.length, 1, 'the socket was never replaced');
  assert.equal(runtime.status.connection().phase, 'online', 'and it is still up');
  const state = await runtime.state();
  assert.deepEqual(state.settings.adminUserIds, ['root', 'second']);
  assert.deepEqual(state.settings.adminWorkspaces, ['/w/alpha']);
  assert.equal(state.settings.remoteApprovals, true);
  assert.equal(state.settings.questionTimeoutMs, 30000);
  assert.deepEqual(state.admins.map(admin => admin.id), ['root', 'second']);
  const kept = journal.find('config.applied').filter(record => record.connection === 'kept');
  assert.equal(kept.length >= 1, true, 'the live update is journaled as a kept connection');
  await runtime.stop();
}));

test('the live bridge adopts an edited administrator list', () => withHome(async home => {
  // Authorization is policy, and policy is rebuilt from the store: a new
  // administrator reaches the Bot immediately, on the connection already open.
  await writeStore(home, { settings: { adminUserIds: [] } });
  const { ctx } = hostWithServices();
  const client = fakeClient();
  const runtime = createRuntime({
    ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }),
    createClient: () => client,
  });
  await runtime.start();
  await runtime.store.load();
  client.emit('authenticated');
  client.emit('message', frame('hello', { chat: 'newcomer', user: 'newcomer' }));
  await settle();
  assert.equal(ctx.prompts.length, 0, 'a sender nobody authorized reaches no Session');

  await runtime.applyOps([{ op: 'settings.set', patch: { adminUserIds: ['newcomer'] } }]);
  client.emit('message', frame('/new', { chat: 'newcomer', user: 'newcomer' }));
  assert.ok(await until(() => ctx.creates.length > 0));
  client.emit('message', frame('hello again', { chat: 'newcomer', user: 'newcomer' }));
  assert.ok(await until(() => ctx.prompts.length > 0));
  assert.equal(ctx.prompts.length, 1, 'the same connection now admits their explicitly selected Session');
  assert.equal(runtime.store.get('user:newcomer'), undefined, 'promotion never creates membership');
  await runtime.stop();
}));

test('promoting an administrator tells them, without a reconnect, and the bridge obeys at once', () => withHome(async home => {
  await writeStore(home, { settings: { adminUserIds: [] } });
  const { ctx } = hostWithServices();
  const client = fakeClient();
  const clients = [];
  const runtime = createRuntime({
    ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }),
    createClient: () => { clients.push(client); return client; },
  });
  await runtime.start();
  client.emit('authenticated');

  const result = await runtime.applyOps([{ op: 'settings.set', patch: { adminUserIds: ['newcomer'] } }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.promotedAdmins, ['newcomer']);
  assert.equal(clients.length, 1, 'the socket was never replaced');
  await settle();
  assert.deepEqual(client.sends.map(send => send.chat), ['newcomer'], 'the new administrator is told in their private chat');
  assert.match(client.sends[0].body.markdown.content, /你已被设为管理员/);

  // The very next administrator command runs on the connection already open.
  client.emit('message', frame('/new', { chat: 'newcomer', user: 'newcomer' }));
  await until(() => ctx.creates.length > 0);
  assert.equal(ctx.creates.length, 1, 'the promotion was already part of the access policy');
  await runtime.stop();
}));

test('a batch that fails after a settings edit still updates the running bridge', () => withHome(async home => {
  await writeStore(home, { settings: { adminUserIds: [] } });
  const { ctx } = hostWithServices();
  const client = fakeClient();
  const runtime = createRuntime({
    ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }),
    createClient: () => client,
  });
  await runtime.start();
  client.emit('authenticated');

  const result = await runtime.applyOps([
    { op: 'settings.set', patch: { adminUserIds: ['newcomer'] } },
    { op: 'settings.set', patch: { questionTimeoutMs: 1 } },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.settingsChanged, true, 'the accepted edit is still reported');
  // The failing op stopped the batch but must not stop the settings from being
  // adopted: otherwise the promotion waits for the next plugin start.
  client.emit('message', frame('/new', { chat: 'newcomer', user: 'newcomer' }));
  await until(() => ctx.creates.length > 0);
  assert.equal(ctx.creates.length, 1, 'the live bridge already knows the new administrator');
  await runtime.stop();
}));

test('moving a member to another group tells them where they landed', () => withHome(async home => {
  await writeStore(home, { settings: { adminUserIds: [] } });
  const { ctx } = hostWithServices();
  const client = fakeClient();
  const runtime = createRuntime({
    ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }),
    createClient: () => client,
  });
  await runtime.start();
  client.emit('authenticated');
  await runtime.store.create('user', 'alice', { groupId: 'default' });
  const friends = await runtime.store.createGroup('朋友');

  const result = await runtime.applyOps([
    { op: 'member.update', key: 'user:alice', patch: { groupId: friends.id } },
  ]);
  assert.equal(result.ok, true);
  await settle();
  assert.deepEqual(client.sends.map(send => send.chat), ['alice']);
  const notice = client.sends[0].body.markdown.content;
  assert.match(notice, /你已被调整到新的分组/);
  assert.match(notice, /朋友/);
  await runtime.stop();
}));

test('a moved administrator loses both the persisted Session and the temporary switch', () => withHome(async home => {
  await writeStore(home, { settings: { adminUserIds: ['alice'] } });
  const { ctx } = hostWithServices();
  const client = fakeClient();
  const runtime = createRuntime({ ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }), createClient: () => client });
  await runtime.start();
  client.emit('authenticated');
  await runtime.store.create('user', 'alice', { groupId: 'default', label: '爱丽丝' });
  await runtime.store.update('user:alice', { sessionId: 's1' });
  client.emit('message', frame('/use s1'));
  assert.ok(await until(() => client.replies.some(reply => /已切换到/.test(reply.content))));
  const group = await runtime.store.createGroup('新组');
  const path = mkdtempSync(join(home, 'group-'));
  await runtime.store.updateGroup(group.id, { workspace: path, preset: 'ptc', provider: 'deepseek-account', model: 'deepseek-reasoner' });
  const result = await runtime.applyOps([{ op: 'member.update', key: 'user:alice', patch: { groupId: group.id } }]);
  assert.equal(result.ok, true, result.error);
  assert.equal(runtime.store.get('user:alice').sessionId, '');
  assert.deepEqual(runtime.store.forSession('s1'), []);
  client.emit('message', frame('after the move'));
  assert.ok(await until(() => ctx.prompts.length > 0));
  const created = ctx.creates[0];
  assert.equal(ctx.registry.list().find(row => row.id === created.workspaceId).path, path);
  assert.equal(created.agentPreset, 'ptc');
  assert.equal(ctx.prompts[0].sessionId, 'session-created-1', 'not the formerly switched s1');
  assert.equal(runtime.store.label('user:alice'), '爱丽丝');
  assert.equal(ctx.registry.archivedCalls.length, 0, 'unbinding preserves the old history');
  await runtime.stop();
}));

test('a Workspace edit invalidates first-Session creation even when the binding was empty', () => withHome(async home => {
  const { ctx } = hostWithServices();
  const client = fakeClient();
  const runtime = createRuntime({ ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }), createClient: () => client });
  await runtime.start();
  await runtime.store.create('user', 'alice', { groupId: 'default' });
  const create = ctx.sessionController.create;
  let release;
  ctx.sessionController.create = async request => {
    await new Promise(resolve => { release = resolve; });
    return create(request);
  };
  client.emit('message', frame('in the old Workspace'));
  assert.ok(await until(() => Boolean(release)));
  const path = mkdtempSync(join(home, 'new-workspace-'));
  const result = await runtime.applyOps([{ op: 'group.update', id: 'default', patch: { workspace: path } }]);
  assert.equal(result.ok, true, result.error);
  ctx.sessionController.create = create;
  release();
  assert.ok(await until(() => client.replies.some(reply => /分组或会话已变更/.test(reply.content))));
  assert.equal(runtime.store.get('user:alice').sessionId, '');
  assert.equal(ctx.prompts.length, 0);
  client.emit('message', frame('in the new Workspace'));
  assert.ok(await until(() => ctx.prompts.length > 0));
  const created = ctx.creates.at(-1);
  assert.equal(ctx.registry.list().find(row => row.id === created.workspaceId).path, path);
  assert.equal(ctx.prompts[0].sessionId, 'session-created-2');
  await runtime.stop();
}));

test('unexpected errors after a settings edit cannot leave live administrator policy stale', () => withHome(async () => {
  const { ctx } = hostWithServices();
  const client = fakeClient();
  const runtime = createRuntime({ ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }), createClient: () => client });
  await runtime.start();
  runtime.store.updateGroup = async () => { throw new Error('unexpected store error'); };
  const result = await runtime.applyOps([
    { op: 'settings.set', patch: { adminUserIds: ['newcomer'] } },
    { op: 'group.update', id: 'default', patch: { name: 'fail' } },
    { op: 'settings.set', patch: { adminUserIds: [] } },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /unexpected store error/);
  assert.equal(result.settingsChanged, true);
  client.emit('message', frame('/new', { chat: 'newcomer', user: 'newcomer' }));
  assert.ok(await until(() => ctx.creates.length > 0));
  await runtime.stop();
}));

test('the store route rejects malformed patches without losing earlier live settings', () => withHome(async () => {
  const { ctx, routes } = hostWithServices();
  const client = fakeClient();
  const runtime = createRuntime({ ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }), createClient: () => client });
  await runtime.start();
  const response = await storeRoute(runtime).fetch(post([
    { op: 'settings.set', patch: { adminUserIds: ['newcomer'] } },
    { op: 'group.update', id: 'default', patch: { workspace: 42 } },
  ]));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /必须是文本/);
  client.emit('message', frame('/new', { chat: 'newcomer', user: 'newcomer' }));
  assert.ok(await until(() => ctx.creates.length > 0));
  await runtime.stop();
}));

test('the WebSocket endpoint is half of the connection, so editing it reconnects', () => withHome(async home => {
  await writeStore(home, {});
  const { ctx } = hostWithServices();
  const clients = [];
  const runtime = createRuntime({
    ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }),
    createClient: value => { const client = fakeClient(); clients.push({ client, options: value }); return client; },
  });
  await runtime.start();
  await runtime.store.load();
  assert.equal(clients.length, 1);
  const applied = await runtime.applyOps([{ op: 'settings.set', patch: { wsUrl: 'wss://openws.example' } }]);
  assert.equal(applied.ok, true);
  await until(() => clients.length === 2);
  assert.equal(clients.length, 2, 'a new endpoint is a new connection');
  assert.equal(clients[1].options.wsUrl, 'wss://openws.example');
  await runtime.stop();
}));

test('a settings patch that cannot be used is refused with its reason', () => withHome(async home => {
  await writeStore(home, {});
  const { ctx } = hostWithServices();
  const runtime = createRuntime({
    ctx, journal: memoryJournal(), log: silent,
    config: Config({ botId: 'bot' }),
    createClient: () => fakeClient(),
  });
  await runtime.start();
  await runtime.store.load();
  const cases = [
    [{ wsUrl: 'ws://plaintext.example' }, /wss:\/\//],
    [{ wsUrl: 'wss://user:pass@openws.example' }, /wss:\/\//],
    [{ questionTimeoutMs: 10 }, /等待企微回复/],
    [{ logRetentionDays: 400 }, /日志保留天数/],
    [{ adminUserIds: [''] }, /userid/],
    [{ adminWorkspaces: [42] }, /Workspace 路径/],
    [{ nope: 1 }, /无法识别的设置项/],
  ];
  for (const [patch, pattern] of cases) {
    const result = await runtime.applyOps([{ op: 'settings.set', patch }]);
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.match(result.error, pattern);
  }
  assert.equal(runtime.store.settings().wsUrl, '', 'nothing half-applied');
  assert.equal(runtime.store.settings().logRetentionDays, 14);
  await runtime.stop();
}));

test('the stored settings are read before the first connection decision', () => withHome(async home => {
  // A reload event can arrive while the plugin is still starting. The bridge must
  // not dial out with the defaults and adopt the real settings afterwards: that
  // would refuse a stored administrator for as long as the file takes to read,
  // and leave a spurious `rebuilt` in the journal.
  await writeStore(home, { settings: { adminUserIds: ['root'], questionTimeoutMs: 45000 } });
  const { ctx } = hostWithServices();
  const clients = [];
  const journal = memoryJournal();
  const runtime = createRuntime({
    ctx, journal, log: silent,
    config: Config({ botId: 'bot' }),
    createClient: () => { const client = fakeClient(); clients.push(client); return client; },
  });
  const starting = runtime.start();
  ctx.handlers.get('app-boot/config-reload')();
  await starting;
  assert.equal(clients.length, 1, 'one connection, not two');
  const applied = journal.find('config.applied');
  assert.equal(applied.length, 1, 'the first decision already had the stored settings');
  assert.deepEqual(applied[0].adminUserIds, ['root']);
  assert.equal(applied[0].questionTimeoutMs, 45000);
  assert.equal(applied[0].connection, 'rebuilt');
  await runtime.stop();
}));
