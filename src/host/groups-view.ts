import {
  DEFAULT_GROUP_ID, isPermissionMode, MAX_GROUPS, MAX_LOG_RETENTION_DAYS, MAX_QUESTION_TIMEOUT_MS, MIN_LOG_RETENTION_DAYS,
  MIN_QUESTION_TIMEOUT_MS, type BindingKind, type BindingRecord, type BindingSessionState, type ContextUsage,
  type GroupMemberView, type GroupRecord, type GroupView, type ModelSelection, type StoreOp,
  type RoutingView, type StoreSettingsPatch,
} from '../shared/protocol.js';
import { isTrustedWsUrl, uniqueIds } from './config.js';
import type { CatalogService } from './catalog.js';
import type { ModelService } from './models.js';
import type { PermissionService } from './permissions.js';
import type { PresetService } from './presets.js';
import type { ObservationStore } from './observation.js';
import { bindingKey, normalizeLabel, parseBindingKey, validBindingId, type PluginStore } from './store.js';
import type { Router } from './routing.js';
import type { SessionProvisioner } from './sessions.js';
import type { WorkspaceService } from './workspaces.js';

/**
 * The groups table the settings page renders, and the edits it applies.
 *
 * Membership is always explicit, including for administrators. The page
 * authorizes a principal by assigning a rejected sender to a
 * group *is* the authorization. Every change is validated here: a group must
 * exist, a Workspace must resolve, and a model and an agent preset must exist
 * in the DSH catalogs.
 */

export interface RoutingViewDeps {
  readonly store: PluginStore;
  readonly provisioner: SessionProvisioner;
  readonly workspaces: WorkspaceService;
  readonly models: ModelService;
  readonly presets?: PresetService;
  /** Workspace access: absent in a deployment without DSH's permission presets. */
  readonly permissions?: PermissionService;
  readonly catalogs: CatalogService;
  readonly observations?: ObservationStore;
  readonly isAdmin: (user: string) => boolean;
  readonly router?: Pick<Router, 'reapplyGroup' | 'reapplyPermission'>;
  /** Archiving a Session needs a DSH service the view itself does not hold. */
  readonly ops?: { archive(sessionId: string): Promise<void> };
  readonly log?: { warn(message: string): void };
}

async function memberView(deps: RoutingViewDeps, binding: BindingRecord): Promise<GroupMemberView> {
  const key = bindingKey(binding.kind, binding.id);
  let sessionTitle: string | null = null;
  let sessionState: BindingSessionState = binding.sessionId ? 'bound' : 'auto';
  let sessionRunning = false;
  let sessionModel: ModelSelection | undefined;
  let sessionPreset: string | undefined;
  let sessionPermission: string | undefined;
  let sessionContext: ContextUsage | undefined;
  if (binding.sessionId) {
    const described = await deps.provisioner.describe(binding.sessionId);
    sessionTitle = described.title;
    sessionState = described.state;
    sessionRunning = described.running;
    sessionModel = described.model;
    sessionPreset = described.preset;
    sessionPermission = described.permission;
    sessionContext = described.context;
  }
  const seen = deps.observations?.stats(binding.kind, binding.id);
  const group = deps.store.group(binding.groupId);
  const sessionSelection = binding.sessionSelection ?? (group ? deps.provisioner.desired(group) : undefined);
  return {
    key,
    kind: binding.kind,
    id: binding.id,
    label: deps.store.label(key),
    displayName: deps.store.label(key) || binding.id,
    admin: binding.kind === 'user' && deps.isAdmin(binding.id),
    sessionId: binding.sessionId,
    sessionTitle,
    sessionState,
    sessionRunning,
    ...(sessionModel ? { sessionModel } : {}),
    ...(binding.sessionId && sessionSelection ? { sessionSelection } : {}),
    ...(sessionPreset ? { sessionPreset } : {}),
    ...(sessionPermission ? { sessionPermission } : {}),
    ...(sessionContext ? { sessionContext } : {}),
    messages: seen?.messages ?? 0,
    ...(seen?.lastSeenAt ? { lastSeenAt: seen.lastSeenAt } : {}),
    createdAt: binding.createdAt,
  };
}

