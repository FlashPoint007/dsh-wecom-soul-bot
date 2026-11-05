import test from 'node:test';
import assert from 'node:assert/strict';
import { recentHistory, stripIdentity, createHostSessionControls } from '../dist/host/session-controls.js';
import { parseCommand, runCommand } from '../dist/host/bridge/commands.js';

test('history keeps what people typed and only completed final answers', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '【对话环境】私聊 · 发送者 userid=a · 主人本人\n\n在吗' }] } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '中间解释' }] } } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '在' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '/history' }] } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '算了' }] } },
    { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '没答完' }] } } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'cancelled' } } },
  ];
  assert.deepEqual(recentHistory(events, 5), [
    { role: 'user', text: '在吗' }, { role: 'assistant', text: '在' }, { role: 'user', text: '算了' },
  ]);
  assert.equal(recentHistory(events, 1).length, 1);
  assert.equal(stripIdentity('普通文字'), '普通文字');
});

test('steer only reaches a running turn and uses the steer prompt mode', async () => {
  const prompts = [];
  let running = false;
  const controls = createHostSessionControls({
    ctx: { sessionController: { async prompt(r) { prompts.push(r); } }, get: () => undefined },
    models: { async load() { return { choices: [] }; }, async select(_s, sel) { return sel; } },
    running: async () => running, currentModel: async () => undefined,
  });
  assert.equal(await controls.steer('s1', '先别发版', 'r1'), false);
  running = true;
  assert.equal(await controls.steer('s1', '先别发版', 'r2'), true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].mode, 'steer');
  assert.equal(prompts[0].content[0].text, '先别发版');
});

test('clear runs DSH /clear through the command gateway and never falls back', async () => {
  const calls = [];
  const make = gateway => createHostSessionControls({
    ctx: { sessionController: {}, get: name => (name === 'typertGateway' ? gateway : undefined) },
    models: {}, running: async () => false, currentModel: async () => undefined,
  });
  assert.equal(await make(undefined).clear('s1'), 'unsupported');
  const ok = make({ async invoke(r) { calls.push(r); return { result: { kind: 'success' } }; } });
  assert.equal(await ok.clear('s1'), 'cleared');
  assert.deepEqual(calls[0].args, { agentId: 's1', line: '/clear', images: [] });
  const bad = make({ async invoke() { return { result: { kind: 'error', message: 'agent-busy' } }; } });
  assert.deepEqual(await bad.clear('s1'), { error: 'agent-busy' });
});

test('history reads the live session log', async () => {
  const controls = createHostSessionControls({
    ctx: { sessionController: {}, get: name => (name === 'agents' ? { get: () => ({ session: { snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    ] } }) } : undefined) },
    models: {}, running: async () => false, currentModel: async () => undefined,
  });
  assert.deepEqual(await controls.history('s1', 3), [{ role: 'user', text: 'hi' }]);
});

function commandHarness({ mayControl = true, chatType = 'single' } = {}) {
  const replies = [];
  const calls = [];
  const services = {
    policy: { isAdmin: () => false },
    directory: {}, selection: {}, interactions: {}, sessionController: { cancel: r => calls.push(['cancel', r]) },
    journal: { write() {} }, ops: {}, workspaces: {}, adminWorkspaces: {},
    async current() { return { sessionId: 's1', switched: false }; },
    async archiveSession() {}, stale: () => false, ticket: () => ({ bridge: 0, chat: 'c', routing: 0 }),
    controls: {
      mayControl: () => mayControl,
      async steer(s, t) { calls.push(['steer', s, t]); return true; },
      async clear(s) { calls.push(['clear', s]); return 'cleared'; },
      async models() { return { current: 'p/a', choices: [{ label: 'P / A', provider: 'p', model: 'a' }, { label: 'P / B', provider: 'p', model: 'b' }] }; },
      async selectModel(s, p, m) { calls.push(['select', s, p, m]); return p + '/' + m; },
      async history() { return [{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在' }]; },
    },
  };
  services.directory.permitted = async () => true;
  const run = text => runCommand(services, {
    message: { chat: 'c', user: 'u', chatType }, round: { id: 'r' }, reply: async t => { replies.push(t); },
  }, parseCommand(text));
  return { run, replies, calls };
}

test('/steer /clear /model /history call the controls', async () => {
  const h = commandHarness();
  await h.run('/steer 先别发版，只查日志');
  await h.run('/clear');
  await h.run('/model');
  await h.run('/model 2');
  await h.run('/history 2');
  assert.deepEqual(h.calls[0], ['steer', 's1', '先别发版，只查日志']);
  assert.deepEqual(h.calls[1], ['clear', 's1']);
  assert.deepEqual(h.calls[2], ['select', 's1', 'p', 'b']);
  assert.match(h.replies[2], /P \/ A（当前）/);
  assert.match(h.replies[4], /在吗[\s\S]*在/);
});

test('/stop is /cancel', async () => {
  const h = commandHarness();
  await h.run('/stop');
  assert.equal(h.calls[0][0], 'cancel');
});

test('steer, clear and model are refused for someone who may not control the session; history is not', async () => {
  const h = commandHarness({ mayControl: false, chatType: 'group' });
  await h.run('/steer x');
  await h.run('/clear');
  await h.run('/model 1');
  await h.run('/history');
  assert.equal(h.calls.length, 0);
  assert.match(h.replies[0], /只有主人或管理员/);
  assert.match(h.replies[3], /在吗/);
});
