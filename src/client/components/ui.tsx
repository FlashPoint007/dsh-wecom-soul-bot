/**
 * Building blocks shared by the page sections, modelled on DSH's own Plugin
 * Manager and Settings pages: a section is a title over whitespace, an object
 * is a settings card, a list is hairline rows, an edit happens in a recessed
 * editor, and details open in DSH's Modal with its own header and footer.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, SelectHTMLAttributes } from 'react';
import { Button, Input, Modal, StateDot, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BindingKind, ContextUsage, PermissionCatalogView, PermissionMode } from '../../shared/protocol.ts';
import { FULL_ACCESS_MODE } from '../../shared/protocol.ts';
import {
  BINDING_KIND_LABEL, contextLabel, contextLevel, formatTokens, needsRiskAcknowledgement, permissionLabel,
  type GroupFact,
} from '../model.ts';
import { IconCheck, IconChevronRight, IconCopy, IconUser, IconUsers, IconWarning } from './icons.tsx';

export function Section({ id, title, count, description, actions, children }: {
  /** Stable hook for tests and the preview script: `data-section`. */
  id: string;
  title: ReactNode;
  count?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="wcb-section" data-section={id}>
      <div className="wcb-section-head">
        <h4 className="wcb-section-title">{title}</h4>
        {count !== undefined && count !== '' && <span className="wcb-section-count">{count}</span>}
        {actions && <div className="wcb-section-actions">{actions}</div>}
      </div>
      {description && <p className="wcb-section-desc">{description}</p>}
      {children}
    </section>
  );
}

export function Notice({ tone, children }: { tone?: 'warning' | 'error'; children: ReactNode }) {
  return (
    <p className="wcb-notice" data-tone={tone ?? 'warning'} role="status">
      <span className="wcb-notice-icon" aria-hidden="true"><IconWarning size={14} /></span>
      <span>{children}</span>
    </p>
  );
}

/** Native select styled like DSH's settings selects; `compact` is the in-table size. */
export function Select({ className, compact, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean }) {
  return <select {...rest} data-compact={compact ? '' : undefined} className={['wcb-select', className].filter(Boolean).join(' ')} />;
}

/** One stacked field: label above, control, then an error or a hint. */
export function Field({ label, hint, error, children }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="wcb-field" data-invalid={error ? '' : undefined}>
      <span className="wcb-field-label">{label}</span>
      {children}
      {error ? <span className="wcb-error" role="alert">{error}</span> : hint && <span className="wcb-hint">{hint}</span>}
    </label>
  );
}

/** The recessed panel an inline edit happens in. */
export function Editor({ children }: { children: ReactNode }) {
  return <div className="wcb-editor">{children}</div>;
}

/** An editor's last line: a status message, an optional leading action, then the buttons. */
export function FormFooter({ message, tone, start, children }: {
  message?: ReactNode;
  tone?: 'error' | 'success' | 'dirty';
  start?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="wcb-footer">
      {start}
      <p className="wcb-footer-message" data-tone={tone} role="status">{message}</p>
      {children}
    </div>
  );
}

/** Labelled facts on one wrapping line, label quiet and value a step stronger. */
export function Facts({ facts, className }: { facts: readonly GroupFact[]; className?: string }) {
  return (
    <span className={['wcb-kvs', className].filter(Boolean).join(' ')}>
      {facts.map(fact => (
        <span className="wcb-kv" key={fact.key} data-fact={fact.key}>
          <span className="wcb-kv-label">{fact.label}</span>
          <span className="wcb-kv-value" title={fact.title}>{fact.value}</span>
        </span>
      ))}
    </span>
  );
}

/** A private chat and a group chat at a glance: blue person, amber group. */
export function KindAvatar({ kind }: { kind: BindingKind }) {
  return (
    <span className="wcb-avatar" data-kind={kind} aria-hidden="true">
      {kind === 'group' ? <IconUsers size={14} /> : <IconUser size={14} />}
    </span>
  );
}

/** A person's badge and name as one button that opens their details. */
export function PersonButton({ kind, name, label, disabled, onClick }: {
  kind: BindingKind;
  name: string;
  /** Accessible name, e.g. `爱丽丝 的详情`. */
  label: string;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className="wcb-person" aria-label={label} title={name} disabled={disabled} onClick={onClick}>
      <KindAvatar kind={kind} />
      <span className="wcb-person-name">{name}</span>
      <span className="wcb-person-chevron" aria-hidden="true"><IconChevronRight size={12} /></span>
    </button>
  );
}