async function groupView(deps: RoutingViewDeps, group: GroupRecord): Promise<GroupView> {
  let workspacePath = group.workspace;
  let workspaceTitle = group.workspace ? group.workspace : '插件默认 Workspace';
  let workspaceError: string | undefined;
  try {
    const resolved = await deps.workspaces.describe(group.workspace);
    workspacePath = resolved.path;
    workspaceTitle = resolved.title;
    if (!resolved.registered && !resolved.pluginOwned) workspaceError = '尚未注册为 DSH Workspace，将在创建会话时注册。';
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error);
    try {
      const fallback = await deps.workspaces.describe('');
      workspacePath = fallback.path;
      workspaceTitle = fallback.title;
    } catch { /* the page shows the error instead */ }
  }
  const members: GroupMemberView[] = [];
  for (const binding of deps.store.inGroup(group.id)) members.push(await memberView(deps, binding));
  members.sort((left, right) =>
    (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0)
    || left.displayName.localeCompare(right.displayName)
    || left.key.localeCompare(right.key));
  const desired = deps.provisioner.desired(group);
  const lastSeenAt = members.reduce<number | undefined>(
    (latest, member) => (member.lastSeenAt && (!latest || member.lastSeenAt > latest) ? member.lastSeenAt : latest), undefined);
  return {
    id: group.id,
    name: group.name,
    isDefault: group.id === DEFAULT_GROUP_ID,
    workspace: group.workspace,
    workspaceTitle,
    workspacePath,
    ...(workspaceError ? { workspaceError } : {}),
    provider: group.provider,
    model: group.model,
    ...(group.reasoningEffort ? { reasoningEffort: group.reasoningEffort } : {}),
    preset: group.preset,
    permission: group.permission,
    ...(desired
      ? {
        effectiveProvider: desired.provider,
        effectiveModel: desired.model,
        ...(desired.reasoningEffort ? { effectiveReasoningEffort: desired.reasoningEffort } : {}),
      }
      : { effectiveProvider: '', effectiveModel: '' }),
    members,
    memberCount: members.length,
    messages: members.reduce((sum, member) => sum + member.messages, 0),
    ...(lastSeenAt ? { lastSeenAt } : {}),
  };
}

/** Groups: the built-in default group first, then the others oldest first. */
export async function buildRoutingView(deps: RoutingViewDeps): Promise<RoutingView> {
  const records = deps.store.groups();
  const ordered = [
    ...records.filter(group => group.id === DEFAULT_GROUP_ID),
    ...records.filter(group => group.id !== DEFAULT_GROUP_ID).sort((left, right) => left.createdAt - right.createdAt),
  ];
  const groups: GroupView[] = [];
  for (const group of ordered) groups.push(await groupView(deps, group));
  return {
    groups,
    total: deps.store.bindings().length,
    full: deps.store.full(),
  };
}

export interface StoreOpResult {
  readonly ok: boolean;
  readonly error?: string;
  /** Number of records the ops changed. */
  readonly changed: number;
  /** The group `group.add` created, so the page can open its form. */
  readonly createdGroupId?: string;
  /** Principals `member.add` authorized, so the Bot can greet them. */
  readonly authorized?: readonly { readonly kind: BindingKind; readonly id: string; readonly groupId: string }[];
  /** Principals moved to another group, so the Bot can tell them where they are now. */
  readonly assigned?: readonly {
    readonly kind: BindingKind;
    readonly id: string;
    readonly groupId: string;
    readonly previousGroupId: string;
  }[];
  /** Administrators `settings.set` added, so the Bot can tell them what they may do. */
  readonly promotedAdmins?: readonly string[];
  /** A `settings.set` op wrote the store's settings block. */
  readonly settingsChanged?: boolean;
}

/**
 * Validate one settings patch, or answer with the message to show.
 *
 * The store coerces and clamps whatever it finds in the file, because the file is
 * hand-editable content. An edit that arrives *from the page* is a different
 * thing: it is a decision the operator just made, so an unusable WebSocket
 * address or an out-of-range timeout is refused out loud instead of being
 * silently rounded into something nobody asked for.
 */
