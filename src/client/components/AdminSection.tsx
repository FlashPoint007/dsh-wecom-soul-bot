import { useEffect, useMemo, useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BridgeStateView, GroupView } from '../../shared/protocol.ts';
import { useStoreApply, useStoreSettingsSave } from '../hooks.ts';
import { addMember, displayPath, personKey, scopeIncludes, scopeSummary, setLabel, toggle, toggleScope } from '../model.ts';
import { IconChevronRight, IconPlus } from './icons.tsx';
import { Dialog, Editor, FactRow, FormFooter, Notice, PersonButton, PersonDialog, Section, Select } from './ui.tsx';

/**
 * 管理员: who may switch Sessions (/sessions, /use, /new, /workspaces), approve
 * tool calls in a private chat, and receive notices from the Workspaces in
 * scope. The list and the scope are the store's settings block, applied live
 * without a reconnect, so every edit here is written on the click — there is
 * no 保存. Administrator powers are independent of group membership.
 */
export function AdminSection({ state, disabled, onChanged }: {
  state: BridgeStateView | undefined;
  disabled: boolean;
  onChanged(): void;
}) {
  const storedIds = state?.settings?.adminUserIds ?? [];
  const storedScope = state?.settings?.adminWorkspaces ?? [];
  const [draft, setDraft] = useState(() => ({ adminUserIds: [...storedIds], adminWorkspaces: [...storedScope] }));
  const [picking, setPicking] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const save = useStoreSettingsSave(onChanged);
  const routing = useStoreApply(onChanged);
  const admins = state?.admins ?? [];
  const groups = state?.routing?.groups ?? [];
  const workspaces = state?.workspaces ?? [];
  const all = draft.adminWorkspaces.length === 0;
  const busy = disabled || save.saving;

  // Rebase on the store's copy whenever its values move — keyed by the values,
  // not by the polled object, so a poll repeating what this card already shows
  // cannot undo an optimistic click while its write is in flight.
  const storedKey = `${storedIds.join('\u0000')}\u0001${storedScope.join('\u0000')}`;
  useEffect(() => {
    setDraft({ adminUserIds: [...storedIds], adminWorkspaces: [...storedScope] });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the two lists
  }, [storedKey]);

  /**
   * Write one edit now. The draft follows the click immediately and comes back
   * from the store when the write fails, so the list never shows an unsaved
   * change. Only the array that moved is part of the patch.
   */
  const apply = async (patch: Partial<{ adminUserIds: string[]; adminWorkspaces: string[] }>): Promise<void> => {
    setDraft(current => ({ ...current, ...patch }));
    if (!(await save.save(patch))) setDraft({ adminUserIds: [...storedIds], adminWorkspaces: [...storedScope] });
  };

  const known = new Map(admins.map(admin => [admin.id, admin]));

  return (
    <Section
      id="admins"
      title="管理员"
      count={draft.adminUserIds.length ? `${draft.adminUserIds.length} 人` : undefined}
      description="可以在单聊中切换会话（/sessions、/use、/new、/workspaces）、审批工具调用，并接收通知范围内所有会话的通知。管理员无需加入分组。"
      actions={
        <Button variant="outline" size="sm" icon={<IconPlus size={14} />} disabled={busy} aria-label="添加管理员" onClick={() => setPicking(true)}>
          添加
        </Button>
      }
    >
      {routing.error && <Notice tone="error">{routing.error}</Notice>}
      {save.error && <Notice tone="error">{save.error}</Notice>}

      {draft.adminUserIds.length === 0 ? (
        <p className="wcb-empty-line">还没有管理员：没有人可以切换会话、审批工具调用或接收其他会话的通知。</p>
      ) : (
        <div className="wcb-card">
          <ul className="wcb-list">
            {draft.adminUserIds.map(id => (
              <AdminRow
                key={id}
                id={id}
                label={known.get(id)?.label ?? ''}
                groupName={known.get(id)?.groupName}
                groups={groups}
                disabled={busy || routing.busy === personKey('user', id)}
                onAssign={groupId => routing.apply(personKey('user', id), [addMember(groupId, 'user', id)])}
                onNote={next => { void routing.apply(personKey('user', id), [setLabel(personKey('user', id), next)]); }}
                onRemove={() => { void apply({ adminUserIds: toggle(draft.adminUserIds, id, false) }); }}
              />
            ))}
          </ul>
          <div className="wcb-scope">
            <div className="wcb-scope-head">
              <button type="button" className="wcb-scope-toggle" aria-expanded={scopeOpen} onClick={() => setScopeOpen(value => !value)}>
                <span className="wcb-chevron" aria-hidden="true"><IconChevronRight size={14} /></span>
                <span>通知范围</span>
                <span className="wcb-section-summary">{scopeSummary(draft.adminWorkspaces, workspaces.length)}</span>
              </button>
              <span className="wcb-spacer" />
              {!all && (
                <button type="button" className="wcb-link" disabled={busy} onClick={() => { void apply({ adminWorkspaces: [] }); }}>
                  恢复为全部
                </button>
              )}
            </div>
            {scopeOpen && (workspaces.length === 0 ? (
              <p className="wcb-hint">还没有注册任何工作区。默认分组的工作区会在第一次创建会话时注册。</p>
            ) : (
              <>
                <ul className="wcb-scope-list">
                  {workspaces.map(workspace => (
                    <li key={workspace.path}>
                      <label className="wcb-check-row">
                        <input
                          type="checkbox"
                          checked={scopeIncludes(draft.adminWorkspaces, workspace.path)}
                          disabled={busy}
                          aria-label={`管理员接收 ${workspace.title} 的通知`}
                          onChange={event => {
                            void apply({
                              adminWorkspaces: toggleScope(draft.adminWorkspaces, workspaces.map(item => item.path), workspace.path, event.target.checked),
                            });
                          }}
                        />
                        <span className="wcb-row-main">
                          <span className="wcb-row-title">{workspace.title}</span>
                          <span className="wcb-row-quote wcb-mono" title={workspace.path}>{displayPath(workspace.path)}</span>
                        </span>
                        <span className="wcb-row-meta">{workspace.sessionCount ? `${workspace.sessionCount} 个会话` : '暂无会话'}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="wcb-hint">
                  {all ? '全部勾选（默认）：包括以后新增的工作区。' : '只接收勾选工作区中的会话通知。'}勾选即生效。
                </p>
              </>
            ))}
          </div>
        </div>
      )}

      <AdminPicker
        open={picking}
        state={state}
        current={draft.adminUserIds}
        onClose={() => setPicking(false)}
        onPick={id => { void apply({ adminUserIds: toggle(draft.adminUserIds, id, true) }); setPicking(false); }}
      />
    </Section>
  );
}

/** A search over the people the page already knows, with a manual fallback. */
function AdminPicker({ open, state, current, onClose, onPick }: {
  open: boolean;
  state: BridgeStateView | undefined;
  current: readonly string[];
  onClose(): void;
  onPick(id: string): void;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  /** People the operator already knows about, best name first. */
  const candidates = useMemo(() => {
    const rows = new Map<string, { id: string; name: string; hint: string }>();
    for (const sender of state?.rejected ?? []) {
      if (sender.kind !== 'user') continue;
      rows.set(sender.id, { id: sender.id, name: sender.label || sender.id, hint: sender.label ? `待授权 · ${sender.id}` : '待授权' });
    }
    for (const group of state?.routing?.groups ?? []) {
      for (const member of group.members) {
        if (member.kind !== 'user') continue;
        rows.set(member.id, { id: member.id, name: member.displayName, hint: member.label ? `${group.name} · ${member.id}` : group.name });
      }
    }
    for (const id of current) rows.delete(id);
    return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [state, current]);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? candidates.filter(row => row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle))
    : candidates;
  const typed = query.trim();

  return (
    <Dialog open={open} onClose={onClose} title="添加管理员">
      <Input
        className="wcb-input"
        value={query}
        autoFocus
        placeholder="搜索备注名或企业微信 userid"
        aria-label="搜索已知用户"
        onChange={event => setQuery(event.target.value)}
      />
      {matches.length > 0 && (
        <div className="wcb-picker-list" role="listbox" aria-label="已知用户">
          {matches.map(row => (
            <button key={row.id} type="button" className="wcb-picker-row" role="option" aria-selected={false} onClick={() => onPick(row.id)}>
              <span className="wcb-row-title">{row.name}</span>
              <span className="wcb-picker-hint">{row.hint}</span>
            </button>
          ))}
        </div>
      )}
      {typed && !candidates.some(row => row.id === typed) && !current.includes(typed) && (
        <div className="wcb-picker-manual">
          <span className="wcb-row-main">
            <span className="wcb-row-title">按 userid 添加「{typed}」</span>
            <span className="wcb-picker-hint">适用于还没给机器人发过消息的人</span>
          </span>
          <Button variant="outline" size="sm" onClick={() => onPick(typed)}>添加</Button>
        </div>
      )}
      {!typed && matches.length === 0 && <p className="wcb-hint">还没有已知用户。输入企业微信 userid 即可直接添加。</p>}
      <p className="wcb-hint">候选人来自待授权与分组成员，选中即生效。</p>
    </Dialog>
  );
}

/** The name opens the details; an unassigned administrator can join a group explicitly. */
function AdminRow({ id, label, groupName, groups, disabled, onAssign, onNote, onRemove }: {
  id: string;
  label: string;
  groupName?: string;
  groups: readonly Pick<GroupView, 'id' | 'name'>[];
  disabled: boolean;
  onAssign(groupId: string): Promise<unknown>;
  onNote(next: string): void;
  onRemove(): void;
}) {
  const [details, setDetails] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const name = label || id;
  return (
    <li className="wcb-admin-row">
      <div className="wcb-row-line">
        <PersonButton kind="user" name={name} label={`${name} 的详情`} disabled={disabled} onClick={() => setDetails(true)} />
        <span className="wcb-spacer" />
        {groupName ? <span className="wcb-row-meta">分组：{groupName}</span> : (
          <button
            type="button" className="wcb-link" disabled={disabled}
            aria-label={`为 ${name} 分配分组`} aria-expanded={assigning}
            onClick={() => setAssigning(value => !value)}
          >
            不在任何分组
          </button>
        )}
      </div>
      {assigning && !groupName && (
        <Editor>
          <label className="wcb-field">
            <span className="wcb-field-label">加入分组</span>
            <Select
              value="" autoFocus disabled={disabled || !groups.length}
              aria-label={`管理员 ${id} 的分组`}
              onChange={event => {
                const groupId = event.target.value;
                if (!groupId) return;
                void onAssign(groupId).then(result => { if (result) setAssigning(false); });
              }}
            >
              <option value="" disabled>{groups.length ? '请选择分组' : '暂无可用分组'}</option>
              {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </Select>
            <span className="wcb-hint">选择后立即加入；之后的消息按该组的工作区、模型与 Agent 预设处理，管理员权限不变。</span>
          </label>
          <FormFooter>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setAssigning(false)}>取消</Button>
          </FormFooter>
        </Editor>
      )}
      <PersonDialog
        open={details}
        onClose={() => setDetails(false)}
        title={name}
        kind="user"
        typeLabel="管理员（个人）"
        id={id}
        note={label}
        noteLabel={`管理员 ${id} 的备注`}
        disabled={disabled}
        onNote={onNote}
        hint="备注会代替企业微信 ID 显示。移除管理员不会影响 TA 的分组成员身份。"
        footer={<>
          <Button variant="outline" size="sm" className="wcb-danger wcb-footer-start" disabled={disabled}
            aria-label={`移除管理员 ${id}`} onClick={onRemove}>
            移除管理员
          </Button>
          <Button variant="primary" size="sm" onClick={() => setDetails(false)}>完成</Button>
        </>}
      >
        <FactRow label="所属分组">{groupName ?? '不在任何分组'}</FactRow>
      </PersonDialog>
    </li>
  );
}
