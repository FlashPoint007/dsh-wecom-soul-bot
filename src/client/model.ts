/**
 * Pure state helpers for the settings page: drafts, diffs, validation, group
 * edits and display labels. No React and no DOM, so they are unit-tested
 * directly.
 */
import type {
  AgentPresetOption, BindingKind, ContextUsage, GroupMemberView, GroupView,
  ModelCatalogView, ModelChoice, ModelSelection, PermissionMode, PresetCatalogView, StoreOp,
  StoreSettings, StoreSettingsPatch,
} from '../shared/protocol.ts';
import {
  FULL_ACCESS_MODE, DEFAULT_LOG_RETENTION_DAYS, DEFAULT_SECRET_REF, MAX_LOG_RETENTION_DAYS, MIN_LOG_RETENTION_DAYS,
} from '../shared/protocol.ts';
import type { FormOperation, StoredConfig } from './types.ts';

/** The 连接 section's fallback: the Config holds the Bot ID and the Secret reference. */
export const DEFAULTS: StoredConfig = {
  botId: '',
  secretEnv: DEFAULT_SECRET_REF,
};

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function storedFrom(value: Partial<StoredConfig> | undefined): StoredConfig {
  const v = value ?? {};
  return {
    botId: text(v.botId),
    secretEnv: text(v.secretEnv).trim() || DEFAULTS.secretEnv,
  };
}

