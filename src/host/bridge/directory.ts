import type { CatalogEntry, CatalogService, SessionCatalog } from '../catalog.js';
import type { ContextUsage, HiddenSelection, ModelSelection } from '../../shared/protocol.js';

/**
 * The Sessions an *administrator* may operate: the visible DSH catalog (no
 * archived, subagent or blank Sessions) filtered by the administrator's
 * Workspace scope. Ordinary users never consult this module — they are
 * always routed to the Session their own binding owns.
 *
 * When the catalog cannot be read, an explicitly requested Session stays
 * operable so a transient DSH read failure does not block an administrator
 * who already switched to it.
 */

export interface OperableSession {
  readonly sessionId: string;
  readonly title: string | null;
  readonly workspace: string;
  readonly workspacePath: string;
  readonly groupKey: string;
  readonly running: boolean;
  readonly pinned: boolean;
  readonly model?: ModelSelection;
}

export interface OperableGroup {
  readonly title: string;
  readonly sessions: readonly OperableSession[];
}

export type ResolveResult =
  | { readonly ok: true; readonly session: OperableSession }
  | { readonly ok: false; readonly reason: 'not-found' | 'ambiguous' | 'forbidden' | 'unavailable'; readonly hidden?: HiddenSelection['reason'] };

export interface SessionDescription {
  readonly title: string | null;
  readonly workspace?: string;
  readonly workspacePath?: string;
  readonly running?: boolean;
  readonly model?: ModelSelection;
  readonly preset?: string;
  readonly context?: ContextUsage;
  readonly turns?: number;
  readonly steps?: number;
}

export interface SessionDirectory {
  /** Grouped by Workspace in DSH sidebar order; one Workspace when filtered. */
  groups(filter?: { readonly workspacePath?: string }): Promise<readonly OperableGroup[]>;
  /** `token`: 1-based index into `listing`, a full Session id, or a unique id prefix (≥ 6 chars). */
  resolve(token: string, listing?: readonly string[]): Promise<ResolveResult>;
  permitted(sessionId: string): Promise<boolean>;
  describe(sessionId: string): Promise<SessionDescription>;
}

export interface SessionDirectoryOptions {
  /** Whether an administrator scope covers this catalog entry's Workspace. */
  allow(entry: CatalogEntry): boolean;
}

export function createSessionDirectory(catalogs: CatalogService, options: SessionDirectoryOptions): SessionDirectory {
  function operable(catalog: SessionCatalog): OperableSession[] {
    return catalog.entries
      .filter(entry => options.allow(entry))
      .map(entry => ({
        sessionId: entry.sessionId, title: entry.title, workspace: entry.group.title,
        workspacePath: entry.group.path ?? '', groupKey: entry.group.key,
        running: entry.running, pinned: entry.pinned,
        ...(entry.model ? { model: entry.model } : {}),
      }));
  }

  async function lookup(sessionId: string): Promise<SessionCatalog> {
    const catalog = await catalogs.load();
    // A Session created after the cached read is "missing", not hidden: refresh once.
    return !catalog.get(sessionId) && catalog.hiddenReason(sessionId) === 'missing'
      ? catalogs.load({ force: true })
      : catalog;
  }

  return {
    async groups(filter) {
      const result = new Map<string, { title: string; sessions: OperableSession[] }>();
      const scope = filter?.workspacePath;
      for (const session of operable(await catalogs.load({ force: true }))) {
        if (scope && session.workspacePath !== scope) continue;
        const group = result.get(session.groupKey) ?? { title: session.workspace, sessions: [] };
        group.sessions.push(session);
        result.set(session.groupKey, group);
      }
      return [...result.values()];
    },
    async resolve(token, listing) {
      const value = token.trim();
      if (!value) return { ok: false, reason: 'not-found' };
      let catalog: SessionCatalog;
      try {
        catalog = await catalogs.load({ force: true });
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      const sessions = operable(catalog);
      let candidates: OperableSession[] = [];
      if (/^\d{1,3}$/.test(value) && listing) {
        const id = listing[Number(value) - 1];
        candidates = sessions.filter(session => session.sessionId === id);
      } else {
        const exact = sessions.filter(session => session.sessionId === value);
        candidates = exact.length || value.length < 6 ? exact : sessions.filter(session => session.sessionId.startsWith(value));
      }
      if (candidates.length === 1) return { ok: true, session: candidates[0]! };
      if (candidates.length > 1) return { ok: false, reason: 'ambiguous' };
      const entry = catalog.get(value);
      if (entry && !options.allow(entry)) return { ok: false, reason: 'forbidden' };
      const hidden = catalog.hiddenReason(value);
      return { ok: false, reason: 'not-found', ...(hidden && hidden !== 'missing' ? { hidden } : {}) };
    },
    async permitted(sessionId) {
      try {
        const catalog = await lookup(sessionId);
        // A newly created Session is hidden until its first turn, not exempt
        // from scope checks. Its retained Workspace lets the same live policy
        // govern both visible and blank Sessions after a scope edit.
        const entry = catalog.get(sessionId) ?? catalog.getBlank(sessionId);
        return entry ? options.allow(entry) : false;
      } catch {
        return false;
      }
    },
    async describe(sessionId) {
      try {
        const catalog = await catalogs.load();
        const entry = catalog.get(sessionId) ?? catalog.getBlank(sessionId);
        if (!entry) return { title: catalog.titleOf(sessionId) };
        return {
          title: entry.title,
          workspace: entry.group.title,
          workspacePath: entry.group.path ?? '',
          running: entry.running,
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.preset ? { preset: entry.preset } : {}),
          ...(entry.context ? { context: entry.context } : {}),
          ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
          ...(entry.steps !== undefined ? { steps: entry.steps } : {}),
        };
      } catch {
        return { title: null };
      }
    },
  };
}
