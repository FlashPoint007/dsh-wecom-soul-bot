import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { SOUL_ROUTE, type SoulResponse, type SoulSettingsPatch, type SoulStateView } from '../../shared/protocol.ts';
import { Field, FormFooter, Notice, Section } from './ui.tsx';

/** Document-relative, so it follows whatever base path serves the DSH GUI. */
export const SOUL_URL = SOUL_ROUTE.replace(/^\//, '');

async function callSoul(patch?: SoulSettingsPatch): Promise<SoulStateView> {
  let response: Response;
  try {
    response = await fetch(SOUL_URL, {
      method: patch ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(patch ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) } : {}),
    });
  } catch {
    throw new Error('无法连接插件后台，请确认 DSH 仍在运行。');
  }
  if (response.status === 401 || response.status === 403) throw new Error('DSH 登录已失效，请刷新页面。');
  if (response.status === 404) throw new Error('插件后台尚未加载新版本，请重启 DSH 后再试。');
  let body: SoulResponse;
  try {
    body = await response.json() as SoulResponse;
  } catch {
    throw new Error(`人设设置读写失败（HTTP ${response.status}）。`);
  }
  if (!body.ok) throw new Error(body.error);
  return body.state;
}

function parseOwners(text: string): string[] {
  return [...new Set(text.split(/[\s,，、]+/).map(item => item.trim()).filter(Boolean))];
}

/**
 * 人设与记忆: the persona card, the chat-mode switch, the memory switch and the
 * owner list. Saved through `/api/wecom-soul-bot/soul`; applied from the
 * next message, with no reconnect.
 */
