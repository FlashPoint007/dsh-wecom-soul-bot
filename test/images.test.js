import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePartsOf, loadImages, MAX_IMAGE_BYTES, MAX_IMAGES, sniffImage } from '../dist/host/bridge/images.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

test('image and mixed callbacks yield https image refs and their text', () => {
  assert.deepEqual(imagePartsOf({ msgtype: 'image', image: { url: 'https://x/a', aeskey: 'k' } }),
    { images: [{ url: 'https://x/a', aeskey: 'k' }], text: '' });
  const mixed = imagePartsOf({ msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: '看下这个报错' } },
    { msgtype: 'image', image: { url: 'https://x/b' } },
    { msgtype: 'image', image: { url: 'http://insecure/c' } },
  ] } });
  assert.equal(mixed.text, '看下这个报错');
  assert.deepEqual(mixed.images.map(i => i.url), ['https://x/b'], 'non-https urls are ignored');
  const many = imagePartsOf({ msgtype: 'mixed', mixed: { msg_item: Array.from({ length: 9 }, (_, i) => ({ msgtype: 'image', image: { url: 'https://x/' + i } })) } });
  assert.equal(many.images.length, MAX_IMAGES);
});

test('media type is sniffed from bytes', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPG), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('not an image')), undefined);
});

test('images are downloaded with their aeskey and encoded; failures are counted, not fatal', async () => {
  const calls = [];
  const download = async (url, key) => {
    calls.push([url, key]);
    if (url.endsWith('bad')) throw new Error('decrypt failed');
    if (url.endsWith('big')) return { buffer: Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]) };
    if (url.endsWith('txt')) return { buffer: Buffer.from('hello') };
    return { buffer: PNG };
  };
  const { blocks, failed } = await loadImages([
    { url: 'https://x/ok', aeskey: 'k1' }, { url: 'https://x/bad' }, { url: 'https://x/big' }, { url: 'https://x/txt' },
  ], download);
  assert.deepEqual(calls[0], ['https://x/ok', 'k1']);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].mediaType, 'image/png');
  assert.equal(Buffer.from(blocks[0].data, 'base64').equals(PNG), true);
  assert.equal(failed, 3);
});
