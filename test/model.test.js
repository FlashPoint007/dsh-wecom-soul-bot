// Imports the TypeScript source directly (Node strips the erasable types).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advancedSlice, changedOperations, choiceLabel, contextLabel, displayPath, dshDefaultLabel, effortLabel,
  effortsFor, formatTokens, groupModelSummary, modelKey, modelLabel, modelName, parseModelKey, personKey,
  contextLevel, groupFacts, presetLabel, presetName, presetSummaryLabel, relativeTime, scopeSummary, sessionActivity, scopeIncludes, setLabel, setMemberModel, setSettings, settingsPatch,
  storedFrom, toggle, toggleScope, updateMember, validateAdvanced, validateCredentials,
} from '../src/client/model.ts';

test('the Config diff carries the Bot ID, and never the Secret the credential store owns', () => {
  const base = storedFrom({ botId: 'bot' });
  assert.deepEqual(changedOperations({ ...base, botId: ' bot-2 ' }, base), [
    { op: 'set', path: ['botId'], value: 'bot-2' },
  ]);
  // Normalization alone is not a change, so 保存 stays disabled.
  assert.deepEqual(changedOperations({ ...base, botId: ' bot ' }, base), []);
  // The Secret reference is not a form field: the value is written to the
  // credential store and the reference identifies it, so neither is diffed.
  assert.deepEqual(changedOperations({ ...base, secretEnv: 'OTHER_REF' }, base), []);
  assert.deepEqual(changedOperations(base, base), []);
});

test('the reduced Config form holds the connection identity and drops everything else', () => {
  assert.deepEqual(storedFrom(undefined), { botId: '', secretEnv: 'WECOM_SOUL_BOT_SECRET' });
  assert.deepEqual(storedFrom({ botId: 'bot', secretEnv: '  ' }), { botId: 'bot', secretEnv: 'WECOM_SOUL_BOT_SECRET' });
  // Administrators and the advanced knobs belong to the store's settings block
  // now; a Config snapshot that still carries them contributes nothing.
  assert.deepEqual(
    storedFrom({ botId: 'bot', secretEnv: 'REF', adminUserIds: ['root'], adminWorkspaces: ['/w'], wsUrl: 'wss://x', questionTimeoutMs: 30000 }),
    { botId: 'bot', secretEnv: 'REF' },
  );
});

test('each Config card validates only its own fields', () => {
  assert.deepEqual(Object.keys(validateCredentials({ botId: '', secret: '' }, false)).sort(), ['botId', 'secret']);
  assert.deepEqual(validateCredentials({ botId: 'bot', secret: 's' }, false), {});
  assert.deepEqual(validateCredentials({ botId: 'bot', secret: '' }, true), {}, 'a stored Secret may be kept');
});

test('the 连接与日志 fields are validated against the store bounds the Host enforces', () => {
  const advanced = { wsUrl: '', questionTimeoutMs: 60000, logRetentionDays: 14 };
  assert.deepEqual(validateAdvanced(advanced), {});
  assert.deepEqual(validateAdvanced({ ...advanced, wsUrl: 'wss://openws.example' }), {});
  assert.deepEqual(Object.keys(validateAdvanced({ ...advanced, wsUrl: 'ws://x' })), ['wsUrl']);
  assert.deepEqual(Object.keys(validateAdvanced({ ...advanced, wsUrl: 'wss://u:p@x' })), ['wsUrl'], 'credentials in the URL are refused');
  assert.deepEqual(Object.keys(validateAdvanced({ ...advanced, wsUrl: 'notaurl' })), ['wsUrl']);

  // 1–365 whole days.
  assert.deepEqual(validateAdvanced({ ...advanced, logRetentionDays: 1 }), {});
  assert.deepEqual(validateAdvanced({ ...advanced, logRetentionDays: 365 }), {});
  assert.deepEqual(Object.keys(validateAdvanced({ ...advanced, logRetentionDays: 0 })), ['logRetentionDays']);
  assert.deepEqual(Object.keys(validateAdvanced({ ...advanced, logRetentionDays: 366 })), ['logRetentionDays']);
  assert.deepEqual(Object.keys(validateAdvanced({ ...advanced, logRetentionDays: 1.5 })), ['logRetentionDays'], 'a fraction of a day is not a day');
  assert.equal(validateAdvanced({ ...advanced, logRetentionDays: 0.5 }).logRetentionDays, '请输入 1–365 的整数天数。');

  assert.equal('questionTimeoutMs' in validateAdvanced({ ...advanced, questionTimeoutMs: 0 }), false, 'legacy timeout is no longer a UI field');

});