export function validateSettingsPatch(patch: StoreSettingsPatch): StoreSettingsPatch | string {
  const record = patch as Record<string, unknown>;
  const known = new Set([
    'wsUrl', 'adminUserIds', 'adminWorkspaces', 'questionTimeoutMs', 'remoteApprovals', 'logEnabled', 'logRetentionDays',
  ]);
  for (const key of Object.keys(record)) if (!known.has(key)) return `无法识别的设置项：${key}`;
  const clean: Record<string, unknown> = {};
  if (record.wsUrl !== undefined) {
    const url = typeof record.wsUrl === 'string' ? record.wsUrl.trim() : '';
    if (url && !isTrustedWsUrl(url)) return 'WebSocket 地址必须是不含账号密码的 wss:// 地址。';
    clean.wsUrl = url;
  }
  if (record.adminUserIds !== undefined) {
    if (!Array.isArray(record.adminUserIds)) return '管理员列表不正确。';
    for (const id of record.adminUserIds) if (!validBindingId(id)) return '需要有效的企微 userid。';
    clean.adminUserIds = uniqueIds(record.adminUserIds);
  }
  if (record.adminWorkspaces !== undefined) {
    if (!Array.isArray(record.adminWorkspaces)) return '通知范围不正确。';
    for (const path of record.adminWorkspaces) {
      if (typeof path !== 'string' || !path.trim() || path.length > 1024) return '通知范围里的 Workspace 路径不正确。';
    }
    clean.adminWorkspaces = uniqueIds(record.adminWorkspaces);
  }
  if (record.questionTimeoutMs !== undefined) {
    const ms = Number(record.questionTimeoutMs);
    if (!Number.isFinite(ms) || ms < MIN_QUESTION_TIMEOUT_MS || ms > MAX_QUESTION_TIMEOUT_MS) {
      return `「等待企微回复」需要在 ${MIN_QUESTION_TIMEOUT_MS / 1000}–${MAX_QUESTION_TIMEOUT_MS / 1000} 秒之间。`;
    }
    clean.questionTimeoutMs = Math.round(ms);
  }
  if (record.remoteApprovals !== undefined) {
    if (typeof record.remoteApprovals !== 'boolean') return '「远程审批」只能是开或关。';
    clean.remoteApprovals = record.remoteApprovals;
  }
  if (record.logEnabled !== undefined) {
    if (typeof record.logEnabled !== 'boolean') return '「对话日志」只能是开或关。';
    clean.logEnabled = record.logEnabled;
  }
  if (record.logRetentionDays !== undefined) {
    const days = Number(record.logRetentionDays);
    if (!Number.isInteger(days) || days < MIN_LOG_RETENTION_DAYS || days > MAX_LOG_RETENTION_DAYS) {
      return `「日志保留天数」需要在 ${MIN_LOG_RETENTION_DAYS}–${MAX_LOG_RETENTION_DAYS} 天之间。`;
    }
    clean.logRetentionDays = days;
  }
  return clean as StoreSettingsPatch;
}

/**
 * Decide, before a group change is committed, whether that group's remembered
 * Session may be restored.
 *
 * The store restores the candidate as part of the move itself, so an unusable
 * candidate has to be dropped from the history *first*: validating after the
 * write leaves it routable while the check awaits, and a failed check would
 * leave it bound for good. An unreadable Workspace or catalog also refuses the
 * move instead of silently discarding a Session the operator still owns.
 */
async function prepareRestore(
  deps: RoutingViewDeps, key: string, binding: BindingRecord, groupId: string,
): Promise<string | undefined> {
  const memory = binding.sessionsByGroup?.[groupId];
  if (!memory) return undefined;
  const group = deps.store.group(groupId);
  if (!group) return `分组不存在：${groupId}`;
  deps.catalogs.invalidate?.();
  let workspacePath: string;
  try {
    workspacePath = (await deps.workspaces.describe(group.workspace)).path;
  } catch (error) {
    return `无法读取分组「${group.name}」的 Workspace：${error instanceof Error ? error.message : String(error)}`;
  }
  if (deps.store.get(key) !== binding || deps.store.group(groupId) !== group) return '成员信息已变化，请刷新后重试。';
  let state: BindingSessionState | undefined;
  let sessionPath: string | undefined;
  try {
    const described = await deps.provisioner.describe(memory.sessionId);
    state = described.state;
    sessionPath = described.workspacePath;
  } catch {
    return '暂时无法确认旧会话的状态，请稍后重试。';
  }
  if (deps.store.get(key) !== binding || deps.store.group(groupId) !== group) return '成员信息已变化，请刷新后重试。';
  if (['bound', 'blank'].includes(state) && sessionPath === workspacePath) return undefined;
  // Unusable in this group: forget the candidate before the move so nothing is bound.
  await deps.store.forgetSession(key, groupId);
  if (deps.store.get(key)?.groupId !== binding.groupId) return '成员信息已变化，请刷新后重试。';
  return undefined;
}

