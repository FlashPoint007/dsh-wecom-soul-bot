import { basename } from 'node:path';
import {
  isPermissionMode, PERMISSION_MODES,
  type CatalogGroup, type CatalogSession, type ContextUsage, type HiddenSelection, type ModelSelection,
  type PermissionMode, type SessionCatalogView,
} from '../shared/protocol.js';
import type { SessionSummary, WorkspaceRegistry } from './dsh.js';

/**
 * Session catalog: the DSH Session list grouped the way the DSH sidebar
 * groups it.
 *
 * - Workspaces in registry order; members from each Workspace's `sessionIds`.
 * - Sessions outside every Workspace trail in an "未分组" group.
 * - Hidden like the sidebar: archived, subagent-origin, and blank Sessions.
 * - Within a group: pinned first, then most recently prompted.
 * Without a Workspace registry the catalog falls back to grouping by cwd.
 */

export interface CatalogEntry extends CatalogSession {
  readonly group: CatalogGroup;
}

export interface SessionCatalog {
  readonly generatedAt: number;
  readonly groups: readonly CatalogGroup[];
  /** Visible Sessions in display order. */
  readonly entries: readonly CatalogEntry[];
  readonly archivedCount: number;
  /** A visible Session, or undefined when hidden or unknown. */
  get(sessionId: string): CatalogEntry | undefined;
  /** A hidden blank Session with its Workspace, for scope-checked use after creation. */
  getBlank(sessionId: string): CatalogEntry | undefined;
  /** Why a Session is not visible; undefined when it is visible. */
  hiddenReason(sessionId: string): HiddenSelection['reason'] | undefined;
  /** Stored title of any known Session, visible or not. */
  titleOf(sessionId: string): string | null;
}

export const UNGROUPED_TITLE = '未分组';
const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace';

export function workspaceDisplayTitle(title: string | undefined, path: string): string {
  const trimmed = title?.trim();
  if (trimmed === DEFAULT_WORKSPACE_DIRECTORY) return '默认工作区';
  return trimmed || basename(path) || path;
}

export function sessionTitle(summary: SessionSummary | undefined): string | null {
  const title = summary?.projections?.values?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

/**
 * The model the Session runs now, from the `modelSelection` projection.
 *
 * A model chosen but not yet used is `pending` (older builds: `next`) and wins
 * over `lastUsed`: it is what the next request will run, and it is what the
 * DSH GUI shows right after a switch.
 */
export function sessionModel(summary: SessionSummary | undefined): ModelSelection | undefined {
  const value = summary?.projections?.values?.modelSelection as
    | { readonly lastUsed?: unknown; readonly pending?: unknown; readonly next?: unknown }
    | undefined;
  const pick = (raw: unknown): ModelSelection | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const record = raw as Record<string, unknown>;
    const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!provider || !model) return undefined;
    const reasoningEffort = typeof record.reasoningEffort === 'string' ? record.reasoningEffort.trim() : '';
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  };
  return pick(value?.pending) ?? pick(value?.next) ?? pick(value?.lastUsed);
}

/** Agent preset the Session runs, from the `agentPreset` projection. */
export function sessionPreset(summary: SessionSummary | undefined): string | undefined {
  const value = summary?.projections?.values?.agentPreset;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Knob bundle of each DSH permission preset: the sandbox mode and approval policy it sets. */
const PERMISSION_BUNDLES: Readonly<Record<PermissionMode, { readonly sandbox: string; readonly approval: string }>> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
};

/**
 * The permission preset the Session runs under, from the `permissions`
 * projection: the wire view's `currentValue` when it is there, otherwise the
 * folded knobs (`preset`, `sandbox`, `approval`) matched the way DSH matches
 * them — the recorded preset while it still agrees with the knobs, else the
 * first preset whose bundle they equal, else `custom`.
 */
export function sessionPermission(summary: SessionSummary | undefined): string | undefined {
  const value = summary?.projections?.values?.permissions as Record<string, unknown> | null | undefined;
  if (!value || typeof value !== 'object') return undefined;
  const text = (raw: unknown): string => typeof raw === 'string' ? raw.trim() : '';
  const current = text(value.currentValue);
  if (current) return current;
  const sandbox = text(value.sandbox);
  const approval = text(value.approval);
  const preset = text(value.preset);
  if (!sandbox && !approval) return preset || undefined;
  const matches = (mode: PermissionMode): boolean => PERMISSION_BUNDLES[mode].sandbox === sandbox
    && PERMISSION_BUNDLES[mode].approval === (approval || 'ask');
  if (isPermissionMode(preset) && matches(preset)) return preset;
  if (preset === 'auto' && sandbox === 'danger-full-access') return 'auto';
  return PERMISSION_MODES.find(matches) ?? 'custom';
}