function normalizedScalar(key: 'botId', draft: StoredConfig): unknown {
  const value = draft[key];
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * The minimal Config operations that turn `base` into `draft`.
 *
 * The Config is the Bot ID and the Secret reference, and only the first of them
 * is a form field: a Secret is written to DSH's credential store, never into the
 * Config document, so it is never part of a diff.
 */
export function changedOperations(draft: StoredConfig, base: StoredConfig): FormOperation[] {
  const ops: FormOperation[] = [];
  if (normalizedScalar('botId', draft) !== normalizedScalar('botId', base)) {
    ops.push({ op: 'set', path: ['botId'], value: normalizedScalar('botId', draft) });
  }
  return ops;
}

export type FieldErrors = Partial<Record<
  'botId' | 'secret' | 'wsUrl' | 'logRetentionDays',
  string
>>;

/** The 连接 editor's own validation: both credentials, nothing else. */
export function validateCredentials(draft: { readonly botId: string; readonly secret: string }, secretConfigured: boolean): FieldErrors {
  const errors: FieldErrors = {};
  if (!draft.botId.trim()) errors.botId = '请填写企业微信 Bot ID。';
  if (!draft.secret.trim() && !secretConfigured) errors.secret = '首次配置需要填写 Bot Secret。';
  return errors;
}

/**
 * The 高级设置 section's own validation: a safe endpoint and retention range, read
 * from the store's settings block rather than from the Config.
 *
 * The Host refuses the same values out loud (`validateSettingsPatch`), and these
 * bounds are its constants, so the field error appears before the round trip
 * without the two ever drifting apart.
 */
export function validateAdvanced(
  draft: Pick<StoreSettings, 'wsUrl' | 'logRetentionDays'>,
): FieldErrors {
  const errors: FieldErrors = {};
  const wsUrl = draft.wsUrl.trim();
  if (wsUrl) {
    try {
      const url = new URL(wsUrl);
      if (url.protocol !== 'wss:' || url.username || url.password) errors.wsUrl = '只接受不含账号密码的 wss:// 地址。';
    } catch {
      errors.wsUrl = '不是有效的 URL。';
    }
  }
  if (!Number.isInteger(draft.logRetentionDays)
    || draft.logRetentionDays < MIN_LOG_RETENTION_DAYS || draft.logRetentionDays > MAX_LOG_RETENTION_DAYS) {
    errors.logRetentionDays = `请输入 ${MIN_LOG_RETENTION_DAYS}–${MAX_LOG_RETENTION_DAYS} 的整数天数。`;
  }
  return errors;
}

/** The store's settings block as the 高级设置 section seeds its draft. */
export function advancedSlice(settings: StoreSettings | undefined): Pick<
  StoreSettings, 'wsUrl' | 'logEnabled' | 'logRetentionDays'
> {
  return {
    wsUrl: settings?.wsUrl ?? '',
    logEnabled: settings?.logEnabled ?? true,
    logRetentionDays: settings?.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS,
  };
}

/**
 * The patch that turns the stored slice into the draft.
 *
 * Only the fields the operator actually moved are part of it, so saving the card
 * cannot write back a stale copy of something another window just changed.
 */
export function settingsPatch(
  draft: Pick<StoreSettings, 'wsUrl' | 'logEnabled' | 'logRetentionDays'>,
  stored: Pick<StoreSettings, 'wsUrl' | 'logEnabled' | 'logRetentionDays'>,
): StoreSettingsPatch {
  const patch: { -readonly [K in keyof StoreSettingsPatch]: StoreSettingsPatch[K] } = {};
  if (draft.wsUrl.trim() !== stored.wsUrl.trim()) patch.wsUrl = draft.wsUrl.trim();
  if (draft.logEnabled !== stored.logEnabled) patch.logEnabled = draft.logEnabled;
  if (draft.logRetentionDays !== stored.logRetentionDays) patch.logRetentionDays = draft.logRetentionDays;
  return patch;
}

export function toggle(values: readonly string[], id: string, on?: boolean): string[] {
  const has = values.includes(id);
  const want = on ?? !has;
  if (want === has) return [...values];
  return want ? [...values, id] : values.filter(value => value !== id);
}

/**
 * Whether one Workspace is inside the administrator notification scope.
 * An empty stored list is the default and means every Workspace.
 */
export function scopeIncludes(values: readonly string[], path: string): boolean {
  return values.length === 0 || values.includes(path);
}

/**
 * The stored scope after toggling one Workspace.
 *
 * A list that covers every offered Workspace collapses back to `[]` — the
 * canonical "all" the store documents, so checking everything does not silently
 * pin today's Workspace set into the file.
 */
export function toggleScope(values: readonly string[], allPaths: readonly string[], path: string, on: boolean): string[] {
  const next = new Set(values.length ? values : allPaths);
  if (on) next.add(path); else next.delete(path);
  if (next.size >= allPaths.length) return [];
  return allPaths.filter(item => next.has(item));
}

/* ------------------------------- models ------------------------------- */

/** A provider/model pair as it is stored in one `<option value>`. */
export function modelKey(provider: string, model: string): string {
  return provider && model ? `${provider}\u0000${model}` : '';
}

export function parseModelKey(key: string): { provider: string; model: string } {
  const [provider = '', model = ''] = key.split('\u0000');
  return { provider, model };
}

export function choiceLabel(choice: ModelChoice): string {
  return choice.name === choice.model ? choice.model : `${choice.name}（${choice.model}）`;
}

/** Reasoning efforts offered by one provider/model pair. */
export function effortsFor(
  catalog: ModelCatalogView | null | undefined, provider: string, model: string,
): readonly { id: string; name: string }[] {
  const choice = catalog?.choices.find(item => item.provider === provider && item.model === model);
  return choice?.efforts ?? [];
}

export function modelLabel(catalog: ModelCatalogView | null | undefined, selection: ModelSelection | undefined): string {
  if (!selection) return '';
  const choice = catalog?.choices.find(item => item.provider === selection.provider && item.model === selection.model);
  return choice ? choiceLabel(choice) : `${selection.provider}/${selection.model}`;
}

/** A model's display name without its id, for space-tight rows. */
export function modelName(catalog: ModelCatalogView | null | undefined, selection: ModelSelection | undefined): string {
  if (!selection) return '';
  const choice = catalog?.choices.find(item => item.provider === selection.provider && item.model === selection.model);
  return choice ? choice.name : selection.model;
}

/** The effort's display name, or the raw id when the catalog does not know it. */
export function effortLabel(
  catalog: ModelCatalogView | null | undefined, selection: ModelSelection | undefined,
): string {
  const effort = selection?.reasoningEffort;
  if (!effort) return '';
  const choice = catalog?.choices.find(item => item.provider === selection!.provider && item.model === selection!.model);
  return choice?.efforts?.find(item => item.id === effort)?.name ?? effort;
}

/** Names DSH's own preset picker gives the presets it ships without a published name. */
const BUILT_IN_PRESET_NAME: Record<string, string> = {
  standard: '标准模式',
  ptc: 'PTC 模式',
  minimal: '极简模式',
  cordis: '创造模式',
};

export function presetName(preset: AgentPresetOption): string {
  return preset.name || BUILT_IN_PRESET_NAME[preset.id] || preset.id;
}

/** A preset's label; the empty id means "whatever DSH composes by default". */
export function presetLabel(presets: PresetCatalogView | null | undefined, id: string | undefined): string {
  if (!id) {
    const fallback = presets?.presets.find(preset => preset.isDefault);
    return fallback ? `跟随 DSH 默认（${presetName(fallback)}）` : '跟随 DSH 默认';
  }
  const found = presets?.presets.find(preset => preset.id === id);
  return found ? presetName(found) : id;
}

/**
 * A preset for a one-line group summary: the name it actually runs, marked when
 * that comes from DSH rather than from the group. `presetLabel` spells the
 * fallback out in full, which is right in a dropdown and too long beside four
 * other facts.
 */
export function presetSummaryLabel(presets: PresetCatalogView | null | undefined, id: string | undefined): string {
  if (id) return presetLabel(presets, id);
  const fallback = presets?.presets.find(preset => preset.isDefault);
  return fallback ? `${presetName(fallback)}（DSH 默认）` : 'DSH 默认';
}

/** How full a context window is, for the member table's meter: amber from 70%, red from 90%. */
export function contextLevel(context: ContextUsage | undefined): 'ok' | 'warn' | 'high' | undefined {
  if (!context?.window) return undefined;
  const ratio = context.used / context.window;
  return ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'warn' : 'ok';
}

/** Compact token count: 812, 12.3k, 200k, 1.2M. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 100_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `12.3k / 200k（6%）`, or just the used count when DSH reported no window. */
export function contextLabel(context: ContextUsage | undefined): string {
  if (!context) return '';
  const used = formatTokens(context.used);
  if (!context.window) return used;
  return `${used} / ${formatTokens(context.window)}（${Math.round((context.used / context.window) * 100)}%）`;
}

export function dshDefaultLabel(catalog: ModelCatalogView | null | undefined): string {
  const value = catalog?.dshDefault;
  if (!value) return '跟随 DSH 默认模型';
  return `跟随 DSH 默认模型（${modelName(catalog, value)}）`;
}

/* ------------------------- groups and members ------------------------- */

export const BINDING_KIND_LABEL: Record<BindingKind, string> = { user: '个人（单聊）', group: '群聊' };

export const SESSION_STATE_LABEL: Record<GroupMemberView['sessionState'], string> = {
  bound: '已绑定',
  auto: '待创建',
  blank: '待使用',
  missing: '会话不存在',
  archived: '会话已归档',
  unusable: '会话不可用',
};

/** A usable Session's live state, as the member table's pill names it. */
export function sessionActivity(member: Pick<GroupMemberView, 'sessionState' | 'sessionRunning'>): string {
  if (member.sessionRunning) return '运行中';
  return member.sessionState === 'blank' ? '待使用' : '空闲';
}

/** DSH's own names for the permission presets (its Session picker, in Chinese). */
export const PERMISSION_LABEL: Readonly<Record<string, string>> = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
  auto: '自动审查（实验）',
  custom: '自定义',
};

