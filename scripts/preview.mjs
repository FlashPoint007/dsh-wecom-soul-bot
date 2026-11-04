// Render the built settings page with sample data inside a look-alike of the
// DSH Plugin Manager's package page (real DSH token values, the primitives'
// own CSS and Modal structure), then screenshot it with Google Chrome:
//   node scripts/preview.mjs [--dark] [--empty] [--session]
// Output: preview/index.html and preview/settings[-dark|-empty|-session].png.
// It is the README's screenshot tool, not a substitute for checking the live page.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'preview');
const dark = process.argv.includes('--dark');
const empty = process.argv.includes('--empty');
// The Session details: the member table's pill opens them, nothing navigates.
const session = process.argv.includes('--session');
const read = path => readFile(resolve(root, path), 'utf8');

const now = Date.now();
const REPO = '/Users/me/Workspace/learn/dsh-wecom-soul-bot';
const PLUGIN_WS = '/Users/me/.dsh/wecom-soul-bot/workspace';
const state = {
  version: '0.5',
  connection: empty ? { phase: 'unconfigured', since: now - 30_000, detail: '缺少 Bot ID' } : { phase: 'online', since: now - 25 * 60_000 },
  traffic: empty ? { since: now, received: 0, rejected: 0, prompts: 0, notifications: 0, failures: 0 }
    : { since: now - 3_600_000, received: 21, rejected: 2, prompts: 9, notifications: 11, failures: 0, lastMessageAt: now - 90_000 },
  rejected: empty ? [] : [
    {
      key: 'user:WangWu', kind: 'user', id: 'WangWu', chatType: 'single',
      label: '', displayName: 'WangWu',
      text: '帮我看下这个仓库的登录问题，谢谢！', messages: 3,
      firstSeenAt: now - 1_800_000, lastSeenAt: now - 240_000,
    },
    {
      key: 'group:wrOgCCCCCCCCstrangers', kind: 'group', id: 'wrOgCCCCCCCCstrangers', chatType: 'group',
      label: '外部合作群', displayName: '外部合作群',
      text: '@机器人 明天上午十点的评审在哪个会议室？', messages: 1,
      firstSeenAt: now - 900_000, lastSeenAt: now - 900_000,
    },
  ],
  sessions: {
    groups: [
      { key: 'w1', kind: 'workspace', title: 'dsh-wecom-soul-bot', path: REPO, sessions: [
        { sessionId: '0dd82b7f-516c-41dc-b0a0-ac95e596a05a', title: '企业微信 Bot 插件开发', running: true, pinned: true, updatedAt: now - 60_000, model: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }, preset: 'standard', context: { used: 128_000, window: 128_000 } },
        { sessionId: 'fa761602-210c-4653-8dc6-9d74e1f71507', title: '配置页重构与日志', running: false, pinned: false, updatedAt: now - 3 * 3_600_000, model: { provider: 'deepseek-account', model: 'deepseek-chat' }, preset: 'minimal' },
        { sessionId: '8e05784f-03c2-41a7-b675-7a60b64efa01', title: null, running: false, pinned: false, updatedAt: now - 2 * 86_400_000 },
      ] },
      { key: 'w3', kind: 'workspace', title: '企业微信', path: PLUGIN_WS, sessions: [
        { sessionId: '934bf135-e3e5-4c8e-9784-45ddc1457c05', title: '周报整理', running: false, pinned: false, updatedAt: now - 5 * 86_400_000, model: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }, preset: 'standard', context: { used: 12_300, window: 128_000 } },
        { sessionId: '5b19e0f2-6d3a-4a1e-9d3f-1a2b3c4d5e6f', title: '群里的运维问答', running: true, pinned: false, updatedAt: now - 2 * 86_400_000, model: { provider: 'deepseek-account', model: 'deepseek-chat' }, preset: 'ptc', context: { used: 41_000, window: 128_000 } },
      ] },
      { key: 'ungrouped', kind: 'ungrouped', title: '未分组', sessions: [
        { sessionId: 'db3af9bd-edb8-4c11-8869-9e63c4174f9c', title: '临时问题', running: false, pinned: false, updatedAt: now - 9 * 86_400_000 },
      ] },
    ],
    total: 6, archived: 7, generatedAt: now - 2000,
    hiddenSelections: [],
  },
  routing: {
    total: empty ? 0 : 4,
    full: false,
    groups: [
      {
        id: 'default', name: '默认分组', isDefault: true,
        workspace: '', workspaceTitle: '企业微信', workspacePath: PLUGIN_WS,
        // No model of its own: the header says it follows the DSH default.
        provider: '', model: '', effectiveProvider: '', effectiveModel: '', preset: '',
        memberCount: empty ? 0 : 3, messages: empty ? 0 : 20, lastSeenAt: now - 90_000,
        members: empty ? [] : [
          {
            key: 'user:ZhangSan', kind: 'user', id: 'ZhangSan', label: '张三', displayName: '张三', admin: true,
            sessionId: '934bf135-e3e5-4c8e-9784-45ddc1457c05', sessionTitle: '周报整理',
            sessionState: 'bound', sessionRunning: false,
            sessionModel: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' },
            sessionPreset: 'standard', sessionContext: { used: 12_300, window: 128_000 },
            messages: 14, lastSeenAt: now - 90_000, createdAt: now - 3_600_000,
          },
          {
            key: 'user:LiSi', kind: 'user', id: 'LiSi', label: '', displayName: 'LiSi', admin: false,
            sessionId: '', sessionTitle: null, sessionState: 'auto', sessionRunning: false,
            messages: 2, lastSeenAt: now - 600_000, createdAt: now - 1_800_000,
          },
          {
            key: 'group:wrOgAAAAAAAAexample', kind: 'group', id: 'wrOgAAAAAAAAexample', label: '', displayName: 'wrOgAAAAAAAAexample', admin: false,
            sessionId: '5b19e0f2-6d3a-4a1e-9d3f-1a2b3c4d5e6f', sessionTitle: '群里的运维问答',
            sessionState: 'bound', sessionRunning: true,
            sessionModel: { provider: 'deepseek-account', model: 'deepseek-chat' },
            sessionPreset: 'ptc', sessionContext: { used: 41_000, window: 128_000 },
            messages: 4, lastSeenAt: now - 600_000, createdAt: now - 1_800_000,
          },
        ],
      },
      {
        id: 'g1', name: '同事', isDefault: false,
        workspace: REPO, workspaceTitle: 'dsh-wecom-soul-bot', workspacePath: REPO,
        provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high', preset: 'ptc',
        effectiveProvider: 'deepseek-account', effectiveModel: 'deepseek-reasoner', effectiveReasoningEffort: 'high',
        memberCount: empty ? 0 : 1, messages: 0,
        members: empty ? [] : [
          {
            key: 'group:wrOgBBBBBBBBother', kind: 'group', id: 'wrOgBBBBBBBBother', label: '研发群', displayName: '研发群', admin: false,
            sessionId: '0dd82b7f-516c-41dc-b0a0-ac95e596a05a', sessionTitle: '企业微信 Bot 插件开发',
            sessionState: 'bound', sessionRunning: true,
            sessionModel: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' },
            sessionPreset: 'standard', sessionContext: { used: 61_500, window: 128_000 },
            messages: 6, lastSeenAt: now - 3 * 3_600_000, createdAt: now - 86_400_000,
          },
        ],
      },
    ],
  },
  models: {
    choices: [
      { provider: 'deepseek-account', providerName: 'DeepSeek', model: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'deepseek-account', providerName: 'DeepSeek', model: 'deepseek-reasoner', name: 'DeepSeek Reasoner', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' },
      { provider: 'pi-ai', providerName: 'Pi AI', model: 'gpt-5', name: 'GPT-5' },
    ],
    dshDefault: { provider: 'deepseek-account', model: 'deepseek-chat' },
    failures: [], fetchedAt: now - 12_000,
  },
  presets: {
    presets: [
      { id: 'standard', isDefault: true },
      { id: 'ptc' },
      { id: 'minimal' },
      { id: 'cordis' },
    ],
    fetchedAt: now - 12_000,
  },
  workspaces: [
    { id: 'w1', path: REPO, title: 'dsh-wecom-soul-bot', pluginOwned: false, sessionCount: 3, archivedSessionCount: 4 },
    { id: 'w3', path: PLUGIN_WS, title: '企业微信', pluginOwned: true, sessionCount: 2, archivedSessionCount: 7 },
    // Every Session archived: it can never notify anybody, but the list still
    // shows it so the operator can see the whole Workspace set.
    { id: 'w9', path: '/Users/me/Workspace/orion-agent', title: 'orion-agent', pluginOwned: false, sessionCount: 0, archivedSessionCount: 32 },
  ],
  admins: empty ? [] : [{ id: 'ZhangSan', label: '张三', displayName: '张三', groupName: '默认分组' }],
  // The store's settings block; the ④ and ⑤ cards read it from here. An empty
  // `adminWorkspaces` is the documented default: every Workspace, every box checked.
  settings: empty
    ? {
      wsUrl: '', adminUserIds: [], adminWorkspaces: [], questionTimeoutMs: 60000,
      remoteApprovals: false, logEnabled: true, logRetentionDays: 14,
    }
    : {
      wsUrl: '', adminUserIds: ['ZhangSan'], adminWorkspaces: [], questionTimeoutMs: 30000,
      remoteApprovals: true, logEnabled: true, logRetentionDays: 14,
    },
  notices: [],
  journal: { enabled: true, directory: '/Users/me/.dsh/wecom-soul-bot/logs', file: '/Users/me/.dsh/wecom-soul-bot/logs/2026-10-16.jsonl', retentionDays: 14 },
};
// A fresh install has the built-in group only.
if (empty) state.routing.groups = state.routing.groups.filter(group => group.isDefault);
// The Config the 连接 section edits: the connection identity, nothing else.
const stored = empty ? { botId: '' } : { botId: 'aibAbCdEfGh123456' };

