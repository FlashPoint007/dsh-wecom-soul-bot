/** React hooks binding the page to DSH Config forms, credentials and the state route. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BridgeStateView, StoreOp, StoreResponse, StoreSettingsPatch } from '../shared/protocol.ts';
import { describeCredential, fetchState, postStore } from './api.ts';
import { changedOperations, setSettings, storedFrom } from './model.ts';
import type { ClientRemote, ConfigFormScope, FormSnapshot, StoredConfig } from './types.ts';

export function useFormSnapshot(scope: ConfigFormScope): FormSnapshot {
  return useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot());
}

export interface BridgeState {
  readonly data?: BridgeStateView;
  readonly error?: string;
  readonly loading: boolean;
  readonly refreshing: boolean;
  /** Re-read now; `force` also bypasses the Host's Session cache. */
  refresh(force?: boolean): void;
}

/** Poll the Host state route while the page is visible. */
export function useBridgeState(intervalMs = 5000): BridgeState {
  const [data, setData] = useState<BridgeStateView>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const tick = useRef<(force: boolean) => void>(() => {});

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let inflight = false;
    async function load(force: boolean): Promise<void> {
      if (inflight || (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      inflight = true;
      if (force) setRefreshing(true);
      try {
        const next = await fetchState(force, controller.signal);
        if (!active) return;
        setData(next);
        setError(undefined);
      } catch (cause) {
        if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inflight = false;
        if (active) { setLoading(false); setRefreshing(false); }
      }
    }
    tick.current = force => { void load(force); };
    void load(true);
    const timer = setInterval(() => { void load(false); }, intervalMs);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [intervalMs]);

  const refresh = useCallback((force = true) => tick.current(force), []);
  return { data, error, loading, refreshing, refresh };
}

export interface SecretStatus {
  readonly configured: boolean;
  readonly known: boolean;
  refresh(): void;
}

/** Whether the credential reference holds a value; never reads the value itself. */
export function useSecretStatus(remote: ClientRemote | undefined, ref: string): SecretStatus {
  const [configured, setConfigured] = useState(false);
  const [known, setKnown] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    let active = true;
    describeCredential(remote?.credentials, ref)
      .then(info => { if (active) { setConfigured(Boolean(info?.configured)); setKnown(info !== undefined); } })
      .catch(() => { if (active) { setConfigured(false); setKnown(false); } });
    return () => { active = false; };
  }, [remote, ref, version]);

  useEffect(() => remote?.$on?.('credentials/reference-updated', updated => {
    if (updated === ref) refresh();
  }), [remote, ref, refresh]);

  return { configured, known, refresh };
}

export interface StoreApply {
  /** Key of the edit in flight; empty when idle. */
  readonly busy: string;
  /** Why the last edit failed; cleared by the next one. */
  readonly error?: string;
  /**
   * Apply one immediate group/member edit. Resolves to the Host's answer (the
   * fresh table, plus the id of a group it created) or undefined on failure.
   */
  apply(key: string, ops: readonly StoreOp[]): Promise<StoreResponse | undefined>;
  dismiss(): void;
}

/**
 * Apply one immediate edit.
 *
 * Groups, refused senders and notes are Host state, not part of the Config
 * form, so an edit is already in effect when the request returns. Nothing
 * confirms it: the table the page re-reads *is* the confirmation, and a notice
 * that stays on screen after the fact only gets in the way. A failure is the
 * exception — it is shown in place until the next attempt.
 */
export function useStoreApply(onChanged: () => void): StoreApply {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string>();

  const apply = useCallback(async (key: string, ops: readonly StoreOp[]): Promise<StoreResponse | undefined> => {
    setBusy(key);
    setError(undefined);
    try {
      const response = await postStore(ops);
      onChanged();
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    } finally {
      setBusy('');
    }
  }, [onChanged]);

  const dismiss = useCallback(() => setError(undefined), []);
  return { busy, error, apply, dismiss };
}

export interface StoreSettingsSave {
  readonly saving: boolean;
  /** Why the last write failed; cleared by the next attempt. */
  readonly error?: string;
  /** True for a moment after a successful write. */
  readonly saved: boolean;
  /** Write one settings patch; false when the Host refused it. */
  save(patch: StoreSettingsPatch): Promise<boolean>;
}

/**
 * Save one card's slice of the plugin's own settings block.
 *
 * Same ergonomics as {@link useConfigSave} — a 保存 / 放弃 bar and a 已保存
 * indicator — but a different write channel and therefore a different failure
 * model. There is nothing to rebase and no revision to lose: the store route
 * merges the patch field by field into the plugin's document, so a write only
 * ever states the fields this card changed, and two cards editing at once cannot
 * overwrite each other's. The one authority is the store itself, and the page
 * picks the result up on its next state read — which the caller's `onSaved`
 * forces.
 */
export function useStoreSettingsSave(onSaved: () => void): StoreSettingsSave {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const save = useCallback(async (patch: StoreSettingsPatch): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    if (timer.current) clearTimeout(timer.current);
    try {
      await postStore([setSettings(patch)]);
      setSaved(true);
      timer.current = setTimeout(() => setSaved(false), 2000);
      onSaved();
      return true;
    } catch (cause) {
      // The Host validates the same values and answers in Chinese; its message
      // is what the operator needs to read, so it is shown as it arrived.
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, [onSaved]);

  return { saving, error, saved, save };
}

export interface ConfigSave {
  readonly saving: boolean;
  /** Why the last save failed; cleared by the next attempt. */
  readonly error?: string;
  /** True for a moment after a successful write. */
  readonly saved: boolean;
  /** Write one section's fields; false when the write failed. */
  save(patch: Partial<StoredConfig>): Promise<boolean>;
}

/**
 * Save one card's slice of the plugin Config.
 *
 * Every section writes only its own fields, diffed against the *newest* stored
 * revision, so two cards can be dirty at once without overwriting each other.
 * A revision conflict means something else wrote the namespace (another
 * window, the raw Config editor): re-read and rebase the same diff.
 */
export function useConfigSave(scope: ConfigFormScope, onSaved: () => void): ConfigSave {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const save = useCallback(async (patch: Partial<StoredConfig>): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    if (timer.current) clearTimeout(timer.current);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = scope.getSnapshot();
        const stored = storedFrom(latest.value);
        const ops = changedOperations({ ...stored, ...patch }, stored);
        if (!ops.length) break;
        if (await scope.mutate(ops, latest.revision)) break;
        if (attempt === 2) throw new Error('配置已在别处被修改，请刷新页面后重试。');
      }
      setSaved(true);
      timer.current = setTimeout(() => setSaved(false), 2000);
      onSaved();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, [scope, onSaved]);

  return { saving, error, saved, save };
}
