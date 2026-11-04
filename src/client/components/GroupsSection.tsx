import { useEffect, useState } from 'react';
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BridgeStateView, GroupView, PermissionMode, StoreOp, WorkspaceOption } from '../../shared/protocol.ts';
import { useStoreApply } from '../hooks.ts';
import {
  addGroup, choiceLabel, deleteGroup, displayPath, dshDefaultLabel, effortsFor, groupFacts, modelKey,
  parseModelKey, PERMISSION_HINT, presetLabel, presetName, updateGroup,
} from '../model.ts';
import type { OpenSession } from '../types.ts';
import { IconChevronRight, IconPlus, IconRefresh, IconTrash } from './icons.tsx';
import { MembersTable } from './MembersTable.tsx';
import { ConfirmDialog, Editor, Facts, Field, FormFooter, Notice, PermissionSelect, Section, Select } from './ui.tsx';

/**
 * 用户分组. A group owns a Workspace, a model (with its reasoning effort), an
 * Agent preset and the Workspace access its Sessions run with (read-only unless
 * granted; Full access needs the same acknowledgement DSH asks for); its members are the WeCom users and group chats that may talk
 * to the Bot, each with its own Session. The built-in 「默认分组」 cannot be
 * deleted.
 *
 * Each group is one card: the header names every fact it owns (so a folded
 * group is still a complete overview), the members table opens below it, and
 * 编辑 turns the overview into an inline editor that writes once, on 保存.
 * Members are added from 待授权, never here.
 */
