# AGENTS.md

`dsh-wecom-soul-bot` is a single DeepSeek Harness plugin package: one `package.json`, one `src/`, one npm package. This file says where a change goes, which invariants it must keep, and how to ship. README.md owns user-facing behavior.

## Layout

```
src/host/            Host half (→ dist/host/index.js)
  config.ts          plugin Config: botId + secretEnv (reference into DSH's credential store) — nothing else
  store.ts           <DSH home>/wecom-soul-bot/settings.json: settings block, groups, bindings, labels, adminDefaults
  runtime.ts         lifecycle; rebuilds the bridge only when the connection identity moves
  routes.ts          GET /api/wecom-soul-bot/state, POST /api/wecom-soul-bot/store (isStoreOp guard)
  groups-view.ts     page table + validation of every store op (applyStoreOps, validateSettingsPatch)
  routing.ts / sessions.ts / session-ops.ts / session-title.ts / presets.ts / models.ts / permissions.ts / workspaces.ts
  bridge/            one WeCom connection: index (frames, serialize), policy, commands, notices, interactions, …
src/client/          settings page (React → dist/client.js, a __ModuleLoader__ factory; scripts/build-client.mjs)
  components/        one file per section: Connection, Pending, Groups (+ MembersTable), Admin, Advanced;
                     ui.tsx building blocks, icons.tsx (DSH icons looked up by name)
  hooks.ts api.ts    Config form / store writes / state polling;  model.ts pure helpers (unit-tested)
  styles.ts          the stylesheet (DSH tokens only)
src/shared/protocol.ts  constants and wire types for both halves
test/                node --test against dist/
scripts/preview.mjs  README screenshots → preview/*.png (committed; linked by absolute raw URL, not in `files`)
```

## Commands

```sh
pnpm run build | typecheck | test | verify   # verify = what CI and prepublishOnly run
node scripts/preview.mjs [--dark|--empty|--session]   # after `pnpm run build`; needs Google Chrome — commit the PNGs
```

`dist/` is never committed or hand-edited.

## Package identity

- `cordis.patch.yml`'s `name` and `protocol.ts`'s `PACKAGE_NAME` must equal `package.json`'s `name` (the page registers under it; `test/client.test.js` checks).
- Changing the identity (name, `exports`/`main`, or switching a profile between a `link:` install and the registry copy) leaves `dsh-hmr`'s module cache pointing at the old path → `failed to import`. Fix: `pnpm install` in the checkout if its `node_modules` is gone, then toggle the **bundle** off/on (or restart DSH). Content-only Host rebuilds reload with a plugin disable/enable; Client-only changes need just a page refresh.

## Host invariants