/** Context occupancy of the Session, from the `contextPressure` projection. */
export function sessionContext(summary: SessionSummary | undefined): ContextUsage | undefined {
  const value = summary?.projections?.values?.contextPressure;
  if (!value || typeof value !== 'object') return undefined;
  const tokens = (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : undefined;
  // `projectedTokens` follows the surface movement since the last request, so it
  // is what the *next* request will carry; it falls back to the last sample.
  const used = tokens(value.projectedTokens) ?? tokens(value.pressureTokens);
  if (used === undefined) return undefined;
  const window = tokens(value.contextWindow);
  return { used, ...(window ? { window } : {}) };
}

/**
 * How far the Session's log has come: its latest turn and its step count.
 *
 * `turnOutline` is one entry per turn (so its last entry is the latest turn the
 * log recorded — including a running one), while `sessionStats` counts entered
 * steps over the whole log. Neither is required: a Session whose events predate
 * these folds simply reports nothing.
 */
export function sessionProgress(summary: SessionSummary | undefined): { turns?: number; steps?: number } {
  const values = summary?.projections?.values;
  const outline = Array.isArray(values?.turnOutline) ? values.turnOutline as { turn?: unknown }[] : undefined;
  const last = outline && outline.length ? outline[outline.length - 1] : undefined;
  const stats = (values?.sessionStats ?? undefined) as { turns?: unknown; steps?: unknown } | undefined;
  const count = (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : undefined;
  const turns = count(last?.turn) ?? count(stats?.turns);
  const steps = count(stats?.steps);
  return { ...(turns !== undefined ? { turns } : {}), ...(steps !== undefined ? { steps } : {}) };
}

export function buildCatalog(
  items: readonly SessionSummary[], registry: WorkspaceRegistry | undefined, generatedAt = Date.now(),
): SessionCatalog {
  const byId = new Map(items.map(item => [item.sessionId, item]));
  const archived = new Set(registry?.archivedSessionIds ?? []);
  const pinned = new Set(registry?.pinnedSessionIds ?? []);

  function hiddenReason(sessionId: string): HiddenSelection['reason'] | undefined {
    const summary = byId.get(sessionId);
    if (!summary) return archived.has(sessionId) ? 'archived' : 'missing';
    if (archived.has(sessionId)) return 'archived';
    if (summary.origin === 'subagent') return 'subagent';
    if (summary.blank === true) return 'blank';
    return undefined;
  }
  const toSession = (summary: SessionSummary): CatalogSession => {
    const model = sessionModel(summary);
    const preset = sessionPreset(summary);
    const permission = sessionPermission(summary);
    const context = sessionContext(summary);
    const progress = sessionProgress(summary);
    return {
      sessionId: summary.sessionId,
      title: sessionTitle(summary),
      running: summary.running === true,
      pinned: pinned.has(summary.sessionId),
      updatedAt: summary.updatedAt ?? 0,
      ...(model ? { model } : {}),
      ...(preset ? { preset } : {}),
      ...(permission ? { permission } : {}),
      ...(context ? { context } : {}),
      ...progress,
    };
  };
  const byDisplayOrder = (a: CatalogSession, b: CatalogSession) =>
    Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt;
  const visible = (summary: SessionSummary) => hiddenReason(summary.sessionId) === undefined;

  const groups: CatalogGroup[] = [];
  // Blank Sessions stay out of the sidebar, but their Workspace must survive
  // filtering: an administrator's freshly created Session is usable only while
  // its Workspace remains in scope, just like a visible Session.
  const blankById = new Map<string, CatalogEntry>();
  function rememberGroup(group: CatalogGroup, blanks: readonly CatalogSession[]): void {
    if (group.sessions.length) groups.push(group);
    for (const blank of blanks) blankById.set(blank.sessionId, { ...blank, group });
  }
  if (registry) {
    const accounted = new Set<string>();
    for (const workspace of registry.list()) {
      const members: CatalogSession[] = [];
      const blanks: CatalogSession[] = [];
      for (const id of workspace.sessionIds) {
        const summary = byId.get(id);
        if (!summary || accounted.has(id)) continue;
        accounted.add(id);
        if (visible(summary)) members.push(toSession(summary));
        else if (hiddenReason(id) === 'blank') blanks.push(toSession(summary));
      }
      rememberGroup({
        key: String(workspace.id), kind: 'workspace',
        title: workspaceDisplayTitle(workspace.title, workspace.path), path: workspace.path,
        sessions: members.sort(byDisplayOrder),
      }, blanks);
    }
    const stray = items.filter(item => !accounted.has(item.sessionId) && visible(item)).map(toSession);
    const strayBlanks = items.filter(item => !accounted.has(item.sessionId) && hiddenReason(item.sessionId) === 'blank').map(toSession);
    rememberGroup({ key: 'ungrouped', kind: 'ungrouped', title: UNGROUPED_TITLE, sessions: stray.sort(byDisplayOrder) }, strayBlanks);
  } else {
    const directories = new Map<string, CatalogSession[]>();
    for (const item of items) {
      if (!visible(item) && hiddenReason(item.sessionId) !== 'blank') continue;
      const cwd = item.cwd ?? '';
      const list = directories.get(cwd) ?? [];
      list.push(toSession(item));
      directories.set(cwd, list);
    }
    for (const [cwd, sessions] of directories) {
      const members = sessions.filter(session => hiddenReason(session.sessionId) !== 'blank').sort(byDisplayOrder);
      const blanks = sessions.filter(session => hiddenReason(session.sessionId) === 'blank');
      rememberGroup(cwd
        ? { key: `dir:${cwd}`, kind: 'directory', title: basename(cwd) || cwd, path: cwd, sessions: members }
        : { key: 'ungrouped', kind: 'ungrouped', title: UNGROUPED_TITLE, sessions: members }, blanks);
    }
    groups.sort((a, b) => (a.kind === 'ungrouped' ? 1 : 0) - (b.kind === 'ungrouped' ? 1 : 0)
      || (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
  }

  const entries: CatalogEntry[] = groups.flatMap(group => group.sessions.map(session => ({ ...session, group })));
  const entryById = new Map(entries.map(entry => [entry.sessionId, entry]));
  return {
    generatedAt,
    groups,
    entries,
    archivedCount: items.filter(item => archived.has(item.sessionId)).length,
    get: id => entryById.get(id),
    getBlank: id => blankById.get(id),
    hiddenReason,
    titleOf: id => sessionTitle(byId.get(id)),
  };
}

export function catalogView(catalog: SessionCatalog, selectedIds: readonly string[]): SessionCatalogView {
  return {
    groups: catalog.groups,
    total: catalog.entries.length,
    archived: catalog.archivedCount,
    generatedAt: catalog.generatedAt,
    hiddenSelections: selectedIds.filter(id => !catalog.get(id)).map(id => ({
      sessionId: id, title: catalog.titleOf(id), reason: catalog.hiddenReason(id) ?? 'missing',
    })),
  };
}

export interface CatalogSource {
  list(signal: AbortSignal): Promise<readonly SessionSummary[]>;
  registry(): WorkspaceRegistry | undefined;
}

export interface CatalogService {
  /** Cached for `ttlMs`; concurrent callers share one DSH request. */
  load(options?: { readonly force?: boolean }): Promise<SessionCatalog>;
  invalidate(): void;
}

export function createCatalogService(
  source: CatalogSource, options: { readonly ttlMs?: number; readonly timeoutMs?: number; now?(): number } = {},
): CatalogService {
  const ttl = options.ttlMs ?? 3000;
  const timeout = options.timeoutMs ?? 15000;
  const now = options.now ?? Date.now;
  let cached: { readonly catalog: SessionCatalog; readonly at: number } | undefined;
  let inflight: Promise<SessionCatalog> | undefined;

  async function fetchCatalog(): Promise<SessionCatalog> {
    const items = await source.list(AbortSignal.timeout(timeout));
    const catalog = buildCatalog(items, source.registry(), now());
    cached = { catalog, at: now() };
    return catalog;
  }

  return {
    load(loadOptions = {}) {
      if (!loadOptions.force && cached && now() - cached.at < ttl) return Promise.resolve(cached.catalog);
      inflight ??= fetchCatalog().finally(() => { inflight = undefined; });
      return inflight;
    },
    invalidate() { cached = undefined; },
  };
}