test('a settings patch carries only the fields the operator moved', () => {
  const stored = advancedSlice({
    wsUrl: 'wss://openws.example', adminUserIds: [], adminWorkspaces: [],
    questionTimeoutMs: 60000, remoteApprovals: false, logEnabled: true, logRetentionDays: 14,
  });
  assert.deepEqual(stored, {
    wsUrl: 'wss://openws.example', logEnabled: true, logRetentionDays: 14,
  });
  assert.deepEqual(settingsPatch(stored, stored), {}, 'an untouched card produces no write at all');
  assert.deepEqual(settingsPatch({ ...stored, questionTimeoutMs: 30000, remoteApprovals: false }, stored), {}, 'legacy fields are never written by the UI');
  assert.deepEqual(settingsPatch({ ...stored, logRetentionDays: 30 }, stored), { logRetentionDays: 30 });
  // The endpoint is written trimmed, and only when it really moved.
  assert.deepEqual(settingsPatch({ ...stored, wsUrl: ' wss://other.example ' }, stored), { wsUrl: 'wss://other.example' });
  assert.deepEqual(settingsPatch({ ...stored, wsUrl: '  wss://openws.example  ' }, stored), {});

  // A deployment that has not answered the state route yet still has a draft.
  assert.deepEqual(advancedSlice(undefined), {
    wsUrl: '', logEnabled: true, logRetentionDays: 14,
  });

  // One op carries the whole patch, and it is the store op the page posts.
  assert.deepEqual(setSettings({ logRetentionDays: 30 }), {
    op: 'settings.set', patch: { logRetentionDays: 30 },
  });
  assert.deepEqual(setSettings({ adminUserIds: ['root'] }), {
    op: 'settings.set', patch: { adminUserIds: ['root'] },
  });
});


const CATALOG = {
  choices: [
    { provider: 'p', providerName: 'Provider', model: 'm', name: 'Model' },
    { provider: 'p', providerName: 'Provider', model: 'r', name: 'Reasoner', efforts: [{ id: 'low', name: '低' }], defaultEffort: 'low' },
  ],
  dshDefault: { provider: 'p', model: 'm' },
  failures: [],
  fetchedAt: 1,
};

test('model helpers round-trip the provider/model key and label the default', () => {
  assert.equal(modelKey('p', 'm'), 'p\u0000m');
  assert.equal(modelKey('', 'm'), '');
  assert.deepEqual(parseModelKey(modelKey('p', 'm')), { provider: 'p', model: 'm' });
  assert.deepEqual(parseModelKey(''), { provider: '', model: '' });
  assert.equal(choiceLabel(CATALOG.choices[0]), 'Model（m）');
  assert.equal(modelLabel(CATALOG, { provider: 'p', model: 'r' }), 'Reasoner（r）');
  assert.equal(modelLabel(CATALOG, { provider: 'x', model: 'y' }), 'x/y');
  assert.equal(dshDefaultLabel(CATALOG), '跟随 DSH 默认模型（Model）', 'the id is left out where space is tight');
  assert.equal(modelName(CATALOG, { provider: 'p', model: 'r' }), 'Reasoner');
  assert.equal(modelName(CATALOG, { provider: 'x', model: 'y' }), 'y');
  assert.equal(dshDefaultLabel(null), '跟随 DSH 默认模型');
  assert.deepEqual(effortsFor(CATALOG, 'p', 'r').map(effort => effort.id), ['low']);
  assert.deepEqual(effortsFor(CATALOG, 'p', 'm'), []);
});