/** Apply settings-page edits; the first failing op stops the rest. */
export async function applyStoreOps(deps: RoutingViewDeps, ops: readonly StoreOp[]): Promise<StoreOpResult> {
  await deps.store.load();
  const initialBindings = new Map(deps.store.bindings().map(binding => [bindingKey(binding.kind, binding.id), binding]));
  const initialAdmins = new Set(deps.store.settings().adminUserIds);
  let changed = 0;
  let settingsChanged = false;
  let createdGroupId: string | undefined;
  let failure: string | undefined;
  /** Newly authorized principals, keyed by binding key (a later move replaces this). */
  const authorized = new Map<string, { kind: BindingKind; id: string; groupId: string }>();
  /** Principals whose group changed, keyed the same way so one batch notifies once. */
  const assigned = new Map<string, { kind: BindingKind; id: string; groupId: string; previousGroupId: string }>();
  /** Administrators this batch added; a person already on the list is not promoted again. */
  const promotedAdmins = new Set<string>();
  // A model edit is only worth accepting against the real catalog; read it
  // once when the page has never asked for it on this process yet.
  const touchesModel = ops.some(op => op.op === 'member.model' || (op.op === 'group.update'
    && (op.patch.provider !== undefined || op.patch.model !== undefined)));
  if (touchesModel && !deps.models.snapshot()) {
    try {
      await deps.models.load();
    } catch {
      /* an unreadable catalog only means the model cannot be verified here */
    }
  }
  // A preset edit is accepted only against the real roster, for the same reason
  // as a model: a typo would otherwise fail the next Session creation instead.
  const touchesPreset = ops.some(op => op.op === 'group.update' && op.patch.preset !== undefined);
  if (touchesPreset && !deps.presets?.snapshot()) {
    try {
      await deps.presets?.load();
    } catch {
      /* an unreadable roster only means the preset cannot be verified here */
    }
  }
  const modelChanged = new Set<string>();
  const permissionChanged = new Set<string>();
  for (const op of ops.slice(0, 200)) {
    try {
      switch (op.op) {
        case 'group.add': {
          if (deps.store.groups().length >= MAX_GROUPS) {
            failure = `最多只能有 ${MAX_GROUPS} 个分组。`;
            break;
          }
          try {
            const created = await deps.store.createGroup(op.name);
            createdGroupId = created.id;
            changed++;
          } catch (error) {
            failure = `无法新增分组：${error instanceof Error ? error.message : String(error)}`;
          }
          break;
        }
        case 'group.update': {
          const group = deps.store.group(op.id);
          if (!group) { failure = `分组不存在：${op.id}`; break; }
          const patch = op.patch;
          const fields = new Set(['name', 'workspace', 'provider', 'model', 'reasoningEffort', 'preset', 'permission']);
          if (Object.entries(patch).some(([key, value]) => !fields.has(key) || typeof value !== 'string')) {
            failure = '分组设置只能包含名称、Workspace、模型、effort、preset 与工作区权限，且必须是文本。';
            break;
          }
          if (patch.permission !== undefined) {
            if (!isPermissionMode(patch.permission)) { failure = '工作区权限只能是「仅可查看」「工作区内修改」或「完全权限」。'; break; }
            const offered = deps.permissions?.catalog();
            if (offered?.available && !offered.modes.includes(patch.permission)) {
              failure = 'DSH 当前没有这个权限模式，请重新选择。';
              break;
            }
          }
          if (patch.workspace !== undefined && patch.workspace.trim()) {
            try {
              await deps.workspaces.resolve(patch.workspace);
            } catch (error) {
              failure = error instanceof Error ? error.message : String(error);
              break;
            }
          }
          const nextProvider = (patch.provider ?? group.provider).trim();
          const nextModel = (patch.model ?? group.model).trim();
          if (Boolean(nextProvider) !== Boolean(nextModel)) {
            failure = '请同时选择服务商与模型，或都留空以跟随 DSH 默认模型。';
            break;
          }
          if (nextProvider && nextModel && !deps.models.known({ provider: nextProvider, model: nextModel })) {
            failure = `DSH 当前没有模型 ${nextProvider}/${nextModel}，请重新选择。`;
            break;
          }
          const nextPreset = (patch.preset ?? group.preset).trim();
          // Without a preset service there is nothing to validate against.
          if (nextPreset && deps.presets && !deps.presets.known(nextPreset)) {
            failure = `DSH 当前没有 preset ${nextPreset}，请重新选择。`;
            break;
          }
          const updated = await deps.store.updateGroup(op.id, patch);
          if (!updated) { failure = `分组不存在：${op.id}`; break; }
          changed++;
          if (patch.provider !== undefined || patch.model !== undefined || patch.reasoningEffort !== undefined) {
            modelChanged.add(op.id);
          }
          if (updated.permission !== group.permission) permissionChanged.add(op.id);
          // A group's Workspace defines where its Sessions live, so moving the
          // group must not leave members pointing at Sessions of the old one.
          if (updated.workspace !== group.workspace) {
            for (const member of deps.store.inGroup(op.id)) {
              // Replace even an empty row: provisioning may currently be creating
              // its first Session in the old Workspace and must fail its CAS.
              await deps.store.update(bindingKey(member.kind, member.id), { sessionId: '' });
              changed++;
            }
          }
          break;
        }
        case 'group.delete': {
          if (op.id === DEFAULT_GROUP_ID) { failure = '默认分组不能删除。'; break; }
          const result = await deps.store.removeGroup(op.id);
          if (!result.ok) { failure = `分组不存在：${op.id}`; break; }
          changed += 1 + result.removed;
          break;
        }
        case 'member.add': {
          const id = typeof op.id === 'string' ? op.id.trim() : '';
          if ((op.kind !== 'user' && op.kind !== 'group') || !validBindingId(id)) {
            failure = '需要有效的企微 userid（个人）或 chatid（群聊）。';
            break;
          }
          if (!deps.store.group(op.groupId)) { failure = `分组不存在：${op.groupId}`; break; }
          try {
            const previous = deps.store.get(bindingKey(op.kind, id));
            if (previous && previous.groupId !== op.groupId) {
              const restoreError = await prepareRestore(deps, bindingKey(op.kind, id), previous, op.groupId);
              if (restoreError) { failure = restoreError; break; }
            }
            await deps.store.create(op.kind, id, {
              groupId: op.groupId, ...(op.label === undefined ? {} : { label: op.label }),
            });
            changed++;
          } catch (error) {
            failure = `无法加入分组：${error instanceof Error ? error.message : String(error)}`;
          }
          break;
        }
        case 'member.update': {
          const parsed = parseBindingKey(op.key);
          if (!parsed) { failure = `无法识别的成员 id：${op.key}`; break; }
          const key = bindingKey(parsed.kind, parsed.id);
          const existing = deps.store.get(key);
          if (!existing) { failure = `成员不存在：${op.key}`; break; }
          if (Object.entries(op.patch).some(([key, value]) => !['groupId', 'sessionId'].includes(key) || typeof value !== 'string')) {
            failure = '成员设置只能包含文本形式的分组或会话 ID。';
            break;
          }
          if (op.patch.groupId !== undefined && !deps.store.group(op.patch.groupId)) {
            failure = `分组不存在：${op.patch.groupId}`;
            break;
          }
          if (op.patch.groupId !== undefined && op.patch.groupId !== existing.groupId) {
            const restoreError = await prepareRestore(deps, key, existing, op.patch.groupId);
            if (restoreError) { failure = restoreError; break; }
          }
          const updated = await deps.store.update(key, op.patch);
          if (!updated) { failure = `成员不存在：${op.key}`; break; }
          changed++;
          break;
        }
        case 'member.model': {
          const parsed = parseBindingKey(op.key);
          if (!parsed) { failure = `无法识别的成员 id：${op.key}`; break; }
          const key = bindingKey(parsed.kind, parsed.id);
          const binding = deps.store.get(key);
          if (!binding || !binding.sessionId || binding.sessionId !== op.sessionId) {
            failure = '成员的绑定会话已变化，请刷新后重试。'; break;
          }
          const raw = op.selection;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)
            || Object.entries(raw).some(([key, value]) => !['provider', 'model', 'reasoningEffort'].includes(key) || typeof value !== 'string')
            || !raw.provider?.trim() || !raw.model?.trim()) {
            failure = '请选择有效的服务商、模型与 effort。'; break;
          }
          const selection: ModelSelection = {
            provider: raw.provider.trim(), model: raw.model.trim(),
            ...(raw.reasoningEffort?.trim() ? { reasoningEffort: raw.reasoningEffort.trim() } : {}),
          };
          const catalog = deps.models.snapshot();
          const choice = catalog?.choices.find(item => item.provider === selection.provider && item.model === selection.model);
          if (!choice || !deps.models.known(selection)) { failure = 'DSH 当前没有这个模型，请重新选择。'; break; }
          if (selection.reasoningEffort && !choice.efforts?.some(item => item.id === selection.reasoningEffort)) {
            failure = '这个模型不支持所选的 effort，请重新选择。'; break;
          }
          const described = await deps.provisioner.describe(binding.sessionId);
          if (!['bound', 'blank'].includes(described.state)) { failure = '绑定的会话已不可用，请先发送消息创建新会话。'; break; }
          if (deps.store.get(key) !== binding) { failure = '成员的绑定会话已变化，请刷新后重试。'; break; }
          const selected = await deps.provisioner.applyModel(binding.sessionId, selection);
          const updated = await deps.store.update(key, { sessionSelection: selected }, binding);
          if (!updated) { failure = '成员的绑定会话已变化，模型未保存到新绑定，请刷新后重试。'; break; }
          deps.catalogs.invalidate?.();
          changed++;
          break;
        }
        case 'member.permission': {
          const parsed = parseBindingKey(op.key);
          if (!parsed) { failure = `无法识别的成员 id：${op.key}`; break; }
          const key = bindingKey(parsed.kind, parsed.id);
          const binding = deps.store.get(key);
          if (!binding || !binding.sessionId || binding.sessionId !== op.sessionId) {
            failure = '成员的绑定会话已变化，请刷新后重试。'; break;
          }
          if (!isPermissionMode(op.permission)) {
            failure = '工作区权限只能是「仅可查看」「工作区内修改」或「完全权限」。'; break;
          }
          const offered = deps.permissions?.catalog();
          if (!offered?.available) { failure = '当前 DSH 没有权限模式服务，无法修改会话的工作区权限。'; break; }
          if (!offered.modes.includes(op.permission)) { failure = 'DSH 当前没有这个权限模式，请重新选择。'; break; }
          const described = await deps.provisioner.describe(binding.sessionId);
          if (!['bound', 'blank'].includes(described.state)) { failure = '绑定的会话已不可用，请先发送消息创建新会话。'; break; }
          if (deps.store.get(key) !== binding) { failure = '成员的绑定会话已变化，请刷新后重试。'; break; }
          await deps.provisioner.applyPermission(binding.sessionId, op.permission);
          deps.catalogs.invalidate?.();
          changed++;
          break;
        }
        case 'label.set': {
          const parsed = parseBindingKey(op.key);
          if (!parsed) { failure = `无法识别的人员 id：${op.key}`; break; }
          const key = bindingKey(parsed.kind, parsed.id);
          if (typeof op.label !== 'string') { failure = '备注必须是文本。'; break; }
          if (op.label.trim() && !normalizeLabel(op.label)) {
            failure = '备注只能是单行文本。';
            break;
          }
          await deps.store.setLabel(key, op.label);
          changed++;
          break;
        }
        case 'member.archive': {
          const parsed = parseBindingKey(op.key);
          if (!parsed) { failure = `无法识别的成员 id：${op.key}`; break; }
          const key = bindingKey(parsed.kind, parsed.id);
          const binding = deps.store.get(key);
          if (!binding) { failure = `成员不存在：${op.key}`; break; }
          if (!binding.sessionId) { failure = '这个成员还没有会话可以归档。'; break; }
          if (!deps.ops) { failure = '当前 DSH 不支持归档会话。'; break; }
          try {
            await deps.ops.archive(binding.sessionId);
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
            break;
          }
          // Clearing the binding is what makes the next message create a fresh
          // Session from the group's current Workspace/model/preset.
          await deps.store.update(key, { sessionId: '' });
          changed++;
          break;
        }
        case 'member.remove': {
          const parsed = parseBindingKey(op.key);
          if (!parsed) { failure = `无法识别的成员 id：${op.key}`; break; }
          const removed = await deps.store.remove(bindingKey(parsed.kind, parsed.id));
          if (!removed) { failure = `成员不存在：${op.key}`; break; }
          changed++;
          break;
        }
        case 'settings.set': {
          if (!op.patch || typeof op.patch !== 'object') { failure = '设置内容不正确。'; break; }
          const validated = validateSettingsPatch(op.patch);
          if (typeof validated === 'string') { failure = validated; break; }
          try {
            await deps.store.setSettings(validated);
          } catch (error) {
            failure = `无法保存设置：${error instanceof Error ? error.message : String(error)}`;
            break;
          }
          settingsChanged = true;
          changed++;
          break;
        }
        default:
          failure = '未知的修改类型。';
          break;
      }
    } catch (error) {
      failure = `无法应用修改：${error instanceof Error ? error.message : String(error)}`;
    }
    // Earlier ops stay applied even when this one failed; the result reports
    // both, so the runtime can adopt the settings and notify the people they
    // authorized before the failure. Only the rest of the batch is skipped.
    if (failure) break;
  }
  // A group's model applies to every Session it already owns.
  for (const id of modelChanged) {
    try {
      await deps.router?.reapplyGroup(id);
    } catch (error) {
      deps.log?.warn(`WeCom could not apply the group model: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // A group's Workspace access applies to every Session it already owns. The
  // group edit is kept even when a Session refuses it, but the operator is told:
  // a Session left wider than its group says is not something to hide.
  for (const id of permissionChanged) {
    try {
      const failed = await deps.router?.reapplyPermission(id) ?? [];
      if (failed.length && !failure) {
        failure = `分组已保存，但有 ${failed.length} 个会话没能应用新的工作区权限：${failed[0]!.message}`;
      }
    } catch (error) {
      deps.log?.warn(`WeCom could not apply the group access mode: ${error instanceof Error ? error.message : String(error)}`);
      if (!failure) failure = '分组已保存，但未能把工作区权限应用到已有会话，请稍后重试。';
    }
  }
  // Notifications describe the final effective assignment, not transient
  // states within a batch (including a successful prefix of a failed batch).
  for (const binding of deps.store.bindings()) {
    const key = bindingKey(binding.kind, binding.id);
    const previous = initialBindings.get(key);
    const entry = { kind: binding.kind, id: binding.id, groupId: binding.groupId };
    if (!previous) authorized.set(key, entry);
    else if (previous.groupId !== binding.groupId) assigned.set(key, { ...entry, previousGroupId: previous.groupId });
  }
  for (const id of deps.store.settings().adminUserIds) if (!initialAdmins.has(id)) promotedAdmins.add(id);
  const assignedList = [...assigned.values()];
  return {
    ok: failure === undefined,
    ...(failure ? { error: failure } : {}),
    changed,
    ...(settingsChanged ? { settingsChanged } : {}),
    ...(createdGroupId ? { createdGroupId } : {}),
    ...(authorized.size ? { authorized: [...authorized.values()] } : {}),
    ...(assignedList.length ? { assigned: assignedList } : {}),
    ...(promotedAdmins.size ? { promotedAdmins: [...promotedAdmins] } : {}),
  };
}
