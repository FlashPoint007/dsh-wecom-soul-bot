// The preset roster service: what the group form offers and what it accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetService } from '../dist/host/presets.js';

const roster = (rows, resolve) => () => ({
  async list() { return rows; },
  async resolve(id) {
    if (resolve) return await resolve(id);
    return { id: id ?? 'standard' };
  },
});

test('the roster marks the DSH default and keeps the names presets publish', async () => {
  const service = createPresetService({
    registry: roster([{ id: 'standard' }, { id: 'ptc', name: 'PTC 模式', description: '全能力' }, { id: 'broken', broken: '挂了' }]),
  });
  assert.equal(service.snapshot(), undefined);
  assert.equal(service.known('anything'), true, 'an unread roster never calls a configured value wrong');

  const view = await service.load();
  assert.deepEqual(view.presets.map(preset => [preset.id, preset.name, preset.isDefault, preset.broken]), [
    ['standard', undefined, true, undefined],
    ['ptc', 'PTC 模式', false, undefined],
    ['broken', undefined, false, '挂了'],
  ]);
  assert.equal(service.known('ptc'), true);
  assert.equal(service.known('nope'), false);
  assert.equal(service.snapshot(), view, 'the read is cached for its TTL');

  // A shipped preset names itself through the page, so no name is invented here.
  assert.equal(view.presets[0].description, undefined);
});

test('a deployment without a preset registry offers nothing and judges nothing', async () => {
  const service = createPresetService({ registry: () => undefined });
  assert.deepEqual((await service.load()).presets, []);
  assert.equal(service.known('whatever'), true, 'there is no roster to validate against');

  // `ctx.get` may hand back something that is not the service at all.
  const stranger = createPresetService({ registry: () => ({}) });
  assert.deepEqual((await stranger.load()).presets, []);
});

test('an unresolvable default leaves it unmarked instead of failing the read', async () => {
  const service = createPresetService({
    registry: roster([{ id: 'standard' }, { id: 'ptc' }], async () => { throw new Error('registry offline'); }),
  });
  const view = await service.load();
  assert.deepEqual(view.presets.map(preset => [preset.id, preset.isDefault]), [['standard', false], ['ptc', false]]);
});

test('a refresh re-reads the roster once for concurrent callers', async () => {
  let reads = 0;
  let clock = 0;
  const service = createPresetService({
    ttlMs: 100,
    now: () => clock,
    registry: () => ({
      async list() { reads++; return [{ id: 'standard' }]; },
      async resolve() { return { id: 'standard' }; },
    }),
  });
  await Promise.all([service.load(), service.load()]);
  assert.equal(reads, 1);
  clock = 50;
  await service.load();
  assert.equal(reads, 1, 'still inside the TTL');
  await service.load({ refresh: true });
  assert.equal(reads, 2, 'an explicit refresh re-reads');
});