const GROUP = {
  id: 'g1', name: '朋友', isDefault: false, workspace: '', workspaceTitle: '企业微信',
  workspacePath: '/home/.dsh/wecom-soul-bot/workspace', provider: 'p', model: 'r', permission: 'read-only',
  effectiveProvider: 'p', effectiveModel: 'r', members: [], memberCount: 0, messages: 0,
};
const MEMBER = {
  key: 'user:alice', kind: 'user', id: 'alice', label: '', displayName: 'alice', admin: false,
  sessionId: 'session-1', sessionTitle: '修复登录', sessionState: 'bound', sessionRunning: false,
  messages: 2, lastSeenAt: 5, createdAt: 1,
};

test('a group summary names the model it runs, and a member falls back to its WeCom id', () => {
  assert.equal(groupModelSummary(CATALOG, GROUP), 'Reasoner', 'the name alone fits the one-line overview');
  assert.equal(groupModelSummary(CATALOG, { ...GROUP, effectiveProvider: '', effectiveModel: '' }), 'Model（DSH 默认）');
  assert.equal(groupModelSummary(null, { ...GROUP, effectiveProvider: '', effectiveModel: '' }), 'DSH 默认');
  assert.equal(personKey('user', 'alice'), 'user:alice');
  assert.deepEqual(setLabel('user:alice', '爱丽丝'), { op: 'label.set', key: 'user:alice', label: '爱丽丝' });
  assert.deepEqual(setMemberModel('user:alice', 'session-1', { provider: 'p', model: 'r', reasoningEffort: 'low' }), {
    op: 'member.model', key: 'user:alice', sessionId: 'session-1', selection: { provider: 'p', model: 'r', reasoningEffort: 'low' },
  });
  assert.deepEqual(updateMember('user:alice', { groupId: 'g1' }), {
    op: 'member.update', key: 'user:alice', patch: { groupId: 'g1' },
  });
});

const PRESETS = {
  presets: [
    { id: 'standard', isDefault: true },
    { id: 'ptc', name: 'PTC 模式' },
    { id: 'custom' },
  ],
  fetchedAt: 1,
};

test('presets are named by their published name, the shipped one, or the id', () => {
  assert.equal(presetName(PRESETS.presets[0]), '标准模式', 'a shipped preset is named the way DSH names it');
  assert.equal(presetName(PRESETS.presets[1]), 'PTC 模式');
  assert.equal(presetName(PRESETS.presets[2]), 'custom', 'an unknown id names itself');
  assert.equal(presetLabel(PRESETS, 'ptc'), 'PTC 模式');
  assert.equal(presetLabel(PRESETS, 'gone'), 'gone');
  assert.equal(presetLabel(PRESETS, ''), '跟随 DSH 默认（标准模式）');
  assert.equal(presetLabel(null, ''), '跟随 DSH 默认');
  assert.equal(presetLabel({ presets: [], fetchedAt: 1 }, ''), '跟随 DSH 默认');
});

test('a summary names the preset a group actually runs, marking the DSH default', () => {
  assert.equal(presetSummaryLabel(PRESETS, 'ptc'), 'PTC 模式');
  assert.equal(presetSummaryLabel(PRESETS, ''), '标准模式（DSH 默认）', 'the fallback is named, not spelled out');
  assert.equal(presetSummaryLabel(PRESETS, 'gone'), 'gone');
  assert.equal(presetSummaryLabel(null, ''), 'DSH 默认');
  assert.equal(presetSummaryLabel({ presets: [], fetchedAt: 1 }, ''), 'DSH 默认');
});

