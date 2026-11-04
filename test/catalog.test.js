import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, catalogView, createCatalogService } from '../dist/host/catalog.js';
import { createObservationStore } from '../dist/host/observation.js';

const row = (sessionId, updatedAt, extra = {}) => ({ sessionId, updatedAt, running: false, blank: false, ...extra });
const titled = title => ({ projections: { values: { title } } });

test('catalog follows the DSH sidebar: Workspace order, pinned first, then most recent; ungrouped last', () => {
  const items = [
    row('a', 10, titled('A')), row('b', 30, titled('B')), row('c', 20, titled('C')),
    row('arch', 99, titled('Archived')), row('sub', 98, { origin: 'subagent' }), row('blank', 97, { blank: true }),
    row('loose', 5, titled('Loose')), row('other', 50, titled('Other')),
  ];
  const registry = {
    list: () => [
      { id: 'w2', path: '/r/two', title: 'default-workspace', sessionIds: ['other'] },
      { id: 'w1', path: '/r/one', title: '', sessionIds: ['a', 'b', 'c', 'arch', 'sub', 'blank'] },
      { id: 'w3', path: '/r/empty', title: 'Empty', sessionIds: [] },
    ],
    archivedSessionIds: ['arch'],
    pinnedSessionIds: ['a'],
  };
  const catalog = buildCatalog(items, registry, 1);
  assert.deepEqual(catalog.groups.map(g => [g.title, g.sessions.map(s => s.sessionId)]), [
    ['默认工作区', ['other']],
    ['one', ['a', 'b', 'c']],
    ['未分组', ['loose']],
  ]);
  assert.equal(catalog.get('a').pinned, true);
  assert.equal(catalog.get('a').title, 'A');
  assert.equal(catalog.get('arch'), undefined);
  assert.equal(catalog.hiddenReason('arch'), 'archived');
  assert.equal(catalog.hiddenReason('sub'), 'subagent');
  assert.equal(catalog.hiddenReason('blank'), 'blank');
  assert.equal(catalog.hiddenReason('gone'), 'missing');
  assert.equal(catalog.archivedCount, 1);
  const view = catalogView(catalog, ['a', 'arch', 'gone']);
  assert.deepEqual(view.hiddenSelections, [
    { sessionId: 'arch', title: 'Archived', reason: 'archived' },
    { sessionId: 'gone', title: null, reason: 'missing' },
  ]);
  assert.equal(view.total, 5);
});

test('a Session row carries the preset it runs and how full its context is', () => {
  const items = [
    row('s1', 1, { projections: { values: {
      title: 'A', agentPreset: ' ptc ',
      contextPressure: { contextWindow: 200_000, pressureTokens: 12_000, projectedTokens: 13_500 },
    } } }),
    row('s2', 2, { projections: { values: { title: 'B', contextPressure: { pressureTokens: 900 } } } }),
    row('s3', 3, titled('C')),
    row('s4', 4, { projections: { values: { title: 'D', contextPressure: { contextWindow: 1000 } } } }),
    row('s5', 5, { projections: { values: { title: 'E', agentPreset: null } } }),
  ];
  const catalog = buildCatalog(items, undefined, 1);
  assert.equal(catalog.get('s1').preset, 'ptc');
  assert.deepEqual(catalog.get('s1').context, { used: 13_500, window: 200_000 },
    'the projected total is what the next request will carry');
  assert.deepEqual(catalog.get('s2').context, { used: 900 }, 'no window reported: the used count only');
  assert.equal(catalog.get('s3').preset, undefined);
  assert.equal(catalog.get('s3').context, undefined);
  assert.equal(catalog.get('s4').context, undefined, 'a window with no sample says nothing about occupancy');
  assert.equal(catalog.get('s5').preset, undefined, 'a null preset is the default, not a name');
});

test('a Session row shows the model it runs now: a pending switch wins over the last used one', () => {
  const a = { provider: 'p', model: 'old' };
  const b = { provider: 'p', model: 'new', reasoningEffort: 'high' };
  const items = [
    row('s1', 1, { projections: { values: { title: 'A', modelSelection: { lastUsed: a, pending: b } } } }),
    row('s2', 2, { projections: { values: { title: 'B', modelSelection: { lastUsed: b, pending: null } } } }),
    row('s3', 3, { projections: { values: { title: 'C', modelSelection: { lastUsed: null, next: b } } } }),
  ];
  const catalog = buildCatalog(items, undefined, 1);
  assert.deepEqual(catalog.get('s1').model, b);
  assert.deepEqual(catalog.get('s2').model, b);
  assert.deepEqual(catalog.get('s3').model, b);
});

test('without a Workspace registry the catalog groups by working directory', () => {
  const catalog = buildCatalog([row('x', 1, { cwd: '/p/old' }), row('y', 9, { cwd: '/p/new' }), row('z', 5)], undefined);
  assert.deepEqual(catalog.groups.map(g => [g.kind, g.title]), [['directory', 'new'], ['directory', 'old'], ['ungrouped', '未分组']]);
});