- **Config = connection identity; everything else is the store.** Only `botId`/`secretEnv` live in Config. All other settings (`wsUrl`, `adminUserIds`, `adminWorkspaces`, journal, legacy `questionTimeoutMs`/`remoteApprovals`) live in `settings.json` and are adopted live (`Bridge.updateSettings`); only a change to Bot ID / Secret / `wsUrl` rebuilds the socket. Never move settings into the Config schema.
- **Store version is a release line** (`STORE_VERSION = '0.5'`). Any other version is parked as `settings.json.v<sanitized version>`, an unparsable file as `.corrupt`. No upgraders.
- **Store ops:** every `StoreOp` variant needs a case in `routes.ts isStoreOp` (`test/routes.test.js` builds one per variant) and validation in `groups-view.ts`; a new setting also needs a case in `validateSettingsPatch`. A failed op stops the batch but earlier writes stay and their metadata (`createdGroupId`, `authorized`, `assigned`, `promotedAdmins`, `settingsChanged`) is still reported and adopted. Command services read policy through getters, never captured objects.
- **Authorization = explicit group membership.** Administrators get private-chat command access without membership and are never auto-added to a group; an admin in a group chat never authorizes that chat. A refused sender gets exactly `unauthorizedText()` and lands in `observation.ts`. No groups ⇒ nobody may talk. Deleting a group de-authorizes its members (never escalate into another group).
- **Notes (`labels`, keyed `user:`/`group:`) belong to the person**, not the binding.
- **Group owns Workspace, model/effort and preset; a member owns only its Session.** A Workspace change clears the group's bindings and history; moving groups remembers the Session per principal×group and restores it only if still usable and in the same Workspace. Provisioning uses expected-binding CAS and re-checks across awaits. A member's model edit (`member.model`) targets the exact bound `sessionId` and is stored as `sessionSelection`; new Sessions use group defaults.
- **Group owns Workspace access too** (`GroupRecord.permission`: `read-only` | `workspace-write` | `danger-full-access`, default and fallback `read-only`). It is DSH's permission preset, set through `ctx.permissionPresets.set(session, mode)` (`permissions.ts`) — the Session's own log is the authority, nothing is stored per member and the page reads the live value from the `permissions` projection (`catalog.sessionPermission`). A new Session is set to the group's mode **before it is bound** and a failure refuses the Session (DSH starts Sessions with write access, so fail closed); no service ⇒ create anyway, journaled. A group edit re-applies to every usable Session of the group (`router.reapplyPermission`) and reports refusals as `ok:false` after keeping the edit. `member.permission` targets the exact bound `sessionId`. Full access needs the risk acknowledgement on the page (`RiskDialog`), never on the Host.
- **Preset is a creation fact** (`sessionController.create({ agentPreset })`); never re-apply to existing Sessions. No `agentPresets` service ⇒ empty roster that accepts any id.
- `sessionController.selectModel` also saves the deployment default — `models.ts` restores it right after.
- A Session is `blank` until its first turn (hidden from DSH's list): treat it as usable; `state?refresh=1` and `catalogs.invalidate()` bypass the 3 s catalog cache.
- **One message at a time per chat** (`serialize` in `bridge/index.ts`; tests await `bridge.whenIdle()`).
- `/delete` and the page's 归档 archive via `workspaceRegistry.archiveSession(id, { stopActivity: true })`; never touch session files.
- `/compact` takes `compaction` from the Agent's own composition (`agentPresets.serviceFor(agent, 'compaction')`, then `agent.ctx`, then host); never reimplement it or run it on a busy Session.
- Every Session the Bot creates is titled `wecom-soul-bot-<userid|chatid>` via `sessionTitle.rename`; failures are journaled, never fatal.
- **Interactions** go through DSH's `$events` broker as an independent Peer (`interaction-transport.ts`); never make DSH wait for WeCom. Without a broker: notify only. An ACK means *submitted*, not *won*; late replies read a tombstone.
- **Approvals only to scoped administrators** in private chats; re-check scope at submission. Questions/approvals/errors in scope notify admins; never relay raw provider error text.
- `ADMIN_ONLY_COMMANDS` (`/new /workspaces /sessions /use /reset /approve /deny`) are refused in group chats (`adminPrivateOnlyText`). `/compact` and `/delete` are open in private chats and admin-only in groups. New admin-only commands go in that set.
- **All WeCom copy lives in `bridge/notices.ts`** (title/field/code helpers, flat `- **字段**：值`, no tables or nested lists, untrusted text through `inline()`), and never writes `/use ` + a word in quotable text. `test/notices.test.js` pins this.
- Host `notices` in the state view are for real problems only; default states (no members, unscoped admins) are said by the page itself.

## Page (client) conventions

- **Match DSH.** The page renders inside the Plugin Manager's package page, so it follows that page: sections are a 14px title over whitespace (32px apart), objects are settings cards (`--dsw-alias-settings-card-*`, `--dsw-radius-xl`), lists are hairline rows, inline edits happen in a recessed editor well, details open in DSH's `Modal` (actions in its `footer`; never override the dialog's padding). Only `--dsw-*` tokens — no literal colors. Use DSH's zh terms: 工作区, 会话, 推理等级, Agent 预设 (built-ins 标准模式 / PTC 模式 / 极简模式 / 创造模式).
- **Primitives** come from the shell (`@deepseek-ai/dsh-client-ui-primitives`, declared in `primitives.d.ts`). Keep the surface small; read icons only through `icons.tsx` so a renamed icon renders nothing instead of crashing the slot.
- **Layering:** the summary shows what an operator scans; details are one click away. Section order: 连接 → 待授权 → 用户分组 → 管理员 → 高级设置 (folded).
  - 连接 is a status summary; its editor opens by itself only while setup is incomplete.
  - A group card's header always names its five facts (工作区, 模型, 推理等级, Agent 预设, 工作区权限 — DSH defaults marked `（DSH 默认）`, unset effort reads 默认; permission uses DSH's names 仅可查看 / 工作区内修改 / 完全权限; values wrap, never ellipsize). 编辑 replaces them with the editor; 删除分组 lives in the editor and confirms. A lone group opens by default.
  - Members table: 成员 | 会话 | 模型 | 推理等级 | 工作区权限 | 上下文, left-aligned, horizontally scrollable. Model/effort are always-rendered selects (one click opens them) that edit only the current Session. The 会话 pill shows the live state and opens `SessionDialog` (name, state, preset, 工作区权限 (editable), context, id); only its 打开会话 navigates (`uiWorkspace.openSession`, never a guessed URL), and 归档会话 confirms inside the same dialog. The name opens `PersonDialog` (note, a single 所属分组 select, 移出分组).
- **Write channels:** only 连接 writes the Config (`useConfigSave`, rebases on revision conflicts); 高级设置 writes one `settings.set` patch on 保存 (`useStoreSettingsSave`); everything else writes the store immediately (`useStoreApply`) and shows only failures, inside the active editor/dialog. In-flight member writes disable that row.
- Editors show 保存 disabled until something changed. Consequence hints appear only when the draft changes the field they describe.

## Releasing

1. Bump `package.json` `version`; `pnpm run verify`.
2. Commit `Release vX.Y.Z: <summary>` (the body becomes the GitHub Release notes); `git tag -a vX.Y.Z -m "…"`; `git push && git push --tags`.
3. `release.yml` verifies, checks tag = version, runs `npm stage publish`, and creates a pre-release GitHub Release.
4. Approve the stage on npmjs.com (or `npm stage approve <id>`, 2FA), then un-mark pre-release.
5. Verify with the exact version (`dsh-wecom-soul-bot@X.Y.Z`): pnpm 11's `minimumReleaseAge` makes bare names and `@latest` resolve to day-old releases.

Never `npm publish` by hand except to recover a CI outage. Trusted Publishing stays stage-only:
`npm trust github dsh-wecom-soul-bot --repo lastorder/dsh-wecom-soul-bot --file release.yml --allow-stage-publish` (`--file` is a filename, not a path; check with `npm trust list dsh-wecom-soul-bot`). No `NPM_TOKEN` secret.

Troubleshooting: "No pnpm version is specified" → `packageManager` missing from `package.json`. `E401` at "Stage on npm" → no Trusted Publisher for this repo/workflow. Tag check fails → version not bumped or wrong commit tagged. Third-party actions are pinned by SHA.