// DSH's own light/dark alias values (dsh-client-ui-theme), for every token the
// page and the primitives read.
const TOKENS = {
  light: {
    'bg-base': '#fff', 'bg-layer-1': '#fff', 'bg-layer-2': '#fff', 'bg-layer-3': '#fff', 'bg-module-platform': '#f5f6f7',
    'bg-mask-1': '#0000003d',
    'border-l1': '#0000000a', 'border-l2': '#0000001a', 'border-l3': '#0000001f', 'border-l4': '#00000029',
    'brand-primary': '#0f1115', 'button-primary-fill': '#0f1115', 'button-primary-hover': '#43454a', 'label-primary-foreground': '#fff',
    'interactive-bg-hover': '#2631480f', 'interactive-bg-active': '#2631481a', 'interactive-bg-hover-danger': '#ec13130d',
    'label-primary': '#0f1115', 'label-secondary': '#61666b', 'label-tertiary': '#81858c', 'label-caption': '#adb2b8', 'label-dimmed': '#e1e5ee',
    'state-business-primary': '#4176e6', 'state-error-primary': '#ec1313', 'state-success-primary': '#22c55e',
    'state-warn-primary': '#f59e0b', 'state-warn-label': '#dd8629', 'state-warn-tertiary': '#fef5e7', 'state-idle-primary': '#d4d4d4',
    'switch-thumb': '#fff', 'settings-card-fill': '#fff', 'settings-card-stroke': '#00000029',
  },
  dark: {
    'bg-base': '#151517', 'bg-layer-1': '#232324', 'bg-layer-2': '#2c2c2e', 'bg-layer-3': '#353638', 'bg-module-platform': '#353638',
    'bg-mask-1': '#00000080',
    'border-l1': '#ffffff0f', 'border-l2': '#ffffff1f', 'border-l3': '#ffffff29', 'border-l4': '#fff3',
    'brand-primary': '#f9fafb', 'button-primary-fill': '#f9fafb', 'button-primary-hover': '#ebeef2', 'label-primary-foreground': '#0f1115',
    'interactive-bg-hover': '#ffffff14', 'interactive-bg-active': '#ffffff24', 'interactive-bg-hover-danger': '#f25a5a26',
    'label-primary': '#f9fafb', 'label-secondary': '#cfd3d6', 'label-tertiary': '#adb2b8', 'label-caption': '#81858c', 'label-dimmed': '#43454a',
    'state-business-primary': '#7aaaff', 'state-error-primary': '#f25a5a', 'state-success-primary': '#22c55e',
    'state-warn-primary': '#f59e0b', 'state-warn-label': '#dd8629', 'state-warn-tertiary': '#27241f', 'state-idle-primary': '#545557',
    'switch-thumb': '#adb2b8', 'settings-card-fill': '#2c2c2e', 'settings-card-stroke': '#fff3',
  },
};
const tokens = Object.entries(TOKENS[dark ? 'dark' : 'light']).map(([key, value]) => `--dsw-alias-${key}:${value};`).join('')
  + '--dsw-radius-xl:20px;--dsw-radius-lg:16px;--dsw-radius-md:12px;--dsw-radius-sm:8px;--dsw-radius-xs:4px;--dsw-radius-panel:28px;'
  + '--dsw-focus-ring-width:2px;--ds-font-family-code:"SF Mono",Menlo,monospace;';