export function SoulSection({ disabled }: { disabled: boolean }) {
  const [state, setState] = useState<SoulStateView>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [persona, setPersona] = useState('');
  const [owners, setOwners] = useState('');

  const adopt = useCallback((next: SoulStateView) => {
    setState(next);
    setPersona(next.settings.persona);
    setOwners(next.settings.ownerUserIds.join(', '));
  }, []);

  useEffect(() => {
    let active = true;
    callSoul().then(next => { if (active) adopt(next); }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [adopt]);

  const save = async (patch: SoulSettingsPatch) => {
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      adopt(await callSoul(patch));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!state) {
    return (
      <Section id="soul" title="人设与记忆">
        {error ? <Notice tone="error">{error}</Notice> : <p className="wcb-status-text">正在读取人设设置…</p>}
      </Section>
    );
  }

  const settings = state.settings;
  const busy = disabled || saving;
  const ownerDraft = parseOwners(owners);
  const dirty = persona !== settings.persona || ownerDraft.join('\u0000') !== settings.ownerUserIds.join('\u0000');
  const message = error ?? (dirty ? '有未保存的更改' : saved ? '已保存，下一条消息起生效。' : undefined);
  const tone = error ? 'error' : dirty ? 'dirty' : saved ? 'success' : undefined;

  return (
    <Section
      id="soul"
      title="人设与记忆"
      description="只作用于机器人自己绑定的会话，你在 DSH 里开的其他会话不受影响。修改从下一条消息起生效，不会断开连接。"
    >
      <div className="wcb-card">
        <div className="wcb-card-body wcb-advanced">
          <Field label="人设" hint="开启后，每条消息都会带上发送者身份，并注入下面的人设。">
            <span className="wcb-switch-row">
              <Switch checked={settings.enabled} disabled={busy} label="启用人设" onChange={next => void save({ enabled: next })} />
              <span>{settings.enabled ? '已启用' : '已关闭'}</span>
            </span>
          </Field>
          <Field label="聊天模式" hint="开启后只回复模型原话：不发「已提交给 DSH」回执，不发会话卡片，群聊回复也不会抄送给管理员。">
            <span className="wcb-switch-row">
              <Switch checked={settings.chatMode} disabled={busy} label="聊天模式" onChange={next => void save({ chatMode: next })} />
              <span>{settings.chatMode ? '已开启' : '已关闭'}</span>
            </span>
          </Field>
          <Field
            label="工作模式"
            hint={state.toolGuard
              ? '开启后，只有主人发的消息能让机器人调用 skill 和工具（查日志、告警、nyx 打包、发版）。同一轮里只要有群友的消息，就只能用记忆工具。工具权限仍受分组的工作区权限和 DSH 审批约束。'
              : '当前 DSH 不支持工具拦截（tools.guard），为安全起见工作模式不会生效，所有轮次都只能聊天。'}
          >
            <span className="wcb-switch-row">
              <Switch checked={settings.workMode} disabled={busy} label="工作模式" onChange={next => void save({ workMode: next })} />
              <span>{settings.workMode ? (state.toolGuard ? '已开启（仅主人）' : '已开启但未生效') : '已关闭（只聊天）'}</span>
            </span>
          </Field>
          <Field
            label="长期记忆"
            hint={`核心 ${state.memory.coreEntries} 条（不会忘）· 近期 ${state.memory.episodicEntries} 条（其中 ${state.memory.fadedEntries} 条已淡忘，可被回忆找回）· 共享 ${state.memory.sharedEntries} 条。近期记忆按遗忘曲线变淡，半衰期 ${settings.halfLifeDays} 天，重要度和每次回忆都会让它忘得更慢。`}
          >
            <span className="wcb-switch-row">
              <Switch checked={settings.memoryEnabled} disabled={busy} label="长期记忆" onChange={next => void save({ memoryEnabled: next })} />
              <span>{settings.memoryEnabled ? '已开启' : '已关闭'}</span>
            </span>
          </Field>
          <Field
            label="到点提醒"
            hint={`对机器人说「明早 9 点提醒我开会」，它会真的定上，到点用人设口吻发回原会话。当前待发 ${state.memory.pendingReminders} 条。`}
          >
            <span className="wcb-switch-row">
              <Switch checked={settings.remindersEnabled} disabled={busy} label="到点提醒" onChange={next => void save({ remindersEnabled: next })} />
              <span>{settings.remindersEnabled ? '已开启' : '已关闭'}</span>
            </span>
          </Field>
          <Field
            label="主动搭话"
            hint={`默认关闭。开启后每 ${settings.proactiveIntervalMinutes} 分钟掷一次骰子（不花 token），${Math.round(settings.proactiveChance * 100)}% 概率主动给主人私聊发一句；${settings.quietStartHour}:00–${settings.quietEndHour}:00 不打扰，每天最多 ${settings.proactiveDailyLimit} 次，两次间隔至少 ${settings.proactiveCooldownMinutes} 分钟。没话说时它会选择沉默。今天已发 ${state.memory.proactiveToday} 次。`}
          >
            <span className="wcb-switch-row">
              <Switch checked={settings.proactiveEnabled} disabled={busy} label="主动搭话" onChange={next => void save({ proactiveEnabled: next })} />
              <span>{settings.proactiveEnabled ? '已开启（仅主人私聊）' : '已关闭'}</span>
            </span>
          </Field>
          <Field label="主动搭话参数" hint="间隔（分钟）、命中概率（0–100%）、安静时段起止（时）、每日上限、冷却（分钟）。改完立即生效。">
            <span className="wcb-switch-row">
              <NumberBox label="间隔" value={settings.proactiveIntervalMinutes} min={5} max={1440} disabled={busy} onSave={v => save({ proactiveIntervalMinutes: v })} />
              <NumberBox label="概率%" value={Math.round(settings.proactiveChance * 100)} min={0} max={100} disabled={busy} onSave={v => save({ proactiveChance: v / 100 })} />
              <NumberBox label="安静起" value={settings.quietStartHour} min={0} max={23} disabled={busy} onSave={v => save({ quietStartHour: v })} />
              <NumberBox label="安静止" value={settings.quietEndHour} min={0} max={23} disabled={busy} onSave={v => save({ quietEndHour: v })} />
              <NumberBox label="每日上限" value={settings.proactiveDailyLimit} min={0} max={50} disabled={busy} onSave={v => save({ proactiveDailyLimit: v })} />
              <NumberBox label="冷却" value={settings.proactiveCooldownMinutes} min={0} max={1440} disabled={busy} onSave={v => save({ proactiveCooldownMinutes: v })} />
              <NumberBox label="记忆半衰期(天)" value={settings.halfLifeDays} min={1} max={365} disabled={busy} onSave={v => save({ halfLifeDays: v })} />
            </span>
          </Field>
          <Field
            label="主人 userid"
            hint={state.ownersFromAdmins
              ? `留空时沿用管理员列表（当前：${state.effectiveOwners.join('、') || '无'}）。多个用逗号分隔。`
              : '只有这些 userid 会被人设当作主人。多个用逗号分隔。'}
          >
            <Input
              className="wcb-input"
              value={owners}
              placeholder="例如 zhangsan"
              spellCheck={false}
              disabled={busy}
              aria-label="主人 userid"
              onChange={event => setOwners(event.target.value)}
            />
          </Field>
          <Field label="人设提示词" hint="Markdown 文本，最多 20000 字。">
            <textarea
              className="wcb-textarea"
              value={persona}
              rows={16}
              spellCheck={false}
              disabled={busy}
              aria-label="人设提示词"
              onChange={event => setPersona(event.target.value)}
            />
          </Field>
          <span className="wcb-path" title={state.memory.directory}>
            <span className="wcb-path-text">{state.memory.directory}</span>
          </span>
          <FormFooter message={message} tone={tone}>
            {dirty && <Button variant="ghost" size="sm" disabled={saving} onClick={() => adopt(state)}>放弃</Button>}
            <Button variant="primary" size="sm" disabled={busy || !dirty}
              onClick={() => void save({ persona, ownerUserIds: ownerDraft })}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </FormFooter>
        </div>
      </div>
    </Section>
  );
}

/** One integer setting saved on blur or Enter; out-of-range input is clamped by the Host's validation and rejected with a message. */
function NumberBox({ label, value, min, max, disabled, onSave }: {
  label: string; value: number; min: number; max: number; disabled: boolean; onSave(next: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || n < min || n > max) { setDraft(String(value)); return; }
    if (n !== value) onSave(n);
  };
  return (
    <span className="wcb-switch-row">
      <span>{label}</span>
      <Input
        className="wcb-number"
        type="number" min={min} max={max} step={1}
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') commit(); }}
      />
    </span>
  );
}
