import { useEffect, useState } from 'react';
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import type { JournalInfo, StoreSettings } from '../../shared/protocol.ts';
import { useStoreSettingsSave } from '../hooks.ts';
import { advancedSlice, settingsPatch, validateAdvanced } from '../model.ts';
import { IconChevronRight } from './icons.tsx';
import { CopyButton, Field, FormFooter } from './ui.tsx';

/**
 * 高级设置 (folded): the private-deployment endpoint and the JSONL journal.
 *
 * Both live in the store's settings block. The endpoint is half of the
 * connection, so saving it is the one edit on the page that reconnects the
 * Bot; the journal fields are adopted by the running Bot in place. The section
 * therefore keeps an explicit 保存 and writes one patch for the fields that moved.
 */
export function AdvancedSection({ settings, journal, disabled, onChanged }: {
  settings: StoreSettings | undefined;
  journal: JournalInfo | undefined;
  disabled: boolean;
  onChanged(): void;
}) {
  const stored = advancedSlice(settings);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => advancedSlice(settings));
  const [attempted, setAttempted] = useState(false);
  const save = useStoreSettingsSave(onChanged);
  const patch = settingsPatch(draft, stored);
  const dirty = Object.keys(patch).length > 0;
  const errors = attempted ? validateAdvanced(draft) : {};

  // Rebase on the store's copy whenever its values move, keyed by the values so
  // a poll repeating what this section already shows leaves the draft alone.
  const storedKey = JSON.stringify(stored);
  useEffect(() => { setDraft(advancedSlice(settings)); }, [storedKey]);

  const summary = [
    stored.wsUrl ? '自定义接入地址' : '默认接入地址',
    stored.logEnabled ? `对话日志保留 ${stored.logRetentionDays} 天` : '对话日志已关闭',
  ].join(' · ');
  const message = save.error ?? (dirty ? '有未保存的更改' : save.saved ? '已保存。' : undefined);
  const tone = save.error ? 'error' : dirty ? 'dirty' : save.saved ? 'success' : undefined;

  return (
    <section className="wcb-section" data-section="advanced">
      <div className="wcb-section-head">
        <button type="button" className="wcb-section-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          <span className="wcb-chevron" aria-hidden="true"><IconChevronRight size={14} /></span>
          <h4 className="wcb-section-title">高级设置</h4>
          <span className="wcb-section-summary">{summary}</span>
        </button>
      </div>
      {open && (
        <div className="wcb-card">
          <div className="wcb-card-body wcb-advanced">
            <Field
              label="WebSocket 地址"
              error={errors.wsUrl}
              hint="留空使用企业微信默认地址，仅私有化部署需要填写（wss://）。保存这一项会重新连接机器人。"
            >
              <Input
                className="wcb-input"
                value={draft.wsUrl}
                placeholder="wss://openws.work.weixin.qq.com"
                spellCheck={false}
                disabled={disabled}
                aria-label="WebSocket 地址"
                onChange={event => setDraft(current => ({ ...current, wsUrl: event.target.value }))}
              />
            </Field>
            <Field
              label="对话日志"
              error={errors.logRetentionDays}
              hint="每条企业微信消息写一行 JSONL（round.complete 及明细），Secret 等敏感字段已脱敏。修改即时生效，不会断开连接。"
            >
              <span className="wcb-switch-row">
                <Switch checked={draft.logEnabled} disabled={disabled} label="记录对话日志"
                  onChange={next => setDraft(current => ({ ...current, logEnabled: next }))} />
                <span>{draft.logEnabled ? '记录，保留' : '不记录'}</span>
                {draft.logEnabled && <>
                  <Input
                    className="wcb-number"
                    type="number" min={1} max={365} step={1}
                    value={draft.logRetentionDays}
                    disabled={disabled}
                    aria-label="日志保留天数"
                    onChange={event => setDraft(current => ({ ...current, logRetentionDays: Number(event.target.value) }))}
                  />
                  <span>天</span>
                </>}
              </span>
            </Field>
            {journal?.directory && (
              <span className="wcb-path" title={journal.file}>
                <span className="wcb-path-text">{journal.directory}</span>
                <CopyButton text={journal.directory} label="复制日志目录" />
              </span>
            )}
            <FormFooter message={message} tone={tone}>
              {dirty && <Button variant="ghost" size="sm" disabled={save.saving}
                onClick={() => { setDraft(advancedSlice(settings)); setAttempted(false); }}>放弃</Button>}
              <Button variant="primary" size="sm" disabled={disabled || save.saving || !dirty}
                onClick={() => {
                  setAttempted(true);
                  if (Object.keys(validateAdvanced(draft)).length) return;
                  void save.save(patch);
                }}>
                {save.saving ? '保存中…' : '保存'}
              </Button>
            </FormFooter>
          </div>
        </div>
      )}
    </section>
  );
}
