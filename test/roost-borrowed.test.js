import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { matchLore, splitPersona } from '../dist/host/soul/worldbook.js';
import { createClosingStore, looksLikeQuestion, CLOSING_COOL_MS } from '../dist/host/soul/closing.js';
import { createStickerStore, tagsFromFilename } from '../dist/host/soul/stickers.js';
import { createSoulService, SECTION_CONTEXT, SECTION_PERSONA } from '../dist/host/soul/service.js';
import { createSoulStore } from '../dist/host/soul/store.js';
import { scratchDirectory } from './helpers.js';

const PERSONA = '你是大肥鱼。\n\n## 世界书\n- 冰岛, 极光 | 主人去年冬天去过冰岛看极光。\n坏行没有竖线\n- 火锅 | 主人只吃微辣。\n\n## 其它\n留着';

test('worldbook entries are split out and only injected when mentioned', () => {
  const { body, lore } = splitPersona(PERSONA);
  assert.match(body, /大肥鱼/);
  assert.match(body, /留着/);
  assert.doesNotMatch(body, /冰岛/);
  assert.equal(lore.length, 2, 'the malformed line is skipped');
  assert.deepEqual(matchLore(lore, '最近想去看极光').map(e => e.text), ['主人去年冬天去过冰岛看极光。']);
  assert.equal(matchLore(lore, '今天天气不错').length, 0);
});

async function soulHarness({ binding = { kind: 'user', id: 'owner' }, workMode = false } = {}) {
  let now = 1_000_000_000_000;
  const store = createSoulStore({ directory: scratchDirectory(), now: () => now });
  await store.load();
  await store.update({ persona: PERSONA, workMode });
  const closing = createClosingStore({ file: join(scratchDirectory(), 'closing.json') });
  await closing.load();
  const sections = new Map();
  const tools = new Map();
  const guards = [];
  const sent = [];
  const soul = createSoulService({
    ctx: {
      systemPrompt: { section(s) { sections.set(s.name, s); } },
      tools: { register(t) { tools.set(t.name, t); }, guard(g) { guards.push(g); } },
    },
    store, closing, admins: () => ['owner'], defineTool: o => o, now: () => now,
    bindings: { forSession: () => [binding] },
    sendFile: async (chat, buffer, name) => { sent.push({ chat, bytes: buffer.length, name }); return true; },
  });
  soul.start();
  const render = name => sections.get(name).text({ agent: { id: 's', session: { id: 's' } } });
  const exec = { agent: { id: 's', session: { id: 's' } } };
  return { soul, tools, guards, sent, render, exec, closing, advance: ms => { now += ms; } };
}

test('the persona section carries only the lore the last message triggered', async () => {
  const h = await soulHarness();
  h.soul.noteSender('s', { user: 'owner', chat: 'owner', chatType: 'single' }, 'r1', '晚上吃火锅吗');
  const text = h.render(SECTION_PERSONA);
  assert.match(text, /只吃微辣/);
  assert.doesNotMatch(text, /冰岛/);
});

test('closing records where a private chat stopped, refuses mid-question, and quiets proactive chat', async () => {
  const h = await soulHarness();
  const close = h.tools.get('wecom_chat_close');
  h.soul.noteSender('s', { user: 'owner', chat: 'owner', chatType: 'single' }, 'r1', '明天几点起？');
  assert.equal((await close.execute({ point: '聊到明早安排' }, h.exec)).ok, false, 'still a question');
  h.soul.noteSender('s', { user: 'owner', chat: 'owner', chatType: 'single' }, 'r2', '我去睡了，晚安');
  assert.equal((await close.execute({ point: '主人去睡了', resume: '明早问睡得怎么样' }, h.exec)).ok, true);
  assert.match(h.render(SECTION_CONTEXT), /上次收尾[\s\S]*主人去睡了[\s\S]*明早问睡得怎么样/);
  assert.equal(h.soul.closedRecently('user:owner'), true);
  h.advance(CLOSING_COOL_MS + 1);
  assert.equal(h.soul.closedRecently('user:owner'), false);
  assert.equal(looksLikeQuestion('帮我看下日志'), true);
});

test('group chats never close', async () => {
  const h = await soulHarness({ binding: { kind: 'group', id: 'g1' } });
  h.soul.noteSender('s', { user: 'owner', chat: 'g1', chatType: 'group' }, 'r1', '散了散了');
  assert.deepEqual(await h.tools.get('wecom_chat_close').execute({ point: 'x' }, h.exec), { ok: false, why: '群里不收尾' });
});

test('send_file is gated by work mode and the guard, and refuses relative paths', async () => {
  const off = await soulHarness();
  off.soul.noteSender('s', { user: 'owner', chat: 'owner', chatType: 'single' }, 'r1', '发我');
  assert.match(off.guards[0]({ name: 'wecom_send_file', agent: { id: 's' } }) ?? '', /已被拒绝/, 'not a chat tool');
  await assert.rejects(off.tools.get('wecom_send_file').execute({ path: '/etc/hosts' }, off.exec), /工作模式/);
  const on = await soulHarness({ workMode: true });
  on.soul.noteSender('s', { user: 'owner', chat: 'owner', chatType: 'single' }, 'r1', '发我');
  assert.equal(on.guards[0]({ name: 'wecom_send_file', agent: { id: 's' } }), undefined);
  await assert.rejects(on.tools.get('wecom_send_file').execute({ path: 'rel.txt' }, on.exec), /绝对路径/);
  const dir = scratchDirectory();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.md'), '# ok\n');
  const r = await on.tools.get('wecom_send_file').execute({ path: join(dir, 'report.md') }, on.exec);
  assert.deepEqual(r, { sent: true, name: 'report.md', bytes: 5 });
  assert.equal(on.sent[0].chat, 'owner');
});

test('images dropped into the stickers folder are usable, with tags from their file names', async () => {
  assert.deepEqual(tagsFromFilename('开心_猫 (2).png'), ['开心', '猫']);
  assert.deepEqual(tagsFromFilename('无语-2.gif'), ['无语']);
  const dir = scratchDirectory();
  await mkdir(join(dir, 'drop'), { recursive: true });
  await writeFile(join(dir, 'drop', '开心_猫.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
  await writeFile(join(dir, 'drop', 'notes.txt'), 'ignored');
  const store = createStickerStore({ directory: dir });
  await store.load();
  assert.deepEqual(store.list().map(s => s.name), ['开心_猫']);
  assert.equal(store.find('猫').file, 'drop/开心_猫.png', 'found by a file-name tag');
  assert.equal((await store.read(store.find('猫'))).length, 5);
});