/** Context occupancy as a short bar plus `used / window`; the percentage is in the tooltip. */
export function ContextMeter({ context }: { context?: ContextUsage }) {
  if (!context) return <span className="wcb-muted">—</span>;
  const level = contextLevel(context);
  if (!context.window || !level) return <span className="wcb-meter-text">{formatTokens(context.used)}</span>;
  const percent = Math.min(100, Math.round((context.used / context.window) * 100));
  return (
    <span className="wcb-meter" data-level={level} title={`上下文 ${contextLabel(context)}`}>
      <span className="wcb-meter-track" aria-hidden="true"><span className="wcb-meter-fill" style={{ width: `${percent}%` }} /></span>
      <span className="wcb-meter-text">{formatTokens(context.used)} / {formatTokens(context.window)}</span>
    </span>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (): Promise<void> => {
    if (!await writeClipboard(text)) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="wcb-icon-button" aria-label={copied ? '已复制' : label} title={copied ? '已复制' : label}
      onClick={() => { void copy(); }}>
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
}

/**
 * DSH's Modal with this page's content conventions: the children stack with a
 * common gap, the actions go to the Modal's own footer, and the dialog keeps
 * DSH's padding (only its width is the page's).
 */
export function Dialog({ open, onClose, title, children, footer }: {
  open: boolean;
  onClose(): void;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} closeLabel="关闭" className="wcb-dialog" footer={footer}>
      <div className="wcb-dialog-body">{children}</div>
    </Modal>
  );
}

/**
 * DSH's Full access gate: a warning, and a box that has to be ticked before the
 * confirming button does anything. Cancelling (or closing) changes nothing.
 */
export function RiskDialog({ open, scope, busy, onCancel, onConfirm }: {
  open: boolean;
  /** Whose access is widened, e.g. `本组的所有会话` or `这个会话`. */
  scope: string;
  busy?: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { if (!open) setAcknowledged(false); }, [open]);
  return (
    <Dialog
      open={open} onClose={onCancel} title="确认启用完全权限？"
      footer={<>
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>取消</Button>
        <Button variant="primary" size="sm" className="wcb-danger-solid" disabled={busy || !acknowledged} onClick={onConfirm}>
          启用完全权限
        </Button>
      </>}
    >
      <Notice tone="warning">
        启用完全权限后，{scope}将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。企业微信里的消息也会以这个权限运行。仅建议在你信任这些任务时使用。
      </Notice>
      <label className="wcb-check">
        <input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} />
        <span>我已了解风险，并愿意继续</span>
      </label>
    </Dialog>
  );
}

/**
 * The Workspace-access select, shared by the group editor, the members table and
 * the Session dialog. Picking Full access never takes effect on its own: the
 * risk dialog opens first, and only its confirmation calls `onChange`.
 */
export function PermissionSelect({ value, catalog, scope, disabled, compact, label, title, onChange, onAskRisk }: {
  /** The mode in effect; `custom`, `auto` and unknown presets are shown but never chosen. */
  value: string | undefined;
  catalog: PermissionCatalogView | undefined;
  /** What Full access would widen, for the risk dialog. */
  scope: string;
  disabled?: boolean;
  compact?: boolean;
  label: string;
  title?: string;
  onChange(mode: PermissionMode): void;
  /**
   * Where the risk dialog is shown by someone else (a dialog must not stack
   * another one on top of itself); without it the select opens its own.
   */
  onAskRisk?(mode: PermissionMode): void;
}) {
  const [asking, setAsking] = useState<PermissionMode>();
  const modes = catalog?.modes ?? [];
  const known = value !== undefined && (modes as readonly string[]).includes(value);
  const choose = (next: string): void => {
    const mode = modes.find(item => item === next);
    if (!mode || mode === value) return;
    if (!needsRiskAcknowledgement(mode)) onChange(mode);
    else if (onAskRisk) onAskRisk(mode);
    else setAsking(mode);
  };
  return (
    <>
      <Select
        compact={compact}
        value={value ?? ''}
        disabled={disabled || !catalog?.available || !modes.length}
        aria-label={label}
        title={catalog && !catalog.available ? '当前 DSH 没有权限模式服务，无法设置' : title}
        onChange={event => choose(event.target.value)}
      >
        {!value && <option value="" disabled>未知</option>}
        {value && !known && <option value={value} disabled>{permissionLabel(value)}（当前）</option>}
        {modes.map(mode => <option key={mode} value={mode}>{permissionLabel(mode)}</option>)}
      </Select>
      <RiskDialog
        open={asking === FULL_ACCESS_MODE}
        scope={scope}
        onCancel={() => setAsking(undefined)}
        onConfirm={() => { const mode = asking; setAsking(undefined); if (mode) onChange(mode); }}
      />
    </>
  );
}

/** One row of a dialog's facts list: label left, value or control right. */
export function FactRow({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'wcb-mono' : undefined}>{children}</dd>
    </div>
  );
}

/**
 * One person's details: what kind of principal it is, its WeCom id, and the
 * editable 备注 that replaces the id everywhere else. The note saves on blur
 * or Enter — it is Host state, applied at once like every routing edit.
 */
export function PersonDialog({
  open, onClose, title, kind, typeLabel, id, note, noteLabel, disabled, onNote, children, hint, error, footer,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  kind: BindingKind;
  typeLabel?: string;
  id: string;
  note: string;
  noteLabel: string;
  disabled?: boolean;
  onNote(next: string): void;
  /** Extra fact rows (所属分组, …). */
  children?: ReactNode;
  hint?: ReactNode;
  error?: string;
  footer?: ReactNode;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={footer}>
      <dl className="wcb-facts">
        <FactRow label="类型">{typeLabel ?? BINDING_KIND_LABEL[kind]}</FactRow>
        <FactRow label="企业微信 ID" mono>{id}<CopyButton text={id} label="复制企业微信 ID" /></FactRow>
        <FactRow label="备注">
          <Input
            key={note}
            className="wcb-input"
            defaultValue={note}
            placeholder={id}
            disabled={disabled}
            aria-label={noteLabel}
            onBlur={event => {
              const next = event.target.value.trim();
              if (next !== note) onNote(next);
            }}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          />
        </FactRow>
        {children}
      </dl>
      {hint && <p className="wcb-hint">{hint}</p>}
      {error && <p className="wcb-error" role="alert">{error}</p>}
    </Dialog>
  );
}

