import test from 'node:test';
import assert from 'node:assert/strict';
import { byteLength, extractSessionPointer, MAX_NOTICE_BYTES, MAX_REPLY_BYTES } from '../dist/host/bridge/format.js';
import {
  adminGrantedNotice, adminOnlyText, adminPrivateOnlyText, adminUnassignedText, approvalNotice, authorizedNotice, compactedText,
  deleteWarningText, deletedText, groupAssignedNotice, groupSessionRefusalText, HELP_TEXT, newSessionText,
  nothingToCompactText, promptFailedNotice, questionNotice, quotePointer, reviewNotice, sessionListText,
  questionAccessRefusalText, routingChangedText, turnCompleteNotice, unauthorizedText, workspaceListText,
} from '../dist/host/bridge/notices.js';

/**
 * The WeCom-facing copy is Markdown-rendered: these tests pin the *shape* of
 * every template (one header, flat lines, no tables) and the two things that
 * silently break if the copy is edited carelessly — a template exceeding the
 * reply budget, and a `/use` hint that no longer parses back to its Session.
 */

const group = (title, sessions) => ({ title, sessions: sessions.map(session => ({
  workspace: title, workspacePath: `/w/${title}`, groupKey: title, running: false, pinned: false, title: null, ...session,
})) });

const groups = [
  group('企业微信', [{ sessionId: 'session-9f3a1c7b2d4e', title: '修复登录 Bug' }]),
  group('dsh-workpet', [{ sessionId: 'session-77aa88bb99cc', running: true }]),
];

const summary = (overrides = {}) => ({
  sessionId: 'session-9f3a1c7b2d4e', reason: 'completed', steps: 3, toolCalls: {}, omittedBlocks: {},
  promptIds: [], assistantText: '改好了。', ...overrides,
});

test('every template fits the reply budget', () => {
  const long = '很长的助手回复。'.repeat(2000);
  const texts = [
    HELP_TEXT,
    adminOnlyText(),
    adminPrivateOnlyText(),
    groupSessionRefusalText('delete'),
    groupSessionRefusalText('compact'),
    unauthorizedText(),
    authorizedNotice('默认分组'),
    groupAssignedNotice('朋友'),
    adminGrantedNotice(),
    adminUnassignedText(),
    routingChangedText(),
    questionAccessRefusalText(),
    deleteWarningText('修复登录 Bug', 'session-9f3a1c7b2d4e'),
    deletedText(),
    nothingToCompactText(),
    newSessionText('企业微信', 'session-9f3a1c7b2d4e'),
    workspaceListText(Array.from({ length: 40 }, (_, index) => ({
      id: `w${index}`, path: `/Users/me/workspace-${index}`, title: `Workspace ${index}`,
      pluginOwned: false, sessionCount: index, archivedSessionCount: 0,
    })), '/Users/me/workspace-3').text,
    sessionListText(groups, 'session-9f3a1c7b2d4e').text,
    turnCompleteNotice(summary({ assistantText: long }), { title: '修复登录 Bug', workspace: '企业微信' }),
    questionNotice('session-9f3a1c7b2d4e', '修复登录 Bug', [
      { id: 'q1', question: '问题一'.repeat(200), options: [{ label: '选项'.repeat(100), description: '说明'.repeat(200) }] },
      { id: 'q2', question: '问题二', multiSelect: true, options: [{ label: 'a' }] },
    ], 'a1b2c3', 60000),
    reviewNotice('session-9f3a1c7b2d4e', '修复登录 Bug'),
    approvalNotice('session-9f3a1c7b2d4e', '修复登录 Bug', { toolName: 'bash', reason: 'x'.repeat(2000) }, 'a1b2c3', 60000),
    promptFailedNotice('session-9f3a1c7b2d4e', '修复登录 Bug'),
  ];
  for (const text of texts) {
    assert.ok(byteLength(text) <= MAX_NOTICE_BYTES, `notice within ${MAX_NOTICE_BYTES} bytes: ${text.slice(0, 60)}…`);
  }
});

