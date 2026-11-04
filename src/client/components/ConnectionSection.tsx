import { useEffect, useState } from 'react';
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BridgeStateView, ConnectionPhase, TrafficStats } from '../../shared/protocol.ts';
import { storeCredential } from '../api.ts';
import { useConfigSave, useSecretStatus } from '../hooks.ts';
import { relativeTime, validateCredentials } from '../model.ts';
import type { ClientRemote, ConfigFormScope, StoredConfig } from '../types.ts';
import { Editor, Field, FormFooter, Section } from './ui.tsx';

type Dot = 'done' | 'warning' | 'ongoing' | 'error' | 'idle';

const PHASES: Record<ConnectionPhase, { label: string; dot: Dot; tone?: 'error' | 'warning' }> = {
  unconfigured: { label: '未配置', dot: 'idle' },
  invalid: { label: '配置无效', dot: 'error', tone: 'error' },
  connecting: { label: '连接中', dot: 'ongoing' },
  online: { label: '在线', dot: 'done' },
  reconnecting: { label: '重连中', dot: 'ongoing', tone: 'warning' },
  offline: { label: '已断开', dot: 'warning', tone: 'warning' },
  displaced: { label: '被其他连接替换', dot: 'error', tone: 'error' },
  error: { label: '连接错误', dot: 'error', tone: 'error' },
};

/**
 * 连接: the Bot's live status and its identity, in one card.
 *
 * Once both credentials are stored the card is a summary — status, Bot ID,
 * Secret state and the traffic since DSH started — and 编辑 opens the form in
 * place. A fresh install opens it by itself, because there is nothing else to
 * do first. This is the only part of the page that writes the plugin Config
 * (the Bot ID); the Secret goes to DSH's credential store.
 */