export function GroupsSection({ state, error, disabled, refreshing, onRefresh, onChanged, onOpenSession }: {
  state: BridgeStateView | undefined;
  error?: string;
  disabled: boolean;
  refreshing: boolean;
  onRefresh(): void;
  onChanged(): void;
  onOpenSession?: OpenSession;
}) {
  const { busy, error: applyError, apply } = useStoreApply(onChanged);
  const [freshId, setFreshId] = useState<string>();
  const view = state?.routing;

  // A group created here opens its own editor; the flag is consumed by the
  // first render of the new card (which captures it as its initial state).
  useEffect(() => {
    if (freshId && view?.groups.some(group => group.id === freshId)) setFreshId(undefined);
  }, [freshId, view]);

  const add = async (): Promise<void> => {
    const response = await apply('group:new', [addGroup()]);
    if (response?.createdGroupId) setFreshId(response.createdGroupId);
  };

  return (
    <Section
      id="groups"
      title="用户分组"
      count={view ? `${view.groups.length} 个分组 · ${view.total} 位成员` : undefined}
      description="分组决定成员使用的工作区、模型、Agent 预设与工作区权限；每位成员（单聊的人或一个群聊）各有自己的会话。"
      actions={<>
        <Button variant="ghost" size="sm" icon={<IconRefresh size={14} />} disabled={refreshing} title="重新读取会话状态" onClick={onRefresh}>
          {refreshing ? '刷新中' : '刷新'}
        </Button>
        <Button variant="outline" size="sm" icon={<IconPlus size={14} />} disabled={disabled || busy === 'group:new'} onClick={() => { void add(); }}>
          添加分组
        </Button>
      </>}
    >
      {applyError && <Notice tone="error">{applyError}</Notice>}
      {!view ? (
        <p className="wcb-empty-line">{error ?? state?.routingError ?? '正在读取分组…'}</p>
      ) : (
        <div className="wcb-groups">
          {view.groups.map(group => (
            <GroupCard
              key={group.id}
              group={group}
              state={state}
              startEditing={group.id === freshId}
              startOpen={view.groups.length === 1}
              disabled={disabled || busy.startsWith(`group:${group.id}`)}
              onApply={apply}
              onChanged={onChanged}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      )}
      {view && view.total === 0 && (
        <p className="wcb-empty-line">还没有成员：让对方先给机器人发一条消息，再在「待授权」中把 TA 加入分组。</p>
      )}
    </Section>
  );
}

interface GroupDraft {
  name: string;
  workspace: string;
  provider: string;
  model: string;
  effort: string;
  preset: string;
  permission: PermissionMode;
}

function draftOf(group: GroupView): GroupDraft {
  return {
    name: group.name, workspace: group.workspace, provider: group.provider,
    model: group.model, effort: group.reasoningEffort ?? '', preset: group.preset,
    permission: group.permission,
  };
}

/** The minimal patch that turns `group` into `draft`; empty when nothing changed. */
function patchOf(group: GroupView, draft: GroupDraft): Parameters<typeof updateGroup>[1] {
  const patch: {
    name?: string; workspace?: string; provider?: string; model?: string; reasoningEffort?: string; preset?: string;
    permission?: PermissionMode;
  } = {};
  const name = draft.name.trim();
  if (name && name !== group.name) patch.name = name;
  if (draft.workspace !== group.workspace) patch.workspace = draft.workspace;
  if (draft.provider !== group.provider || draft.model !== group.model) {
    // A model change resets the effort: the new model may not offer the old one.
    patch.provider = draft.provider;
    patch.model = draft.model;
    patch.reasoningEffort = '';
  } else if (draft.effort !== (group.reasoningEffort ?? '')) {
    patch.reasoningEffort = draft.effort;
  }
  if (draft.preset !== group.preset) patch.preset = draft.preset;
  if (draft.permission !== group.permission) patch.permission = draft.permission;
  return patch;
}

function GroupCard({ group, state, startEditing, startOpen, disabled, onApply, onChanged, onOpenSession }: {
  group: GroupView;
  state: BridgeStateView | undefined;
  startEditing: boolean;
  startOpen: boolean;
  disabled: boolean;
  onApply(key: string, ops: StoreOp[]): Promise<unknown>;
  onChanged(): void;
  onOpenSession?: OpenSession;
}) {
  const [open, setOpen] = useState(startEditing || startOpen);
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState<GroupDraft>(() => draftOf(group));
  const [deleting, setDeleting] = useState(false);
  const catalog = state?.models;
  const presets = state?.presets;
  const workspaces: readonly WorkspaceOption[] = state?.workspaces ?? [];
  const key = `group:${group.id}`;
  const facts = groupFacts(group, catalog, presets);

  // Leaving the editor (a save, a delete elsewhere) re-seeds the draft from truth.
  useEffect(() => { if (!editing) setDraft(draftOf(group)); }, [group, editing]);

  const efforts = effortsFor(catalog, draft.provider || group.effectiveProvider, draft.model || group.effectiveModel);
  const update = (patch: Partial<GroupDraft>): void => setDraft(current => ({ ...current, ...patch }));
  const patch = patchOf(group, draft);
  const changed = Object.keys(patch).length > 0;
  const modelChanged = draft.provider !== group.provider || draft.model !== group.model || draft.effort !== (group.reasoningEffort ?? '');
  const roster = presets?.presets ?? [];

  const startEdit = (): void => {
    setDraft(draftOf(group));
    setEditing(true);
    setOpen(true);
  };

  const save = async (): Promise<void> => {
    if (!changed) { setEditing(false); return; }
    if (await onApply(key, [updateGroup(group.id, patch)])) setEditing(false);
  };

  return (
    <div className="wcb-card wcb-group" data-open={open ? '' : undefined}>
      <div className="wcb-group-head">
        <button type="button" className="wcb-group-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          <span className="wcb-group-title-line">
            <span className="wcb-chevron" aria-hidden="true"><IconChevronRight size={14} /></span>
            <span className="wcb-group-name">{group.name}</span>
            {group.isDefault && <Tag tone="neutral">默认</Tag>}
            <span className="wcb-group-count">{group.memberCount ? `${group.memberCount} 位成员` : '暂无成员'}</span>
          </span>
          {!editing && <Facts facts={facts} className="wcb-group-facts" />}
        </button>
        {!editing && (
          <div className="wcb-group-actions">
            <Button variant="outline" size="sm" disabled={disabled} aria-label={`编辑 ${group.name}`} onClick={startEdit}>编辑</Button>
          </div>
        )}
      </div>
      {group.workspaceError && <p className="wcb-group-error" role="alert">{group.workspaceError}</p>}

      {editing && (
        <Editor>
          <div className="wcb-editor-grid">
            <Field label="名称">
              <Input className="wcb-input" value={draft.name} disabled={disabled} aria-label={`${group.name} 的名称`}
                onChange={event => update({ name: event.target.value })} />
            </Field>
            <Field label="工作区" hint={draft.workspace !== group.workspace ? '保存后，本组成员会在下一条消息时于新工作区中新建会话。' : undefined}>
              <Select value={draft.workspace} disabled={disabled} aria-label={`${group.name} 的工作区`}
                onChange={event => update({ workspace: event.target.value })}>
                <option value="">插件自带（{displayPath(workspaces.find(workspace => workspace.pluginOwned)?.path)}）</option>
                {workspaces.map(workspace => (
                  <option key={workspace.path} value={workspace.path}>{workspace.title}（{displayPath(workspace.path)}）</option>
                ))}
                {draft.workspace && !workspaces.some(workspace => workspace.path === draft.workspace) && (
                  <option value={draft.workspace}>{displayPath(draft.workspace)}（未注册）</option>
                )}
              </Select>
            </Field>
            <Field label="模型" hint={modelChanged ? '是本组新会话的默认值；为单个会话选过模型的成员不受影响。' : undefined}>
              <Select value={modelKey(draft.provider, draft.model)} disabled={disabled || !catalog} aria-label={`${group.name} 的模型`}
                onChange={event => {
                  const next = parseModelKey(event.target.value);
                  update({ provider: next.provider, model: next.model, effort: '' });
                }}>
                <option value="">{dshDefaultLabel(catalog)}</option>
                {(catalog?.choices ?? []).map(choice => (
                  <option key={modelKey(choice.provider, choice.model)} value={modelKey(choice.provider, choice.model)}>
                    {choice.providerName} / {choiceLabel(choice)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="推理等级" hint={!(draft.provider || draft.model)
              ? '跟随 DSH 默认模型时，使用它的默认推理等级。'
              : !efforts.length ? '所选模型没有可调的推理等级。' : undefined}>
              <Select value={draft.effort} disabled={disabled || !efforts.length || !(draft.provider || draft.model)}
                aria-label={`${group.name} 的推理等级`} onChange={event => update({ effort: event.target.value })}>
                <option value="">默认</option>
                {efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </Select>
            </Field>
            <Field
              label="Agent 预设"
              hint={draft.preset !== group.preset
                ? '只影响之后新建的会话；已开始的会话无法更换预设。'
                : !roster.length ? `未读取到预设列表${state?.presetsError ? `：${state.presetsError}` : ''}。` : undefined}
            >
              <Select value={draft.preset} disabled={disabled || !roster.length} aria-label={`${group.name} 的 Agent 预设`}
                onChange={event => update({ preset: event.target.value })}>
                <option value="">{presetLabel(presets, '')}</option>
                {roster.map(preset => (
                  <option key={preset.id} value={preset.id}>{presetName(preset)}{preset.broken ? '（加载失败）' : ''}</option>
                ))}
              </Select>
            </Field>
            <Field
              label="工作区权限"
              hint={draft.permission !== group.permission
                ? `保存后立即应用到本组已有的会话，包括单独改过权限的成员；新会话也按此创建。${PERMISSION_HINT[draft.permission]}`
                : PERMISSION_HINT[group.permission]}
            >
              <PermissionSelect
                value={draft.permission} catalog={state?.permissions} scope="本组的所有会话" disabled={disabled}
                label={`${group.name} 的工作区权限`}
                onChange={permission => update({ permission })}
              />
            </Field>
          </div>
          <FormFooter start={!group.isDefault && (
            <Button variant="outline" size="sm" className="wcb-danger" icon={<IconTrash size={14} />} disabled={disabled}
              onClick={() => setDeleting(true)}>
              删除分组
            </Button>
          )}>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { setEditing(false); setDraft(draftOf(group)); }}>取消</Button>
            <Button variant="primary" size="sm" disabled={disabled || !changed} onClick={() => { void save(); }}>保存</Button>
          </FormFooter>
        </Editor>
      )}

      {open && (
        <div className="wcb-group-body">
          {group.members.length === 0 ? (
            <p className="wcb-empty">这个分组还没有成员。对方给机器人发一条消息后，在「待授权」里把 TA 加入本组。</p>
          ) : (
            <MembersTable
              group={group}
              groups={state?.routing?.groups ?? []}
              state={state}
              disabled={disabled}
              onChanged={onChanged}
              onOpenSession={onOpenSession}
            />
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleting}
        title={`删除分组「${group.name}」？`}
        confirmLabel="确认删除"
        busy={disabled}
        onCancel={() => setDeleting(false)}
        onConfirm={() => { void onApply(key, [deleteGroup(group.id)]).then(result => { if (result) setDeleting(false); }); }}
      >
        <p className="wcb-confirm-text">
          {group.memberCount
            ? `组内 ${group.memberCount} 位成员会被移出并失去授权，之后需要在「待授权」中重新加入分组。`
            : '这个分组没有成员。'}
          DSH 中已有的会话不会被删除。
        </p>
      </ConfirmDialog>
    </div>
  );
}