// The primitives' own CSS (dsh-web-frontend), renamed, plus the Plugin
// Manager's package-page chrome the slot renders inside.
const PRIMITIVES_CSS = `
.p-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px;height:36px;font-family:inherit}
.p-btn:disabled{cursor:not-allowed;opacity:.4}.p-btn.sm{height:28px;font-size:12px;line-height:18px;padding:0 10px;border-radius:var(--dsw-radius-sm)}
.p-btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.p-btn.ghost:hover:not(:disabled),.p-btn.outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.p-btn.outline{border:.5px solid var(--dsw-alias-border-l3)}.p-btn .ic{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center}
.p-input{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}
.p-input input{flex:1;min-width:0;border:none;outline:none;background:transparent;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);font-family:inherit}
.p-input input::placeholder{color:var(--dsw-alias-label-dimmed)}
.p-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}
.p-tag[data-tone=outline]{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.p-tag[data-tone=neutral]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.p-tag[data-tone=quiet]{color:var(--dsw-alias-label-tertiary)}
.p-tag[data-tone=warning]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}
.p-switch{box-sizing:border-box;position:relative;width:36px;height:20px;padding:2px;border-radius:999px;border:none;background:var(--dsw-alias-border-l3);cursor:pointer;flex:none}
.p-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.p-switch span{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb)}
.p-switch[aria-checked=true] span{transform:translate(16px);background:var(--dsw-alias-label-primary-foreground)}
.p-dot{position:relative;display:inline-block;flex:none}.p-dot:after{content:"";position:absolute;inset:20%;border-radius:50%;background:currentColor}
.p-dot[data-state=done]{color:var(--dsw-alias-state-success-primary)}.p-dot[data-state=warning]{color:var(--dsw-alias-state-warn-primary)}
.p-dot[data-state=error]{color:var(--dsw-alias-state-error-primary)}.p-dot[data-state=idle]{color:var(--dsw-alias-state-idle-primary)}
.p-dot[data-state=ongoing]{color:var(--dsw-alias-label-tertiary)}.p-dot[data-state=ongoing]:after{inset:10%;background:none;border:1.5px solid currentColor;border-right-color:transparent}
.p-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
.p-modal-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:blur(4px)}
.p-modal-dialog{box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);padding:0 0 24px;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:0 24px 60px #0004,0 0 0 .5px var(--dsw-alias-border-l1)}
.p-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.p-modal-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.p-modal-close{width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;cursor:pointer}
.p-modal-body{display:flex;flex-direction:column;min-width:0;margin-top:20px;padding:0 24px}
.p-modal-head+.p-modal-body{margin-top:8px}
.p-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.pm-page{max-width:960px;margin:0 auto;padding:0 40px 48px;color:var(--dsw-alias-label-primary)}
.pm-crumb{padding-top:28px;color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.pm-top{display:flex;align-items:center;justify-content:space-between;margin-top:32px}
.pm-icon{width:48px;height:48px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l3);display:grid;place-items:center;color:#07c160;font-weight:700}
.pm-title{display:flex;align-items:center;gap:8px;margin-top:20px}.pm-title h3{margin:0;font-size:20px;font-weight:500;line-height:28px}
.pm-name{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}.pm-desc{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.pm-sections{display:flex;flex-direction:column;gap:32px;margin-top:32px}
`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>WeCom Bot settings preview</title>
<style>body{${tokens}margin:0;background:var(--dsw-alias-bg-base);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}${PRIMITIVES_CSS}</style>
<script>${await read('node_modules/react/umd/react.development.js')}</script>
<script>${await read('node_modules/react-dom/umd/react-dom.development.js')}</script>
</head><body><div class="pm-page">
<div class="pm-crumb">‹ 插件</div>
<div class="pm-top"><div class="pm-icon">企</div><span class="p-switch" aria-checked="true" role="switch"><span></span></span></div>
<div class="pm-title"><h3>企业微信机器人</h3><span class="p-tag" data-tone="neutral">v0.5.1</span></div>
<p class="pm-name"><code>dsh-wecom-soul-bot</code></p>
<p class="pm-desc">把企业微信智能机器人接到 DeepSeek Harness：在企微里给机器人发消息，就是在对 DSH 的会话说话。</p>
<div class="pm-sections"><section id="root"></section></div>
</div>
<script>
// A failed render must be visible in the screenshot instead of a blank page.
window.addEventListener('error', event => {
  const detail = (event.error && event.error.stack) || event.message || 'unknown error';
  document.body.insertAdjacentHTML('afterbegin', '<pre style="color:#c00;padding:16px;white-space:pre-wrap">' + detail + '</pre>');
});
</script>
<script>
const STATE = ${JSON.stringify(state)};
const h = React.createElement;
const jsx = (type, props, key) => h(type, key === undefined ? props : { ...props, key });
const runtime = { jsx, jsxs: jsx, Fragment: React.Fragment };
const icon = path => ({ size = 16 }) => h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: path }));
const icons = {
  IconRefreshOutlineRegular: icon('M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3'),
  IconChevronRightOutlineRegular: icon('M6 3.5 10.5 8 6 12.5'),
  IconUserOutlineRegular: icon('M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 14.5a5.5 5.5 0 0 1 11 0'),
  IconUsersOutlineRegular: icon('M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 13.5a4.5 4.5 0 0 1 9 0M10.5 2.8a2.5 2.5 0 0 1 0 4.4M12 9.5a4.5 4.5 0 0 1 2.5 4'),
  IconWarningTriangleOutlineRegular: icon('M8 2 14.5 13.5h-13ZM8 6.5v3.5M8 11.8v.2'),
  IconCheckOutlineRegular: icon('M2.5 8.5 6 12l7.5-8'),
  IconCopyOutlineRegular: icon('M5.5 5.5h8v8h-8ZM10.5 5.5v-3h-8v8h3'),
  IconTrashOutlineRegular: icon('M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.8 9h6.4l.8-9M6.5 7v4M9.5 7v4'),
  IconPlusOutlineRegular: icon('M8 2.5v11M2.5 8h11'),
};
const primitives = {
  ...icons,
  Button: ({ variant = 'ghost', size = 'md', icon, className, children, ...rest }) => h('button', { type: 'button', ...rest, className: ['p-btn', variant, size, className].join(' ') }, icon && h('span', { className: 'ic' }, icon), children),
  Input: ({ icon, className, ...rest }) => h('span', { className: 'p-input ' + (className || '') }, h('input', rest)),
  Switch: ({ checked, onChange, label, disabled }) => h('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled, className: 'p-switch', onClick: () => onChange(!checked) }, h('span')),
  Tag: ({ tone = 'outline', className, children }) => h('span', { className: 'p-tag ' + (className || ''), 'data-tone': tone }, children),
  StateDot: ({ state, size = 12 }) => h('span', { className: 'p-dot', 'data-state': state, style: { width: size, height: size } }),
  // DSH's Modal: mask + dialog(className) > header(h2 + close), body, footer.
  Modal: ({ open, onClose, title, closeLabel, children, footer, className }) => (open
    ? ReactDOM.createPortal(
      h('div', { className: 'p-modal' },
        h('div', { className: 'p-modal-mask', onClick: onClose }),
        h('div', { className: ['p-modal-dialog', className || ''].join(' '), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'p-modal-head' },
            h('h2', { className: 'p-modal-title' }, title),
            h('button', { type: 'button', className: 'p-modal-close', 'aria-label': closeLabel, onClick: onClose }, '×')),
          children !== undefined && h('div', { className: 'p-modal-body' }, children),
          footer !== undefined && h('div', { className: 'p-modal-foot' }, footer))),
      document.body)
    : null),
  writeClipboard: async () => true,
};
const modules = { react: React, 'react/jsx-runtime': runtime, '@deepseek-ai/dsh-client-ui-primitives': primitives };
let entry;
window.__ModuleLoader__ = { load(value) { entry = value; } };
window.fetch = async (url, options) => {
  const body = options && options.method === 'POST' ? { ok: true, routing: STATE.routing } : STATE;
  return { ok: true, status: 200, json: async () => body };
};
</script>
<script>${await read('dist/client.js')}</script>
<script>
const plugin = entry.factory(name => modules[name]);
let snapshot = { status: 'ready', revision: 1, writable: true, value: ${JSON.stringify(stored)} };
const listeners = new Set();
const scope = {
  getSnapshot: () => snapshot,
  subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
  async mutate(ops) { const value = { ...snapshot.value }; for (const op of ops) value[op.path[0]] = op.value; snapshot = { ...snapshot, revision: snapshot.revision + 1, value }; listeners.forEach(l => l()); return true; },
};
const remote = { credentials: { async describe(refs) { return Object.fromEntries(refs.map(r => [r, { configured: ${!empty} }])); }, async set() {} } };
let page;
plugin.apply({
  get: name => ({
    slots: { inject: (key, fn) => fn(), register: (options, component) => { page = component; return () => {}; } },
    configForms: { get: () => scope, whileServed: (ns, fn) => fn() },
    remote,
  })[name],
  effect: fn => fn(),
});
ReactDOM.createRoot(document.getElementById('root')).render(page({ view: 'page' }));
// Groups open folded; the preview unfolds the first one to show its members.
if (!${empty}) setTimeout(() => { document.querySelector('.wcb-group-toggle')?.click(); }, 200);
if (${session}) setTimeout(() => { document.querySelector('[aria-label="查看 张三 的会话详情"]')?.click(); }, 450);
// Report the rendered height so the screenshot is cut to the page.
setTimeout(() => { document.title = 'H=' + Math.ceil(document.documentElement.scrollHeight); }, 1400);
</script></body></html>`;

await mkdir(out, { recursive: true });
const file = resolve(out, 'index.html');
await writeFile(file, html);
console.log(file);

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (existsSync(chrome)) {
  const png = resolve(out, `settings${dark ? '-dark' : ''}${empty ? '-empty' : ''}${session ? '-session' : ''}.png`);
  const flags = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--virtual-time-budget=3000'];
  // Measure at the real width first, then screenshot exactly that tall.
  let height = 1600;
  try {
    const dom = execFileSync(chrome, [...flags, '--window-size=1100,1200', '--dump-dom', pathToFileURL(file).href],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const measured = Number(/<title>H=(\d+)<\/title>/.exec(dom)?.[1]);
    if (Number.isFinite(measured) && measured > 400) height = measured;
  } catch { /* a fixed window is still a usable screenshot */ }
  execFileSync(chrome, [...flags, `--window-size=1100,${height}`, `--screenshot=${png}`, pathToFileURL(file).href], { stdio: 'ignore' });
  console.log(`${png} (1100x${height})`);
}