/**
 * A bound Session's identity, before any navigation.
 *
 * The member table only has room for a compact state, and clicking it never
 * leaves the page: the name, the id and the facts are read here, and only
 * 打开会话 navigates. Archiving is a two-step action inside the same dialog,
 * so no second modal stacks on top of this one.
 */
export function SessionDialog({
  open, onClose, name, title, id, running, blank, preset, permission, context, disabled, error, onOpen, onArchive,
}: {
  open: boolean;
  onClose(): void;
  /** The member's display name, so the dialog says whose Session it is. */
  name: string;
  title: string;
  id: string;
  running: boolean;
  /** A created Session whose first turn has not started yet. */
  blank?: boolean;
  preset: string;
  /** This Session's Workspace access: what it runs under now, and how to change it. */
  permission: {
    value: string | undefined;
    catalog: PermissionCatalogView | undefined;
    label: string;
    onChange(mode: PermissionMode): void;
  };
  context?: ContextUsage;
  disabled?: boolean;
  error?: string;
  onOpen(): void;
  /** Resolves true once archived; the dialog then closes. */
  onArchive(): Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [risk, setRisk] = useState<PermissionMode>();
  useEffect(() => { if (!open) { setConfirming(false); setRisk(undefined); } }, [open]);
  const archive = async (): Promise<void> => {
    if (await onArchive()) setConfirming(false);
  };

  // Like archiving, the Full access gate replaces this dialog's content instead
  // of stacking a second modal on top of it.
  if (risk) {
    return (
      <RiskDialog
        open={open} scope="这个会话" busy={disabled}
        onCancel={() => setRisk(undefined)}
        onConfirm={() => { permission.onChange(risk); setRisk(undefined); }}
      />
    );
  }
  if (confirming) {
    return (
      <Dialog
        open={open} onClose={onClose} title={`归档「${name}」的会话？`}
        footer={<>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => setConfirming(false)}>取消</Button>
          <Button variant="primary" size="sm" className="wcb-danger-solid" disabled={disabled} onClick={() => { void archive(); }}>
            {disabled ? '归档中…' : '确认归档'}
          </Button>
        </>}
      >
        <p className="wcb-confirm-text">
          归档后这个会话不再被继续，它的历史不会再进入任何请求；{name} 的下一条消息会按分组当前的工作区、模型与 Agent 预设新建会话。会话记录仍保留在 DSH 的「已归档」中。
        </p>
        {error && <p className="wcb-error" role="alert">{error}</p>}
      </Dialog>
    );
  }
  return (
    <Dialog
      open={open} onClose={onClose} title={`${name} 的会话`}
      footer={<>
        <Button variant="outline" size="sm" className="wcb-danger wcb-footer-start" disabled={disabled}
          aria-label={`归档 ${name} 的会话`} onClick={() => setConfirming(true)}>
          归档会话
        </Button>
        <Button variant="primary" size="sm" disabled={disabled} onClick={onOpen}>打开会话</Button>
      </>}
    >
      <dl className="wcb-facts">
        <FactRow label="会话名称">{title}</FactRow>
        <FactRow label="状态">
          <StateDot state={running ? 'ongoing' : 'idle'} size={10} />
          {blank ? '待使用（还没有开始）' : running ? '运行中' : '空闲'}
        </FactRow>
        <FactRow label="Agent 预设">{preset}</FactRow>
        <FactRow label="工作区权限">
          <PermissionSelect
            value={permission.value} catalog={permission.catalog} scope="这个会话" disabled={disabled}
            label={permission.label} onChange={permission.onChange} onAskRisk={setRisk}
          />
        </FactRow>
        <FactRow label="上下文">{contextLabel(context) || '—'}</FactRow>
        <FactRow label="会话 ID" mono>{id}<CopyButton text={id} label="复制会话 ID" /></FactRow>
      </dl>
      {error && <p className="wcb-error" role="alert">{error}</p>}
    </Dialog>
  );
}

/** A confirmation step for a destructive edit that has no dialog of its own. */
export function ConfirmDialog({ open, title, children, confirmLabel, busy, error, onCancel, onConfirm }: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog
      open={open} onClose={onCancel} title={title}
      footer={<>
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>取消</Button>
        <Button variant="primary" size="sm" className="wcb-danger-solid" disabled={busy} onClick={onConfirm}>
          {busy ? '处理中…' : confirmLabel}
        </Button>
      </>}
    >
      {children}
      {error && <p className="wcb-error" role="alert">{error}</p>}
    </Dialog>
  );
}