test('every per-Session notice carries a /use hint that resolves back to it', () => {
  const notices = [
    turnCompleteNotice(summary(), { title: '修复登录 Bug', workspace: '企业微信' }),
    questionNotice('session-9f3a1c7b2d4e', '修复登录 Bug', [{ id: 'q', question: 'Q?' }], 'a1b2c3', 60000),
    reviewNotice('session-9f3a1c7b2d4e', '修复登录 Bug'),
    approvalNotice('session-9f3a1c7b2d4e', '修复登录 Bug', { toolName: 'bash' }, 'a1b2c3', 60000),
    promptFailedNotice('session-9f3a1c7b2d4e', '修复登录 Bug'),
  ];
  for (const text of notices) {
    const token = extractSessionPointer(text);
    assert.ok(token, 'the notice carries a /use hint');
    assert.ok('session-9f3a1c7b2d4e'.startsWith(token), `the hint is a prefix of the Session id: ${token}`);
  }
});

test('a hint is the only /use occurrence the quote parser can pick up', () => {
  // The footer of /sessions must never read like `/use <something resolvable>`,
  // or quoting a session list would silently switch the administrator.
  const listing = sessionListText(groups, undefined);
  assert.deepEqual(listing.listing, ['session-9f3a1c7b2d4e', 'session-77aa88bb99cc']);
  assert.equal(extractSessionPointer(listing.text), undefined);
  for (const text of [
    HELP_TEXT, adminOnlyText(), adminPrivateOnlyText(), unauthorizedText(), authorizedNotice('默认分组'),
    groupAssignedNotice('朋友'), adminGrantedNotice(), adminUnassignedText(), routingChangedText(), questionAccessRefusalText(),
  ]) {
    assert.equal(extractSessionPointer(text), undefined);
  }
  // A group refusal names the command in inline code — `/delete`, never `/use`.
  assert.equal(extractSessionPointer(groupSessionRefusalText('delete')), undefined);
  // A member's /sessions footer and every refusal name `序号`, never `/use <word>`.
  assert.match(HELP_TEXT, /\/use/);
  assert.equal(extractSessionPointer(quotePointer('session-9f3a1c7b2d4e')), 'session-9f3a1c7b2d4e');
  assert.equal(extractSessionPointer(quotePointer('session-abcdefghijklmnop')), 'session-abcdefghijkl');
});

test('the session list numbers rows across Workspaces and marks the current one', () => {
  const { text } = sessionListText(groups, 'session-77aa88bb99cc');
  assert.match(text, /^\*\*🗂 可切换的会话\*\* · 共 2 个$/m);
  assert.match(text, /^\*\*📁 企业微信\*\*$/m);
  assert.match(text, /^\*\*📁 dsh-workpet\*\*$/m);
  assert.match(text, /^1\. 修复登录 Bug · session-9f3a1c7b2d…$/m);
  assert.match(text, /^2\. 未命名会话 · session-77aa88bb99…（运行中 · 当前）$/m);
});

test('untrusted titles cannot inject Markdown, mentions or tags', () => {
  const hostile = '**bold** <@all> [link](https://x) `code`';
  const { text } = sessionListText([group('企业微信', [{ sessionId: 'session-aaa111bbb222', title: hostile }])], undefined);
  assert.doesNotMatch(text, /\*\*bold\*\*/);
  assert.doesNotMatch(text, /<@all>/);
  assert.doesNotMatch(text, /\]\(https:\/\/x\)/);
  assert.doesNotMatch(text, /`code`/);

  const notice = turnCompleteNotice(summary(), { title: hostile, workspace: '企业微信' });
  assert.doesNotMatch(notice.split('\n')[0], /\*\*bold\*\*/);
});

test('/help documents every command the bridge answers to', () => {
  for (const command of ['/help', '/status', '/whoami', '/compact', '/delete', '/cancel', '/answer', '/approve', '/deny',
    '/new', '/workspaces', '/sessions', '/use', '/reset']) {
    assert.ok(HELP_TEXT.includes(command), `/help mentions ${command}`);
  }
});

test('a refused sender is told to ask an operator, and an operator greeting names the group', () => {
  assert.match(unauthorizedText(), /\*\*🔒 用户未授权\*\*/);
  assert.match(unauthorizedText(), /请联系管理员/);
  assert.match(authorizedNotice('默认分组'), /管理员已授权，可以开始使用了/);
  assert.match(authorizedNotice('默认分组'), /默认分组/);
  assert.match(authorizedNotice('默认分组'), /`\/help`/);
});