/** One permission value in words; an unknown preset shows as itself. */
export function permissionLabel(value: string | undefined): string {
  return value ? PERMISSION_LABEL[value] ?? value : '—';
}

/** One line on what a mode lets a Session do, for hints next to the select. */
export const PERMISSION_HINT: Readonly<Record<PermissionMode, string>> = {
  'read-only': '只能读取工作区；修改文件或执行有副作用的命令需要审批。',
  'workspace-write': '可以在工作区内修改文件；超出工作区的操作需要审批。',
  'danger-full-access': '不受沙箱限制，也不再询问审批。',
};

/** Whether choosing `mode` has to be acknowledged first, as in DSH. */
export function needsRiskAcknowledgement(mode: string): boolean {
  return mode === FULL_ACCESS_MODE;
}

export interface GroupFact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}

/**
 * The facts a group owns, in the order its overview names them. A model or
 * preset the group leaves to DSH is marked so with the name it resolves to,
 * and an unset effort reads 默认 instead of vanishing.
 */
export function groupFacts(
  group: GroupView,
  catalog: ModelCatalogView | null | undefined,
  presets: PresetCatalogView | null | undefined,
): GroupFact[] {
  const effort = group.reasoningEffort
    ? (effortLabel(catalog, {
      provider: group.effectiveProvider, model: group.effectiveModel, reasoningEffort: group.reasoningEffort,
    }) || group.reasoningEffort)
    : '默认';
  return [
    { key: 'workspace', label: '工作区', value: group.workspaceTitle, title: group.workspacePath },
    { key: 'model', label: '模型', value: groupModelSummary(catalog, group) },
    { key: 'effort', label: '推理等级', value: effort },
    { key: 'preset', label: 'Agent 预设', value: presetSummaryLabel(presets, group.preset) },
    { key: 'permission', label: '工作区权限', value: permissionLabel(group.permission) },
  ];
}

