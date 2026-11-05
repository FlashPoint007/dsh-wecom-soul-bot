import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStickerTools, createStickerStore, MAX_STICKER_BYTES } from '../dist/host/soul/stickers.js';
import { scratchDirectory } from './helpers.js';

const PNG = { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), mediaType: 'image/png' };
const define = o => o;

async function harness({ owner = true, recent = [PNG], sendOk = true } = {}) {
  const store = createStickerStore({ directory: scratchDirectory() });
  await store.load();
  const sent = [];
  const tools = new Map(buildStickerTools(define, {
    stickers: store, journal: { write() {} },
    bindingFor: id => (id === 's1' ? { kind: 'user', id: 'owner' } : undefined),
    senderOf: () => ({ user: owner ? 'owner' : 'bob' }),
    isOwner: u => u === 'owner',
    recentImages: () => recent,
    async sendImage(chat, image, filename) { sent.push({ chat, bytes: image.buffer.length, filename }); return sendOk; },
  }).map(t => [t.name, t]));
  const exec = { agent: { id: 's1' } };
  return { store, tools, sent, exec };
}

test('the owner saves the latest image as a named sticker; it persists across reloads', async () => {
  const h = await harness();
  const r = await h.tools.get('wecom_sticker_save').execute({ name: '不干了', tags: ['摆烂'] }, h.exec);
  assert.deepEqual(r, { name: '不干了', total: 1 });
  const again = createStickerStore({ directory: h.store.list().length && (await import('node:path')).dirname((await import('node:path')).join('x')) });
  assert.ok(again);
  assert.equal(h.store.find('摆烂').name, '不干了', 'found by tag');
});

test('sending a sticker uploads its image to the conversation', async () => {
  const h = await harness();
  await h.tools.get('wecom_sticker_save').execute({ name: '得意' }, h.exec);
  const r = await h.tools.get('wecom_sticker_send').execute({ name: '得意' }, h.exec);
  assert.equal(r.sent, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].chat, 'owner');
  assert.equal(h.sent[0].bytes, PNG.buffer.length);
  await assert.rejects(h.tools.get('wecom_sticker_send').execute({ name: '不存在' }, h.exec), /没有/);
});

test('only the owner may save or delete; anyone may send and list', async () => {
  const owner = await harness();
  await owner.tools.get('wecom_sticker_save').execute({ name: '嫌弃' }, owner.exec);
  const guest = await harness({ owner: false });
  await assert.rejects(guest.tools.get('wecom_sticker_save').execute({ name: 'x' }, guest.exec), /只有主人/);
  await assert.rejects(guest.tools.get('wecom_sticker_delete').execute({ name: 'x' }, guest.exec), /只有主人/);
  assert.deepEqual((await owner.tools.get('wecom_sticker_list').execute({}, owner.exec)).stickers, ['嫌弃']);
  assert.equal((await owner.tools.get('wecom_sticker_delete').execute({ name: '嫌弃' }, owner.exec)).removed, true);
  assert.equal(owner.store.list().length, 0);
});

test('saving needs a recent image and refuses oversized or non-image data', async () => {
  const none = await harness({ recent: [] });
  await assert.rejects(none.tools.get('wecom_sticker_save').execute({ name: 'a' }, none.exec), /没有收到图片/);
  const big = await harness({ recent: [{ buffer: Buffer.alloc(MAX_STICKER_BYTES + 1), mediaType: 'image/png' }] });
  await assert.rejects(big.tools.get('wecom_sticker_save').execute({ name: 'a' }, big.exec), /2 MiB/);
  const odd = await harness({ recent: [{ buffer: Buffer.from('x'), mediaType: 'text/plain' }] });
  await assert.rejects(odd.tools.get('wecom_sticker_save').execute({ name: 'a' }, odd.exec), /只支持/);
});

test('the store reloads saved stickers from disk', async () => {
  const dir = scratchDirectory();
  const a = createStickerStore({ directory: dir });
  await a.load();
  await a.add(PNG, '晚安', [], 'owner');
  const b = createStickerStore({ directory: dir });
  await b.load();
  assert.equal(b.list().length, 1);
  assert.equal((await b.read(b.list()[0])).equals(PNG.buffer), true);
});
