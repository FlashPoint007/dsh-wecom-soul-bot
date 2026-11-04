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
            label="长期记忆"
            hint={`共享记忆 ${state.memory.sharedEntries} 条。会话记忆只在对应的私聊或群里可见；共享记忆只能在主人私聊时写入。`}
          >
            <span className="wcb-switch-row">
              <Switch checked={settings.memoryEnabled} disabled={busy} label="长期记忆" onChange={next => void save({ memoryEnabled: next })} />
              <span>{settings.memoryEnabled ? '已开启' : '已关闭'}</span>
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
