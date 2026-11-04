import type {
  BindingSessionState, BindingRecord, ContextUsage, GroupRecord, ModelSelection, PermissionMode,
} from '../shared/protocol.js';
import type { CatalogService, SessionCatalog } from './catalog.js';
import type { SessionController } from './dsh.js';
import type { ModelService } from './models.js';
import type { PermissionService } from './permissions.js';
import { sessionTitleFor, type SessionTitler } from './session-title.js';
import type { PluginStore } from './store.js';
import type { WorkspaceService } from './workspaces.js';

/**
 * Session provisioning: turn a membership into a real DSH Session.
 *
 * A member without a Session id gets one the first time a message is routed
 * to it — created in its group's Workspace with the group's agent preset, and,
 * when the group configures a model, with that model installed as the
 * Session-local selection. Later messages reuse the bound Session; only a
 * Session that DSH reports as archived, subagent-owned or gone is replaced,
 * and the replacement is persisted before the prompt is submitted.
 *
 * The group's Workspace access is applied to the Session before it is bound, and
 * a Session whose access cannot be set is never handed to the member: DSH starts
 * Sessions with write access, so a failure here would otherwise leave a Session
 * wider than the group allows.
 *
 * The preset is a creation fact: DSH refuses to re-compose a Session that has
 * already had a turn, so changing a group's preset affects Sessions it creates
 * from then on, never one it already owns.
 */

export interface SessionDescription {
  readonly title: string | null;
  readonly state: BindingSessionState;
  /** Workspace title, as the DSH sidebar shows it. */
  readonly workspace: string;
  /** Workspace directory; empty when DSH reported none. */
  readonly workspacePath: string;
  readonly running: boolean;
  readonly model?: ModelSelection;
  readonly preset?: string;
  /** Permission preset the Session runs under, when reported. */
  readonly permission?: string;
  readonly context?: ContextUsage;
  /** Latest turn number, when the Session's projections report one. */
  readonly turns?: number;
  /** Steps the Session has entered, when reported. */
  readonly steps?: number;
}

export interface Provisioned {
  readonly sessionId: string;
  /** Exact store row this Session was resolved for; callers can re-check it. */
  readonly binding: BindingRecord;
  /** True when this call created the Session. */
  readonly created: boolean;
  readonly model?: ModelSelection;
}

/** Provisioning must not resurrect or route a membership edited mid-flight. */
export class SessionBindingChangedError extends Error {
  constructor() {
    super('membership changed while resolving its Session');
    this.name = 'SessionBindingChangedError';
  }
}

export interface SessionProvisioner {
  /** The Session a member must use; creates and persists one when needed. */
  ensure(binding: BindingRecord, group: GroupRecord): Promise<Provisioned>;
  /** Install a Session-local model now (group model edits, session switches). */
  applyModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection>;
  /** Put one Session under a Workspace access mode now; throws when DSH cannot apply it. */
  applyPermission(sessionId: string, mode: PermissionMode): Promise<void>;
  describe(sessionId: string): Promise<SessionDescription>;
  /** The model a group configures, or undefined for "leave it to DSH". */
  desired(group: GroupRecord): ModelSelection | undefined;
}

export interface SessionProvisionerOptions {
  readonly sessionController: Pick<SessionController, 'create' | 'selectModel'>;
  readonly models: ModelService;
  /** Workspace access of new Sessions; without it (or without DSH's service) none is set. */
  readonly permissions?: PermissionService;
  readonly workspaces: WorkspaceService;
  readonly catalogs: CatalogService;
  readonly bindings: Pick<PluginStore, 'get' | 'update'>;
  readonly bindingKey: (binding: BindingRecord) => string;
  /** Names a Session this provisioner creates; optional and best-effort. */
  readonly titles?: SessionTitler;
  /** How long a "missing Session" verdict is trusted before rebuilding the catalog. */
  readonly rebuildIntervalMs?: number;
  now?(): number;
  readonly journal?: { write(record: Record<string, unknown>): void };
  readonly log?: { warn(message: string): void };
}

