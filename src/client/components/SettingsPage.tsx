import { useMemo } from 'react';
import { useBridgeState, useFormSnapshot } from '../hooks.ts';
import { storedFrom } from '../model.ts';
import type { ClientRemote, ConfigFormScope, FormSnapshot, OpenSession } from '../types.ts';
import { AdminSection } from './AdminSection.tsx';
import { AdvancedSection } from './AdvancedSection.tsx';
import { ConnectionSection } from './ConnectionSection.tsx';
import { GroupsSection } from './GroupsSection.tsx';
import { PendingSection } from './PendingSection.tsx';
import { SoulSection } from './SoulSection.tsx';
import { Notice } from './ui.tsx';

/**
 * Plugin homepage (`plugins.bundle.config`, view `page`), rendered inside the
 * Plugin Manager's package page, below its title and description.
 *
 * Sections in the order an operator needs them: 连接 (status and identity),
 * 待授权 (the inbox), 用户分组, 管理员, then the folded 高级设置. Only 连接
 * writes the plugin Config; everything else lands in the plugin's own store
 * and applies live. There is no page-wide 保存.
 */
export function SettingsPage({ scope, remote, onOpenSession }: { scope: ConfigFormScope; remote?: ClientRemote; onOpenSession?: OpenSession }) {
  const snapshot = useFormSnapshot(scope);
  if (snapshot.status !== 'ready') {
    return (
      <div className="wcb-page">
        <p className="wcb-status-text">{snapshot.status === 'loading' ? '正在加载插件配置…' : '插件配置暂不可用：请确认插件已启用。'}</p>
      </div>
    );
  }
  return <SettingsEditor snapshot={snapshot} scope={scope} remote={remote} onOpenSession={onOpenSession} />;
}

function SettingsEditor({ snapshot, scope, remote, onOpenSession }: { snapshot: FormSnapshot; scope: ConfigFormScope; remote?: ClientRemote; onOpenSession?: OpenSession }) {
  // The revision identifies the stored value; the snapshot object may be recreated.
  const base = useMemo(() => storedFrom(snapshot.value), [snapshot.revision]);
  const bridge = useBridgeState();
  const disabled = snapshot.writable === false;
  const state = bridge.data;
  const onChanged = () => bridge.refresh(true);

  return (
    <div className="wcb-page">
      {Boolean(state?.notices.length) && (
        <div className="wcb-notices">{state!.notices.map(notice => <Notice key={notice}>{notice}</Notice>)}</div>
      )}
      <ConnectionSection scope={scope} base={base} state={state} error={bridge.error} disabled={disabled} remote={remote} onChanged={onChanged} />
      <PendingSection state={state} disabled={disabled} onChanged={onChanged} />
      <GroupsSection
        state={state}
        error={bridge.error}
        disabled={disabled}
        refreshing={bridge.refreshing}
        onRefresh={() => bridge.refresh(true)}
        onChanged={onChanged}
        onOpenSession={onOpenSession}
      />
      <AdminSection state={state} disabled={disabled} onChanged={onChanged} />
      <SoulSection disabled={disabled} />
      <AdvancedSection settings={state?.settings} journal={state?.journal} disabled={disabled} onChanged={onChanged} />
    </div>
  );
}