/** The administrator notification scope in a few words; `[]` is every Workspace. */
export function scopeSummary(stored: readonly string[], total: number): string {
  return stored.length === 0 ? '全部工作区' : `${stored.length} / ${Math.max(total, stored.length)} 个工作区`;
}

/** `user:<userid>` / `group:<chatid>`: the key a note is stored under. */
export function personKey(kind: BindingKind, id: string): string {
  return `${kind}:${id}`;
}

/** One group's model for a summary line: its name, marked when it follows DSH. */
export function groupModelSummary(catalog: ModelCatalogView | null | undefined, group: GroupView): string {
  if (group.effectiveProvider && group.effectiveModel) {
    return modelName(catalog, { provider: group.effectiveProvider, model: group.effectiveModel });
  }
  const fallback = catalog?.dshDefault;
  return fallback ? `${modelName(catalog, fallback)}（DSH 默认）` : 'DSH 默认';
}

/* ------------------------------- display ------------------------------ */

/** Shorten a home-directory prefix for display: /Users/me/x → ~/x. */
export function displayPath(path: string | undefined): string {
  return (path ?? '').replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}

export function relativeTime(at: number | undefined, now = Date.now()): string {
  if (!at) return '';
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(at).toLocaleDateString();
}

/* --------------------------- routing operations ------------------------ */

/**
 * Write the store's settings block.
 *
 * One op carries a whole patch, because `settings.set` merges field by field on
 * the Host: 管理员 sends the array it just changed, 高级设置 sends the knobs it
 * just moved, and neither has to read the other's fields back
 * first.
 */
export function setSettings(patch: StoreSettingsPatch): StoreOp {
  return { op: 'settings.set', patch };
}

export function addGroup(name?: string): StoreOp {
  return { op: 'group.add', ...(name ? { name } : {}) };
}

export function updateGroup(id: string, patch: {
  name?: string;
  workspace?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  preset?: string;
  permission?: PermissionMode;
}): StoreOp {
  return { op: 'group.update', id, patch };
}

export function deleteGroup(id: string): StoreOp {
  return { op: 'group.delete', id };
}

export function addMember(groupId: string, kind: BindingKind, id: string, label?: string): StoreOp {
  return { op: 'member.add', groupId, kind, id, ...(label ? { label } : {}) };
}

export function updateMember(key: string, patch: { groupId?: string }): StoreOp {
  return { op: 'member.update', key, patch };
}

/** Set (or clear) a person's 备注; works for members and administrators alike. */
export function setLabel(key: string, label: string): StoreOp {
  return { op: 'label.set', key, label };
}

export function removeMember(key: string): StoreOp {
  return { op: 'member.remove', key };
}

/** Change only the member's current Session; a stale Session id is refused by the Host. */
export function setMemberModel(key: string, sessionId: string, selection: ModelSelection): StoreOp {
  return { op: 'member.model', key, sessionId, selection };
}

/** Put one member's bound Session under a Workspace access mode. */
export function setMemberPermission(key: string, sessionId: string, permission: PermissionMode): StoreOp {
  return { op: 'member.permission', key, sessionId, permission };
}

/** Archive one member's Session; the next message creates a fresh one. */
export function archiveMember(key: string): StoreOp {
  return { op: 'member.archive', key };
}
