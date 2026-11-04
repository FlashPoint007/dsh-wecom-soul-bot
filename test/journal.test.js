import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal, pluginHome, resolveDshHome, sanitize } from '../dist/host/journal.js';

test('DSH home follows $DSH_HOME, else ~/.dsh; plugin data lives in its own directory', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/data/dsh' }), '/data/dsh');
  assert.match(resolveDshHome({}), /\.dsh$/);
  assert.match(resolveDshHome({ DSH_HOME: '   ' }), /\.dsh$/);
  assert.equal(pluginHome({ DSH_HOME: '/data/dsh' }), '/data/dsh/wecom-soul-bot');
});

test('sanitize redacts credentials, callback URLs and media keys, and scrubs known secrets anywhere', () => {
  const error = Object.assign(new Error('auth failed for TOPSECRET123'), { code: 'E_AUTH' });
  const value = sanitize({
    body: { response_url: 'https://cb', image: { url: 'https://img', aeskey: 'k' }, text: { content: 'hi TOPSECRET123' } },
    secret: 'x', Authorization: 'Bearer y', nested: [{ token: 't' }], error, fn() {}, big: 10n,
  }, ['TOPSECRET123']);
  assert.deepEqual(value, {
    body: { response_url: '[redacted]', image: { url: '[redacted-url]', aeskey: '[redacted]' }, text: { content: 'hi [redacted]' } },
    secret: '[redacted]', Authorization: '[redacted]', nested: [{ token: '[redacted]' }],
    error: { name: 'Error', message: 'auth failed for [redacted]', code: 'E_AUTH' }, big: '10',
  });
  const circular = { a: 1 };
  circular.self = circular;
  assert.deepEqual(sanitize(circular), { a: 1, self: '[circular]' });
});

test('journal appends one JSON object per line to a private daily file and prunes expired days', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'wecom-journal-')), 'logs');
  const now = new Date(2026, 9, 16, 12, 0, 0);
  const journal = createJournal({ directory, enabled: () => true, retentionDays: () => 2, now: () => now, secrets: () => ['S3CRET-VALUE'] });
  journal.write({ event: 'round.complete', roundId: 'r1', request: { text: '你好 S3CRET-VALUE' } });
  journal.write({ event: 'wecom.send', level: 'warn', chatId: 'alice' });
  await journal.flush();
  await writeFile(join(directory, '2026-10-01.jsonl'), '{}\n');
  await writeFile(join(directory, '2026-10-15.jsonl'), '{}\n');
  await writeFile(join(directory, 'notes.txt'), 'keep');
  const next = createJournal({ directory, enabled: () => true, retentionDays: () => 2, now: () => now });
  next.write({ event: 'plugin.start' });
  await next.close();

  const file = join(directory, '2026-10-16.jsonl');
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.event), ['round.complete', 'wecom.send', 'plugin.start']);
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].request.text, '你好 [redacted]');
  assert.equal(lines[1].level, 'warn');
  assert.equal(lines[0].seq, 1);
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).sort(), ['2026-10-15.jsonl', '2026-10-16.jsonl', 'notes.txt']);
  assert.equal(journal.info().file, file);
});

test('a retention edit takes effect on the next write, not the next day', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'wecom-journal-')), 'logs');
  const now = new Date(2026, 9, 16, 12, 0, 0);
  let keepDays = 14;
  const journal = createJournal({ directory, enabled: () => true, retentionDays: () => keepDays, now: () => now });
  journal.write({ event: 'plugin.start' });
  await journal.flush();
  await writeFile(join(directory, '2026-10-10.jsonl'), '{}\n');
  await writeFile(join(directory, '2026-10-15.jsonl'), '{}\n');

  // What ⑤连接与日志 does while the plugin keeps running: the same journal now
  // keeps one day. Waiting for tomorrow (or a restart) would leave 14-day files.
  keepDays = 1;
  journal.write({ event: 'settings.set' });
  await journal.close();
  assert.deepEqual((await readdir(directory)).sort(), ['2026-10-16.jsonl']);
});

test('a disabled journal writes nothing', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'wecom-journal-')), 'logs');
  const journal = createJournal({ directory, enabled: () => false, retentionDays: () => 14 });
  journal.write({ event: 'round.complete' });
  await journal.close();
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});