export function ConnectionSection({ scope, base, state, error, disabled, remote, onChanged }: {
  scope: ConfigFormScope;
  base: StoredConfig;
  state: BridgeStateView | undefined;
  /** Why the state route could not be read. */
  error?: string;
  disabled: boolean;
  remote?: ClientRemote;
  onChanged(): void;
}) {
  const status = useSecretStatus(remote, base.secretEnv);
  const save = useConfigSave(scope, onChanged);
  // undefined: open exactly while the setup is incomplete; a click decides from then on.
  const [editing, setEditing] = useState<boolean>();
  const [botId, setBotId] = useState(base.botId);
  const [secret, setSecret] = useState('');
  const [reveal, setReveal] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [secretError, setSecretError] = useState<string>();

  useEffect(() => { setBotId(base.botId); }, [base.botId]);

  const incomplete = !base.botId || (status.known && !status.configured);
  const open = editing ?? incomplete;
  const dirty = botId.trim() !== base.botId || Boolean(secret.trim());
  const errors = attempted ? validateCredentials({ botId, secret }, status.configured) : {};
  const phase = state ? PHASES[state.connection.phase] ?? PHASES.error : undefined;
  const detail = error ?? state?.connection.detail;

  const close = (): void => {
    setEditing(false);
    setBotId(base.botId);
    setSecret('');
    setReveal(false);
    setAttempted(false);
    setSecretError(undefined);
  };

  async function onSave(): Promise<void> {
    setAttempted(true);
    setSecretError(undefined);
    if (Object.keys(validateCredentials({ botId, secret }, status.configured)).length) return;
    if (!(await save.save({ botId: botId.trim() }))) return;
    if (secret.trim()) {
      try {
        await storeCredential(remote?.credentials, base.secretEnv, secret.trim());
        status.refresh();
      } catch (cause) {
        setSecretError(`Bot ID 已保存，但 Secret 保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
        return;
      }
    }
    setSecret('');
    setReveal(false);
    setAttempted(false);
    setEditing(false);
  }

  return (
    <Section id="connection" title="连接">
      <div className="wcb-card">
        <div className="wcb-card-body">
          <div className="wcb-connection-head">
            <span className="wcb-status" role="status">
              <StateDot state={error ? 'error' : phase?.dot ?? 'ongoing'} size={10} />
              <span className="wcb-status-label">{error ? '状态不可用' : phase?.label ?? '正在读取状态…'}</span>
              {state && !error && <span className="wcb-status-since">{relativeTime(state.connection.since)}</span>}
            </span>
            <span className="wcb-spacer" />
            {save.saved && !open && <span className="wcb-saved" role="status">已保存。</span>}
            {!open && (
              <Button variant="outline" size="sm" disabled={disabled} aria-label="编辑连接" onClick={() => setEditing(true)}>
                编辑
              </Button>
            )}
          </div>
          {detail && <p className="wcb-status-detail" data-tone={error ? 'error' : phase?.tone}>{detail}</p>}
          <span className="wcb-kvs">
            <span className="wcb-kv"><span className="wcb-kv-label">Bot ID</span><span className="wcb-kv-value wcb-mono">{base.botId || '未填写'}</span></span>
            <span className="wcb-kv"><span className="wcb-kv-label">Bot Secret</span><span className="wcb-kv-value">{status.configured ? '已保存' : '未设置'}</span></span>
          </span>
          {state && state.connection.phase !== 'unconfigured' && <Traffic traffic={state.traffic} />}

          {open && (
            <Editor>
              <Field label="Bot ID" error={errors.botId} hint="在企业微信管理后台 → 智能机器人 → API 模式（长连接）中获取。">
                <Input
                  className="wcb-input"
                  value={botId}
                  placeholder="例如 aib0xxxxxxxxxxxx"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={disabled}
                  aria-label="Bot ID"
                  onChange={event => setBotId(event.target.value)}
                />
              </Field>
              <Field
                label="Bot Secret"
                error={errors.secret ?? secretError}
                hint={status.configured
                  ? `已保存在 DSH 凭据库（${base.secretEnv}），不会回显；留空则保持不变。`
                  : `保存在 DSH 凭据库（${base.secretEnv}），不会写入插件配置。`}
              >
                <span className="wcb-input-row">
                  <Input
                    className="wcb-input"
                    type={reveal ? 'text' : 'password'}
                    value={secret}
                    placeholder={status.configured ? '输入新值以替换' : '粘贴 Bot Secret'}
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={disabled}
                    aria-label="Bot Secret"
                    onChange={event => setSecret(event.target.value)}
                  />
                  <Button variant="outline" size="sm" disabled={!secret} onClick={() => setReveal(value => !value)}>
                    {reveal ? '隐藏' : '显示'}
                  </Button>
                </span>
              </Field>
              <FormFooter message={save.error} tone={save.error ? 'error' : undefined}>
                {!incomplete && <Button variant="ghost" size="sm" disabled={save.saving} onClick={close}>取消</Button>}
                <Button variant="primary" size="sm" disabled={disabled || save.saving || !dirty} onClick={() => { void onSave(); }}>
                  {save.saving ? '保存中…' : '保存'}
                </Button>
              </FormFooter>
            </Editor>
          )}
        </div>
      </div>
    </Section>
  );
}

/** What the Bot has done since this DSH process started; failures only when there are any. */
function Traffic({ traffic }: { traffic: TrafficStats }) {
  if (!traffic.received && !traffic.notifications) {
    return <p className="wcb-hint">本次启动以来还没有收到消息。</p>;
  }
  const items: [string, string | number][] = [
    ['收到', traffic.received],
    ['拒绝', traffic.rejected],
    ['提交', traffic.prompts],
    ['通知', traffic.notifications],
  ];
  if (traffic.failures) items.push(['失败', traffic.failures]);
  if (traffic.lastMessageAt) items.push(['最近消息', relativeTime(traffic.lastMessageAt)]);
  return (
    <span className="wcb-kvs" aria-label="本次 DSH 启动以来的统计">
      <span className="wcb-kv-label">本次启动以来</span>
      {items.map(([label, value]) => (
        <span className="wcb-kv" key={label}>
          <span className="wcb-kv-label">{label}</span>
          <span className="wcb-kv-value">{value}</span>
        </span>
      ))}
    </span>
  );
}