test('blank Sessions retain Workspace metadata without appearing in the visible catalog', () => {
  const catalog = buildCatalog([
    row('blank', 1, { blank: true, cwd: '/different/cwd', ...titled('New Session') }),
    row('archived', 2, { blank: true }),
    row('subagent', 3, { blank: true, origin: 'subagent' }),
    row('loose', 4, { blank: true, cwd: '/unregistered' }),
  ], {
    list: () => [{ id: 'w1', path: '/w/alpha', title: 'Alpha', sessionIds: ['blank', 'archived', 'subagent'] }],
    archivedSessionIds: ['archived'],
    pinnedSessionIds: [],
  });
  assert.deepEqual(catalog.groups, [], 'a Workspace containing only blank Sessions stays hidden');
  assert.deepEqual(catalog.entries, []);
  assert.equal(catalog.get('blank'), undefined);
  assert.equal(catalog.getBlank('blank').group.path, '/w/alpha', 'the registry, not cwd, owns Workspace membership');
  assert.equal(catalog.getBlank('blank').group.title, 'Alpha');
  assert.equal(catalog.getBlank('blank').title, 'New Session');
  assert.equal(catalog.getBlank('loose').group.path, undefined, 'an unregistered Session stays ungrouped when a registry exists');
  assert.equal(catalog.getBlank('archived'), undefined, 'archival takes precedence over blank');
  assert.equal(catalog.getBlank('subagent'), undefined, 'a blank subagent is never operable');
  assert.equal(catalog.getBlank('missing'), undefined);
  assert.equal(catalogView(catalog, ['blank']).total, 0);
  assert.equal(catalogView(catalog, ['blank']).hiddenSelections[0].reason, 'blank');
});

test('without a registry blank Sessions retain their cwd but remain hidden', () => {
  const catalog = buildCatalog([row('blank', 1, { blank: true, cwd: '/w/alpha' })], undefined);
  assert.deepEqual(catalog.groups, []);
  assert.deepEqual(catalog.entries, []);
  assert.equal(catalog.getBlank('blank').group.path, '/w/alpha');
  assert.equal(catalog.getBlank('blank').group.kind, 'directory');
});

test('catalog service caches for its TTL, shares in-flight reads and supports forced refresh', async () => {
  let calls = 0;
  let clock = 0;
  const service = createCatalogService({
    list: async () => { calls++; return [row('s', 1)]; },
    registry: () => undefined,
  }, { ttlMs: 100, now: () => clock });
  await Promise.all([service.load(), service.load()]);
  assert.equal(calls, 1);
  clock = 50; await service.load();
  assert.equal(calls, 1);
  await service.load({ force: true });
  assert.equal(calls, 2);
  clock = 500; await service.load();
  assert.equal(calls, 3);
  service.invalidate(); await service.load();
  assert.equal(calls, 4);
});

test('observations are bounded, expire, and keep only refused text', () => {
  let clock = 1000;
  const store = createObservationStore({ ttlMs: 100, maxTextChars: 8, now: () => clock });
  const long = '消息 3 的内容很长很长';
  for (let i = 0; i < 4; i++) {
    store.record({ chat: `room-${i}`, user: `user-${i}`, chatType: 'group', accepted: i % 2 === 0, text: `消息 ${i} 的内容很长很长` });
  }
  // A group message is remembered as its conversation; only refusals are
  // listed, newest first, each with a bounded single-line excerpt.
  assert.deepEqual(store.rejected(() => false).map(row => row.id), ['room-3', 'room-1']);
  assert.equal(store.rejected(() => false)[0].text, `${long.slice(0, 8)}…`);
  assert.equal(store.rejected(() => false)[0].chatType, 'group');
  assert.deepEqual(store.stats('group', 'room-2'), { messages: 1, lastSeenAt: 1000 }, 'accepted traffic is counted');

  // An accepted sender's text is dropped but its counters survive.
  store.record({ chat: 'room-3', user: 'user-3', chatType: 'group', accepted: true, text: '这次通过了' });
  assert.deepEqual(store.stats('group', 'room-3'), { messages: 2, lastSeenAt: 1000 });
  assert.deepEqual(store.rejected(() => false).map(row => row.id), ['room-1']);

  // A private chat is remembered by its sender.
  store.record({ chat: 'user-9', user: 'user-9', chatType: 'single', accepted: false, text: '你好' });
  assert.deepEqual(store.stats('user', 'user-9'), { messages: 1, lastSeenAt: 1000 });
  assert.deepEqual(store.rejected(() => false).map(row => row.key), ['user:user-9', 'group:room-1']);

  // An authorized sender disappears from the refusal list without being forgotten.
  assert.deepEqual(store.rejected(key => key === 'user:user-9').map(row => row.key), ['group:room-1']);

  // Nothing survives its TTL.
  clock += 101;
  assert.deepEqual(store.rejected(() => false), []);
  assert.deepEqual(store.stats('group', 'room-3'), { messages: 0 });

  // The oldest principals are evicted once the cap is reached.
  const small = createObservationStore({ maxEntries: 2, now: () => clock });
  for (let i = 0; i < 3; i++) small.record({ chat: `r${i}`, user: `u${i}`, chatType: 'group', accepted: false });
  assert.deepEqual(small.rejected(() => false).map(row => row.id), ['r2', 'r1']);
});
