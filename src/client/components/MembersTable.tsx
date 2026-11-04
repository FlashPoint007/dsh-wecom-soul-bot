import { useRef, useState } from 'react';
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BridgeStateView, GroupMemberView, GroupView, PermissionMode, StoreOp } from '../../shared/protocol.ts';
import { useStoreApply } from '../hooks.ts';
import {
  SESSION_STATE_LABEL, archiveMember, choiceLabel, effortsFor, modelKey, modelName, parseModelKey, presetLabel,
  removeMember, sessionActivity, setLabel, setMemberModel, setMemberPermission, updateMember,
} from '../model.ts';
import type { OpenSession } from '../types.ts';
import { IconChevronRight } from './icons.tsx';
import { ContextMeter, FactRow, PermissionSelect, PersonButton, PersonDialog, Select, SessionDialog } from './ui.tsx';

const COLUMNS = ['成员', '会话', '模型', '推理等级', '工作区权限', '上下文'];

/**
 * A group's members as one semantic table: who, their Session's live state,
 * the model and reasoning effort it runs, and how full its context is. The
 * rest — the Session's name, id and preset, archiving, the note, moving to
 * another group — is one click away in a dialog, so a row stays one line.
 */
export function MembersTable({ group, groups, state, disabled, onChanged, onOpenSession }: {
  group: GroupView;
  groups: readonly GroupView[];
  state: BridgeStateView | undefined;
  disabled: boolean;
  onChanged(): void;
  onOpenSession?: OpenSession;
}) {
  return (
    <div className="wcb-table-scroll" tabIndex={0} role="region" aria-label={`${group.name} 成员表格，可横向滚动`}>
      <table className="wcb-table" aria-label={`${group.name} 的成员`}>
        <colgroup><col /><col className="wcb-col-session" /><col className="wcb-col-model" /><col className="wcb-col-effort" /><col className="wcb-col-access" /><col className="wcb-col-context" /></colgroup>
        <thead><tr>{COLUMNS.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>
          {group.members.map(member => (
            <MemberRow
              key={`${member.key}:${member.sessionId}`}
              member={member}
              group={group}
              groups={groups}
              state={state}
              disabled={disabled}
              onChanged={onChanged}
              onOpenSession={onOpenSession}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One row; its edits affect only this member's current Session. */
function MemberRow({ member, group, groups, state, disabled, onChanged, onOpenSession }: {
  member: GroupMemberView;
  group: GroupView;
  groups: readonly GroupView[];
  state: BridgeStateView | undefined;
  disabled: boolean;
  onChanged(): void;
  onOpenSession?: OpenSession;
}) {
  const [details, setDetails] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [navigationError, setNavigationError] = useState<string>();
  const pending = useRef(false);
  const write = useStoreApply(onChanged);
  const blocked = disabled || Boolean(write.busy);
  const catalog = state?.models;
  // The live Session model wins: the Session may have been switched in DSH
  // itself, which the stored selection (set from this page) never hears about.
  const selection = member.sessionModel ?? member.sessionSelection;
  const efforts = effortsFor(catalog, selection?.provider ?? '', selection?.model ?? '');
  const usable = Boolean(member.sessionId) && (member.sessionState === 'bound' || member.sessionState === 'blank');
  const name = member.displayName;
  const sessionTitle = member.sessionTitle || '未命名会话';
  const sessionInfo = `会话：${sessionTitle}\nSession ID：${member.sessionId}`;
  const error = write.error ?? navigationError;

  // Each row owns its busy/error state. The ref also rejects a second action
  // before React commits the busy state from the first one.
  const apply = async (ops: StoreOp[]): Promise<unknown> => {
    if (disabled || pending.current) return undefined;
    pending.current = true;
    setNavigationError(undefined);
    try { return await write.apply(member.key, ops); }
    finally { pending.current = false; }
  };

  // Navigation is the only thing that leaves the page, and only from the
  // dialog: the compact state in the table opens the identity first.
  const openSession = async (): Promise<void> => {
    setNavigationError(undefined);
    try {
      if (!onOpenSession) throw new Error('DSH 会话导航暂不可用，请刷新页面后重试。');
      await onOpenSession(member.sessionId);
      setSessionOpen(false);
    } catch (cause) {
      setNavigationError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const closeSession = (): void => {
    if (pending.current) return;
    setSessionOpen(false);
    setNavigationError(undefined);
  };

  const changeModel = async (value: string): Promise<void> => {
    const next = parseModelKey(value);
    if (!usable || !next.provider || !next.model) return;
    if (next.provider === selection?.provider && next.model === selection?.model) return;
    // A different model starts at its own default effort, never the previous
    // model's effort. A subsequent effort choice can pick an offered value.
    await apply([setMemberModel(member.key, member.sessionId, next)]);
  };

  const changePermission = async (mode: PermissionMode): Promise<void> => {
    if (!usable) return;
    await apply([setMemberPermission(member.key, member.sessionId, mode)]);
  };

  const changeEffort = async (value: string): Promise<void> => {
    if (!usable || !selection || (value && !efforts.some(item => item.id === value))) return;
    if (value === (selection.reasoningEffort ?? '')) return;
    const next = { provider: selection.provider, model: selection.model, ...(value ? { reasoningEffort: value } : {}) };
    await apply([setMemberModel(member.key, member.sessionId, next)]);
  };

  return (
    <>
      <tr className="wcb-member-row" aria-busy={Boolean(write.busy)}>
        <td>
          <span className="wcb-identity">
            <PersonButton kind={member.kind} name={name} label={`${name} 的详情`} disabled={blocked} onClick={() => setDetails(true)} />
            {member.admin && <Tag tone="neutral">管理员</Tag>}
          </span>
          <PersonDialog
            open={details}
            onClose={() => { if (!pending.current) setDetails(false); }}
            title={name}
            kind={member.kind}
            id={member.id}
            note={member.label}
            noteLabel={`${member.id} 的备注`}
            disabled={blocked}
            onNote={next => { void apply([setLabel(member.key, next)]); }}
            hint="备注会代替企业微信 ID 显示，移出分组后仍保留。切换分组时，目标分组里有 TA 之前的会话就恢复，否则下一条消息新建。"
            error={write.error}
            footer={<>
              <RemoveMember member={member} disabled={blocked} onApply={apply} />
              <Button variant="primary" size="sm" onClick={() => { if (!pending.current) setDetails(false); }}>完成</Button>
            </>}
          >
            <FactRow label="所属分组">
              <Select
                value={group.id} disabled={blocked} aria-label={`${member.id} 的所属分组`}
                onChange={event => {
                  const groupId = event.target.value;
                  if (!groupId || groupId === group.id) return;
                  void apply([updateMember(member.key, { groupId })]);
                }}
              >
                {groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </Select>
            </FactRow>
          </PersonDialog>
        </td>
        <td>
          {usable ? (
            <>
              <button
                type="button" className="wcb-session" data-running={member.sessionRunning ? '' : undefined}
                title={sessionInfo} aria-label={`查看 ${name} 的会话详情`}
                onClick={() => { setNavigationError(undefined); setSessionOpen(true); }}
              >
                <StateDot state={member.sessionRunning ? 'ongoing' : 'idle'} size={8} />
                {sessionActivity(member)}
                <span className="wcb-session-chevron" aria-hidden="true"><IconChevronRight size={10} /></span>
              </button>
              <SessionDialog
                open={sessionOpen}
                onClose={closeSession}
                name={name}
                title={sessionTitle}
                id={member.sessionId}
                running={member.sessionRunning}
                blank={member.sessionState === 'blank'}
                preset={member.sessionPreset ? presetLabel(state?.presets, member.sessionPreset) : '—'}
                permission={{
                  value: member.sessionPermission,
                  catalog: state?.permissions,
                  label: `${member.id} 的会话工作区权限`,
                  onChange: mode => { void changePermission(mode); },
                }}
                context={member.sessionContext}
                disabled={Boolean(write.busy)}
                error={error}
                onOpen={() => { void openSession(); }}
                onArchive={async () => {
                  const result = await apply([archiveMember(member.key)]);
                  if (result) setSessionOpen(false);
                  return Boolean(result);
                }}
              />
            </>
          ) : <span className="wcb-muted" title={member.sessionId ? sessionInfo : undefined}>{SESSION_STATE_LABEL[member.sessionState]}</span>}
        </td>
        <td>
          {usable ? (
            // Always a select: one click opens the list. Only this Session
            // changes; new Sessions keep using the group's default.
            <Select
              compact
              value={modelKey(selection?.provider ?? '', selection?.model ?? '')}
              disabled={blocked || !catalog?.choices.length}
              aria-label={`${member.id} 当前会话的模型`}
              title="只修改当前会话；新会话仍使用分组的默认模型"
              onChange={event => { void changeModel(event.target.value); }}
            >
              {!selection && <option value="" disabled>请选择模型</option>}
              {selection && !catalog?.choices.some(item => item.provider === selection.provider && item.model === selection.model)
                && <option value={modelKey(selection.provider, selection.model)}>{modelName(catalog, selection)}（当前）</option>}
              {(catalog?.choices ?? []).map(choice => (
                <option
                  key={modelKey(choice.provider, choice.model)} value={modelKey(choice.provider, choice.model)}
                  title={`${choice.providerName} / ${choiceLabel(choice)}`}
                >
                  {choice.name}
                </option>
              ))}
            </Select>
          ) : <span className="wcb-muted">—</span>}
        </td>
        <td>
          {usable && selection ? (
            <Select
              compact
              value={selection.reasoningEffort ?? ''}
              disabled={blocked || !efforts.length}
              aria-label={`${member.id} 当前会话的推理等级`}
              title={efforts.length ? '只修改当前会话的推理等级' : '当前模型没有可调的推理等级'}
              onChange={event => { void changeEffort(event.target.value); }}
            >
              <option value="">默认</option>
              {efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          ) : <span className="wcb-muted">—</span>}
        </td>
        <td>
          {usable ? (
            <PermissionSelect
              compact
              value={member.sessionPermission}
              catalog={state?.permissions}
              scope={`${name} 的这个会话`}
              disabled={blocked}
              label={`${member.id} 当前会话的工作区权限`}
              title="只修改当前会话；新会话仍使用分组的工作区权限"
              onChange={mode => { void changePermission(mode); }}
            />
          ) : <span className="wcb-muted">—</span>}
        </td>
        <td><ContextMeter context={member.sessionContext} /></td>
      </tr>
      {error && !details && !sessionOpen && (
        <tr className="wcb-member-error"><td colSpan={COLUMNS.length}><p className="wcb-error" role="alert">{error}</p></td></tr>
      )}
    </>
  );
}

/** 移出分组, confirmed in place inside the person dialog's footer. */
function RemoveMember({ member, disabled, onApply }: {
  member: GroupMemberView;
  disabled: boolean;
  onApply(ops: StoreOp[]): Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <span className="wcb-footer-start">
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setConfirming(false)}>取消</Button>
      <Button variant="outline" size="sm" className="wcb-danger" disabled={disabled}
        onClick={() => { void onApply([removeMember(member.key)]); }}>
        确认移出「{member.displayName}」
      </Button>
    </span>
  ) : (
    <Button variant="outline" size="sm" className="wcb-danger wcb-footer-start" disabled={disabled} onClick={() => setConfirming(true)}>
      移出分组
    </Button>
  );
}
