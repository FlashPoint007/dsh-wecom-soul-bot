import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../dist/host/catalog.js';
import { pathListed } from '../dist/host/config.js';
import { createSessionDirectory } from '../dist/host/bridge/directory.js';

const blank = (sessionId, extra = {}) => ({ sessionId, blank: true, ...extra });

function directoryFor(catalog, initialScope = []) {
  let scope = initialScope;
  const directory = createSessionDirectory({ load: async () => catalog }, {
    allow: entry => pathListed(scope, entry.group.path),
  });
  return { directory, setScope: next => { scope = next; } };
}

test('a blank Session remains usable after creation but obeys live Workspace scope edits', async () => {
  const catalog = buildCatalog([blank('new-session')], {
    list: () => [{ id: 'alpha', path: '/w/alpha', title: 'Alpha', sessionIds: ['new-session'] }],
    archivedSessionIds: [], pinnedSessionIds: [],
  });
  const { directory, setScope } = directoryFor(catalog);
  assert.equal(await directory.permitted('new-session'), true, 'an unscoped administrator can use a fresh Session');
  setScope(['/w/alpha']);
  assert.equal(await directory.permitted('new-session'), true, 'a blank Session in scope is still usable');
  setScope(['/w/beta']);
  assert.equal(await directory.permitted('new-session'), false, 'shrinking scope must not exempt a blank Session');
  setScope([]);
  assert.equal(await directory.permitted('new-session'), true);
  assert.equal((await directory.describe('new-session')).workspacePath, '/w/alpha');
  assert.deepEqual(await directory.groups(), [], 'blank Sessions do not enter /sessions');
  assert.equal((await directory.resolve('new-session')).ok, false, 'blank Sessions are not selectable from the catalog');
});

test('blank Sessions use cwd without a registry and fail closed for an unknown scoped Workspace', async () => {
  const catalog = buildCatalog([blank('with-cwd', { cwd: '/w/alpha' }), blank('unknown-workspace')], undefined);
  const { directory, setScope } = directoryFor(catalog, ['/w/alpha']);
  assert.equal(await directory.permitted('with-cwd'), true);
  assert.equal(await directory.permitted('unknown-workspace'), false);
  setScope(['/w/beta']);
  assert.equal(await directory.permitted('with-cwd'), false);
  setScope([]);
  assert.equal(await directory.permitted('unknown-workspace'), true, 'an empty scope still means all Workspaces');
});

test('blank does not make archived, subagent or missing Sessions operable', async () => {
  const catalog = buildCatalog([
    blank('archived'), blank('subagent', { origin: 'subagent' }),
  ], {
    list: () => [{ id: 'alpha', path: '/w/alpha', title: 'Alpha', sessionIds: ['archived', 'subagent', 'missing'] }],
    archivedSessionIds: ['archived'], pinnedSessionIds: [],
  });
  const { directory } = directoryFor(catalog);
  for (const id of ['archived', 'subagent', 'missing']) {
    assert.equal(await directory.permitted(id), false, id);
  }
});
