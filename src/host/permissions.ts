import {
  PERMISSION_MODES,
  type PermissionCatalogView, type PermissionMode,
} from '../shared/protocol.js';
import type { HostContext, SessionController } from './dsh.js';

/**
 * Workspace access (DSH's permission presets) for the Sessions the Bot owns.
 *
 * DSH bundles a sandbox mode with an approval policy as a named preset —
 * `read-only`, `workspace-write`, `danger-full-access` — and keeps the current
 * one in the Session's own log (`permission/preset`, `sandbox/mode`,
 * `approval/policy`). A new Session starts with the deployment default, which
 * is `workspace-write`: wider than a remote chat should get unasked. So the Bot
 * sets the group's mode on every Session it creates, and sets it again on the
 * Sessions it already owns when the operator changes the group.
 *
 * The write goes through `ctx.permissionPresets.set(session, name)` — the same
 * path DSH's own `/permission` command takes — against the exact live Session
 * object; a cold Session is resumed first. Nothing is stored here: the Session
 * is the authority, and the page reads it back from the `permissions` projection.
 */

/** `ctx.permissionPresets`: the slice of DSH's permission-preset service used here. */
export interface PermissionPresetService {
  catalog(): { readonly options: readonly { readonly value: string }[] };
  set(session: never, name: string): void;
}

interface SessionStore {
  get(id: string): unknown;
}

export interface PermissionService {
  /** Whether the deployment can apply a mode at all, and which modes DSH offers. */
  catalog(): PermissionCatalogView;
  /** Put one Session under `mode`; throws when it cannot be applied. */
  apply(sessionId: string, mode: PermissionMode): Promise<void>;
}

export interface PermissionServiceOptions {
  readonly ctx: Pick<HostContext, 'get'>;
  readonly sessionController: Pick<SessionController, 'resolveAgent'>;
  readonly journal?: { write(record: Record<string, unknown>): void };
}

function usable(value: unknown): PermissionPresetService | undefined {
  const service = value as PermissionPresetService | undefined;
  return service && typeof service.set === 'function' && typeof service.catalog === 'function' ? service : undefined;
}

export function createPermissionService(options: PermissionServiceOptions): PermissionService {
  const journal = options.journal ?? { write() {} };
  const service = () => usable(options.ctx.get?.('permissionPresets'));
  const sessions = () => options.ctx.get?.('sessions') as SessionStore | undefined;

  function catalog(): PermissionCatalogView {
    const presets = service();
    if (!presets) return { available: false, modes: [] };
    try {
      const offered = new Set(presets.catalog().options.map(option => option.value));
      return { available: true, modes: PERMISSION_MODES.filter(mode => offered.has(mode)) };
    } catch {
      return { available: false, modes: [] };
    }
  }

  async function liveSession(sessionId: string): Promise<unknown> {
    const live = sessions()?.get?.(sessionId);
    if (live) return live;
    // A cold Session has no live object until DSH resumes its Agent.
    const resolved = await options.sessionController.resolveAgent(sessionId);
    if ('error' in resolved) throw new Error(resolved.error.message || `无法读取会话（${resolved.error.code}）`);
    return sessions()?.get?.(sessionId) ?? (resolved.agent as { session?: unknown }).session;
  }

  return {
    catalog,
    async apply(sessionId, mode) {
      const presets = service();
      if (!presets) throw new Error('当前 DSH 没有权限模式服务，无法设置工作区权限。');
      if (!catalog().modes.includes(mode)) throw new Error(`DSH 当前没有「${mode}」权限模式。`);
      const session = await liveSession(sessionId);
      if (!session) throw new Error('找不到这个会话的运行状态，请稍后重试。');
      try {
        presets.set(session as never, mode);
      } catch (error) {
        journal.write({ event: 'dsh.session.permission', level: 'warn', sessionId, mode, error });
        throw new Error(`无法设置工作区权限：${error instanceof Error ? error.message : String(error)}`);
      }
      journal.write({ event: 'dsh.session.permission', sessionId, mode });
    },
  };
}
