import { useState } from 'react';
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import { postStore } from '../api.ts';
import type { BridgeStateView, GroupView, RejectedSenderView } from '../../shared/protocol.ts';
import { addMember, relativeTime } from '../model.ts';
import { Editor, Field, FormFooter, KindAvatar, Section, Select } from './ui.tsx';

/**
 * 待授权: senders the Bot refused because they belong to no group — the page's
 * inbox. Each row shows the latest refused message so the operator can tell
 * who is knocking; 加入分组 opens an inline editor and authorizes in one write.
 * The list is Host memory only, so it resets when DSH restarts.
 */
export function PendingSection({ state, disabled, onChanged }: {
  state: BridgeStateView | undefined;
  disabled: boolean;
  onChanged(): void;
}) {
  const rows = state?.rejected ?? [];
  const groups = state?.routing?.groups ?? [];
  return (
    <Section
      id="pending"
      title="待授权"
      count={rows.length ? <Tag tone="warning">{rows.length}</Tag> : undefined}
      description="给机器人发过消息、但还不在任何分组里的人或群聊。加入分组即完成授权；列表只保存在内存中，重启 DSH 后清空。"
    >
      {rows.length === 0 ? (
        <p className="wcb-empty-line">暂无。对方给机器人发一条消息后会出现在这里。</p>
      ) : (
        <div className="wcb-card">
          <ul className="wcb-list">
            {rows.map(row => <PendingRow key={row.key} row={row} groups={groups} disabled={disabled} onChanged={onChanged} />)}
          </ul>
        </div>
      )}
    </Section>
  );
}

function PendingRow({ row, groups, disabled, onChanged }: {
  row: RejectedSenderView;
  groups: readonly Pick<GroupView, 'id' | 'name' | 'isDefault'>[];
  disabled: boolean;
  onChanged(): void;
}) {
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState(groups.find(group => group.isDefault)?.id ?? groups[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function authorize(): Promise<void> {
    if (!groupId) { setError('还没有可用的分组。'); return; }
    setBusy(true);
    setError(undefined);
    try {
      await postStore([addMember(groupId, row.kind, row.id, label.trim())]);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="wcb-pending-row">
      <div className="wcb-row-line">
        <KindAvatar kind={row.kind} />
        <div className="wcb-row-main">
          <span className="wcb-row-title" title={row.id}>{row.displayName}</span>
          {row.text && <span className="wcb-row-quote" title={row.text}>“{row.text}”</span>}
        </div>
        <span className="wcb-row-meta">{row.messages} 条 · {relativeTime(row.lastSeenAt)}</span>
        {!open && (
          <Button variant="outline" size="sm" disabled={disabled || !groups.length} onClick={() => setOpen(true)}>
            加入分组
          </Button>
        )}
      </div>
      {open && (
        <Editor>
          <div className="wcb-editor-grid">
            <Field label="分组">
              <Select value={groupId} disabled={disabled || busy} aria-label={`${row.id} 的分组`} onChange={event => setGroupId(event.target.value)}>
                {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
              </Select>
            </Field>
            <Field label="备注（可选）" hint="会代替企业微信 ID 显示。">
              <Input
                className="wcb-input"
                value={label}
                placeholder={row.id}
                disabled={disabled || busy}
                aria-label={`${row.id} 的备注`}
                onChange={event => setLabel(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void authorize(); } }}
              />
            </Field>
          </div>
          <FormFooter message={error} tone={error ? 'error' : undefined}>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setOpen(false); setError(undefined); }}>取消</Button>
            <Button variant="primary" size="sm" disabled={disabled || busy} onClick={() => { void authorize(); }}>
              {busy ? '授权中…' : '确认授权'}
            </Button>
          </FormFooter>
        </Editor>
      )}
    </li>
  );
}