/** The model configured on one group, or undefined when it follows DSH. */
export function desiredSelection(group: GroupRecord): ModelSelection | undefined {
  const provider = group.provider.trim();
  const model = group.model.trim();
  if (!provider || !model) return undefined;
  const reasoningEffort = group.reasoningEffort.trim();
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export function modelKey(selection: ModelSelection | undefined): string {
  return selection ? `${selection.provider}/${selection.model}${selection.reasoningEffort ? `#${selection.reasoningEffort}` : ''}` : '';
}

export function createSessionProvisioner(options: SessionProvisionerOptions): SessionProvisioner {
  const journal = options.journal ?? { write() {} };
  const log = options.log ?? { warn() {} };
  const now = options.now ?? Date.now;
  const applied = new Map<string, string>();
  /** Last forced catalog rebuild per Session: a missing Session stays missing,
   * so re-reading the whole DSH list on every settings-page poll would be
   * wasted work. One rebuild per window is enough to notice a new Session. */
  const rebuilt = new Map<string, number>();
  const REBUILD_INTERVAL_MS = options.rebuildIntervalMs ?? 30_000;

  async function freshCatalog(sessionId: string): Promise<SessionCatalog> {
    const last = rebuilt.get(sessionId) ?? 0;
    if (now() - last < REBUILD_INTERVAL_MS) return await options.catalogs.load();
    rebuilt.set(sessionId, now());
    return await options.catalogs.load({ force: true });
  }

  /** How usable a bound Session id currently is, per the DSH catalog. */
  async function classify(sessionId: string): Promise<BindingSessionState> {
    const reason = (catalog: SessionCatalog): BindingSessionState | undefined => {
      const hidden = catalog.hiddenReason(sessionId);
      if (hidden === undefined) return 'bound';
      if (hidden === 'blank') return 'blank'; // created, never prompted: still ours
      if (hidden === 'archived') return 'archived';
      if (hidden === 'subagent') return 'unusable';
      return undefined; // missing: refresh once below
    };
    try {
      const first = reason(await options.catalogs.load());
      if (first) return first;
      const second = reason(await freshCatalog(sessionId));
      return second ?? 'missing';
    } catch {
      // The catalog is unavailable: trust the stored id and let the prompt decide.
      return 'bound';
    }
  }

  async function install(sessionId: string, selection: ModelSelection, force: boolean): Promise<ModelSelection | undefined> {
    const key = modelKey(selection);
    if (!force && applied.get(sessionId) === key) return undefined;
    const selected = await options.models.select(sessionId, selection);
    applied.set(sessionId, modelKey(selected));
    return selected;
  }

  return {
    desired: desiredSelection,
    async ensure(binding, group) {
      const key = options.bindingKey(binding);
      const assertCurrent = (expected: BindingRecord) => {
        if (options.bindings.get(key) !== expected) throw new SessionBindingChangedError();
      };
      assertCurrent(binding);
      if (binding.groupId !== group.id) throw new SessionBindingChangedError();
      const selection = desiredSelection(group);
      if (binding.sessionId) {
        const state = await classify(binding.sessionId);
        assertCurrent(binding);
        if (state === 'bound' || state === 'blank') {
          // An explicit model change takes effect with the next message.
          const currentSelection = binding.sessionSelection ?? selection;
          const model = currentSelection ? await install(binding.sessionId, currentSelection, false).catch(error => {
            log.warn(`WeCom could not select the Session model: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          }) : undefined;
          assertCurrent(binding);
          return { sessionId: binding.sessionId, binding, created: false, ...(model ? { model } : {}) };
        }
        journal.write({
          event: 'binding.session.replaced', level: 'warn',
          binding: options.bindingKey(binding), sessionId: binding.sessionId, state,
        });
      }
      const workspace = await options.workspaces.resolve(group.workspace);
      assertCurrent(binding);
      const preset = group.preset.trim();
      const created = await options.sessionController.create({
        ...(workspace.id ? { workspaceId: workspace.id } : { cwd: workspace.path }),
        ...(preset ? { agentPreset: preset } : {}),
      });
      // Workspace access first: until it is set the Session has DSH's default
      // (write access), and nothing may be bound to it in that state.
      if (options.permissions?.catalog().available) {
        await options.permissions.apply(created.sessionId, group.permission);
        assertCurrent(binding);
      } else {
        journal.write({ event: 'dsh.session.permission', level: 'warn', sessionId: created.sessionId, mode: group.permission, outcome: 'unavailable' });
      }
      // The operator may have moved, removed or rebound this member while DSH
      // was creating the Session. The store checks this at the mutation itself,
      // after its own awaits; a pre-write get() check alone is not sufficient.
      const updated = await options.bindings.update(key, { sessionId: created.sessionId }, binding);
      if (!updated) throw new SessionBindingChangedError();
      assertCurrent(updated);
      // The Session is named after the principal that owns it — a userid for a
      // private chat, a chatid for a group — so the DSH sidebar says which WeCom
      // conversation it belongs to.
      options.titles?.name(created.sessionId, sessionTitleFor(binding.id));
      journal.write({
        event: 'binding.session.created', binding: options.bindingKey(binding),
        sessionId: created.sessionId, workspace: workspace.path, workspaceId: workspace.id,
        group: group.id, model: selection ?? null, preset: preset || null, permission: group.permission,
      });
      let model: ModelSelection | undefined;
      if (selection) {
        try {
          model = await install(created.sessionId, selection, true);
        } catch (error) {
          log.warn(`WeCom could not select the Session model: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      assertCurrent(updated);
      return { sessionId: created.sessionId, binding: updated, created: true, ...(model ? { model } : {}) };
    },
    async applyModel(sessionId, selection) {
      return await install(sessionId, selection, true) ?? selection;
    },
    async applyPermission(sessionId, mode) {
      if (!options.permissions) throw new Error('当前 DSH 没有权限模式服务，无法设置工作区权限。');
      await options.permissions.apply(sessionId, mode);
    },
    async describe(sessionId) {
      try {
        const catalog = await options.catalogs.load();
        const fresh = catalog.get(sessionId) || catalog.getBlank?.(sessionId) ? catalog : await freshCatalog(sessionId);
        const entry = fresh.get(sessionId) ?? fresh.getBlank?.(sessionId);
        if (entry) {
          return {
            title: entry.title,
            state: fresh.hiddenReason(sessionId) === 'blank' ? 'blank' : 'bound',
            workspace: entry.group.title,
            workspacePath: entry.group.path ?? '',
            running: entry.running,
            ...(entry.model ? { model: entry.model } : {}),
            ...(entry.preset ? { preset: entry.preset } : {}),
            ...(entry.permission ? { permission: entry.permission } : {}),
            ...(entry.context ? { context: entry.context } : {}),
            ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
            ...(entry.steps !== undefined ? { steps: entry.steps } : {}),
          };
        }
        const hidden = catalog.hiddenReason(sessionId);
        return {
          title: catalog.titleOf(sessionId),
          state: hidden === undefined ? 'missing' : hidden === 'subagent' ? 'unusable' : hidden,
          workspace: '', workspacePath: '', running: false,
        };
      } catch {
        return { title: null, state: 'missing', workspace: '', workspacePath: '', running: false };
      }
    },
  };
}