test('an effort is named from the catalog, and context occupancy is compact', () => {
  assert.equal(effortLabel(CATALOG, { provider: 'p', model: 'r', reasoningEffort: 'low' }), '低');
  assert.equal(effortLabel(CATALOG, { provider: 'p', model: 'r', reasoningEffort: 'gone' }), 'gone');
  assert.equal(effortLabel(CATALOG, { provider: 'p', model: 'm' }), '');
  assert.equal(effortLabel(CATALOG, undefined), '');
  assert.equal(formatTokens(812), '812');
  assert.equal(formatTokens(12_300), '12.3k');
  assert.equal(formatTokens(200_000), '200k');
  assert.equal(formatTokens(1_200_000), '1.2M');
  assert.equal(contextLabel({ used: 12_300, window: 200_000 }), '12.3k / 200k（6%）');
  assert.equal(contextLabel({ used: 900 }), '900');
  assert.equal(contextLabel(undefined), '');
});

test('the notification scope is all-or-nothing: checking everything stores an empty list', () => {
  const all = ['/w/a', '/w/b'];
  assert.equal(scopeIncludes([], '/w/a'), true, 'empty means every Workspace');
  assert.equal(scopeIncludes(['/w/a'], '/w/a'), true);
  assert.equal(scopeIncludes(['/w/a'], '/w/b'), false, 'an explicit list excludes the rest');
  // Unchecking one of two stores the remaining path; rechecking collapses to [].
  assert.deepEqual(toggleScope([], all, '/w/a', false), ['/w/b']);
  assert.deepEqual(toggleScope(['/w/b'], all, '/w/a', true), []);
  assert.deepEqual(toggleScope(['/w/a'], all, '/w/b', true), [], 'a list covering everything is the default');
  assert.deepEqual(toggleScope([], all, '/w/b', false), ['/w/a']);
});

test('list helpers toggle and shorten paths and times', () => {
  assert.deepEqual(toggle(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggle(['a', 'b'], 'a', false), ['b']);
  assert.equal(displayPath('/Users/me/work/app'), '~/work/app');
  assert.equal(displayPath('/srv/app'), '/srv/app');
  assert.equal(relativeTime(Date.now() - 10), '刚刚');
  assert.equal(relativeTime(undefined), '');
});

test('a group overview names its five facts, and the table its live state', () => {
  const facts = groupFacts({ ...GROUP, reasoningEffort: 'low', effectiveReasoningEffort: 'low', preset: '' }, CATALOG, PRESETS);
  assert.deepEqual(facts.map(fact => [fact.label, fact.value]), [
    ['工作区', '企业微信'], ['模型', 'Reasoner'], ['推理等级', '低'], ['Agent 预设', '标准模式（DSH 默认）'],
    ['工作区权限', '仅可查看'],
  ]);
  assert.equal(groupFacts({ ...GROUP, permission: 'danger-full-access' }, CATALOG, PRESETS)[4].value, '完全权限');
  assert.equal(groupFacts(GROUP, CATALOG, PRESETS)[2].value, '默认', 'an unset effort reads 默认 instead of vanishing');
  assert.equal(sessionActivity({ sessionState: 'bound', sessionRunning: true }), '运行中');
  assert.equal(sessionActivity({ sessionState: 'bound', sessionRunning: false }), '空闲');
  assert.equal(sessionActivity({ sessionState: 'blank', sessionRunning: false }), '待使用');
  assert.equal(contextLevel({ used: 10, window: 100 }), 'ok');
  assert.equal(contextLevel({ used: 70, window: 100 }), 'warn');
  assert.equal(contextLevel({ used: 95, window: 100 }), 'high');
  assert.equal(contextLevel({ used: 95 }), undefined);
  assert.equal(scopeSummary([], 3), '全部工作区');
  assert.equal(scopeSummary(['/a'], 3), '1 / 3 个工作区');
});