test('a promotion and a group move each say what changed, without a jump hint', () => {
  const promoted = adminGrantedNotice();
  assert.match(promoted, /\*\*🔑 你已被设为管理员\*\*/);
  assert.match(promoted, /审批/);
  assert.match(promoted, /只能在单聊里发送/);
  assert.match(promoted, /`\/sessions`/);
  assert.equal(extractSessionPointer(promoted), undefined);

  const moved = groupAssignedNotice('朋友');
  assert.match(moved, /\*\*🔀 你已被调整到新的分组\*\*/);
  assert.match(moved, /朋友/);
  assert.match(moved, /之前分组的会话绑定已解除/);
  assert.match(moved, /恢复那个会话/);
  assert.match(moved, /否则下一条消息.*新建会话/);
  assert.equal(extractSessionPointer(moved), undefined);
});

test('/delete warns what it clears and how to confirm', () => {
  const warning = deleteWarningText('修复登录 Bug', 'session-9f3a1c7b2d4e');
  assert.match(warning, /归档会话会清空它的记忆/);
  assert.match(warning, /\/delete confirm/);
  assert.match(warning, /《修复登录 Bug》/);
  assert.equal(extractSessionPointer(warning), undefined, 'it must not double as a jump hint');
  assert.match(deletedText(), /会话已归档/);
  assert.match(deletedText(), /下一条消息.*新/);
});

test('/compact reports what it folded, and says when there was nothing', () => {
  assert.match(compactedText(3, 1234), /3 条历史/);
  assert.match(compactedText(3, 1234), /1234 tokens/);
  assert.match(nothingToCompactText(), /没有可压缩的历史/);
});

test('an administrator command sent in a group says why it is refused there', () => {
  assert.match(adminPrivateOnlyText(), /\*\*🔒 管理员命令只能在单聊中使用\*\*/);
  assert.match(adminPrivateOnlyText(), /群聊里的会话是所有人共用的/);
  assert.match(adminPrivateOnlyText(), /请在与机器人的单聊里发送/);
  assert.match(adminOnlyText(), /只有插件配置里列出的管理员可以使用/);
  // /help says the same thing up front, instead of letting the reader find out.
  assert.match(HELP_TEXT, /只能在单聊里发送/);
});

test('a Session command refused in a group names the shared Session and the private chat', () => {
  const deleting = groupSessionRefusalText('delete');
  assert.match(deleting, /\*\*🔒 群聊的会话记录只有管理员可以归档\*\*/);
  assert.match(deleting, /所有人共用/);
  assert.match(deleting, /`\/delete`/);
  assert.match(deleting, /自己的专属会话/);
  const compacting = groupSessionRefusalText('compact');
  assert.match(compacting, /只有管理员可以压缩/);
  assert.match(compacting, /`\/compact`/);
});

test('/workspaces numbers every Workspace and marks the chosen one', () => {
  const list = Array.from({ length: 3 }, (_, index) => ({
    id: `w${index}`, path: `/Users/me/ws-${index}`, title: `WS ${index}`,
    pluginOwned: false, sessionCount: 0, archivedSessionCount: 0,
  }));
  const { text, listing } = workspaceListText(list, '/Users/me/ws-1');
  assert.deepEqual(listing, list.map(workspace => workspace.path));
  assert.match(text, /1\. WS 0/);
  assert.match(text, /2\. WS 1 — ~\/ws-1（当前默认）/);
  assert.match(text, /\/workspaces 序号/);
  assert.match(workspaceListText([], '').text, /还没有注册任何 Workspace/);
});

test('a long session list is truncated but still reports the real total', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ sessionId: `session-${String(index).padStart(4, '0')}aaaaaa`, title: `任务 ${index}` }));
  const { text, listing } = sessionListText([group('企业微信', many)], undefined);
  assert.equal(listing.length, 30);
  assert.match(text, /共 40 个/);
  assert.match(text, /… 另有 10 个未显示/);
  assert.equal(text.split('\n').length <= 45, true);
  assert.ok(byteLength(text) <= MAX_REPLY_BYTES);
});
