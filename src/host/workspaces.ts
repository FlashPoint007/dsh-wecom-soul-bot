import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  PLUGIN_WORKSPACE_DIRECTORY, PLUGIN_WORKSPACE_TITLE, type WorkspaceOption,
} from '../shared/protocol.js';
import { normalizePath } from './config.js';
import type { WorkspaceRegistry } from './dsh.js';

/**
 * The Workspace every new WeCom Session is created in.
 *
 * By default the plugin owns one Workspace of its own, created on demand at
 * `<DSH home>/wecom-soul-bot/workspace` and registered with the DSH Workspace
 * registry, so the Sessions show up in the sidebar like any other. A
 * configured `defaultWorkspace` replaces it; that directory must already
 * exist, and it is registered with the registry on first use.
 *
 * Registration is what makes `sessionController.create({ workspaceId })`
 * and the sidebar grouping work; when this deployment mounts no registry the
 * service still resolves a plain directory and Sessions are created with an
 * explicit `cwd` instead.
 */

export interface WorkspaceRef {
  /** Registry id; empty when this deployment has no Workspace registry. */
  readonly id: string;
  /** Canonical absolute directory. */
  readonly path: string;
  readonly title: string;
  readonly pluginOwned: boolean;
  /** False when the directory is usable but not registered as a Workspace. */
  readonly registered: boolean;
}

export interface WorkspaceService {
  /** The plugin's own Workspace directory (not created by this call). */
  defaultPath(): string;
  /** Register-and-return the Workspace for a configured path; `''` is the plugin default. */
  resolve(path: string): Promise<WorkspaceRef>;
  /** Inspect a configured path without creating or registering anything. */
  describe(path: string): Promise<WorkspaceRef>;
  /** Every registered Workspace, in sidebar order. */
  list(): readonly WorkspaceOption[];
  /** Drop cached resolutions (the registry may have changed underneath us). */
  invalidate(): void;
}

export interface WorkspaceServiceOptions {
  registry(): WorkspaceRegistry | undefined;
  readonly defaultPath: string;
  readonly log?: { warn(message: string): void };
}

export function createWorkspaceService(options: WorkspaceServiceOptions): WorkspaceService {
  const cache = new Map<string, WorkspaceRef>();

  function registry(): WorkspaceRegistry | undefined {
    const found = options.registry();
    return found && typeof found.create === 'function' ? found : undefined;
  }

  /** Registered entity whose canonical path matches, if any. */
  function registered(ref: { path: string }): WorkspaceRef | undefined {
    const target = normalizePath(ref.path);
    for (const workspace of registry()?.list() ?? []) {
      if (normalizePath(workspace.path) === target) {
        return {
          id: String(workspace.id), path: workspace.path, title: workspace.title,
          pluginOwned: normalizePath(workspace.path) === normalizePath(options.defaultPath),
          registered: true,
        };
      }
    }
    return undefined;
  }

  async function existingDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  async function canonical(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      return normalizePath(path);
    }
  }

  function owned(path: string): boolean {
    return normalizePath(path) === normalizePath(options.defaultPath);
  }

  return {
    defaultPath: () => options.defaultPath,
    async resolve(path) {
      const configured = normalizePath(path);
      const pluginOwned = !configured;
      const target = configured || options.defaultPath;
      const cached = cache.get(target);
      if (cached) return cached;
      if (pluginOwned) {
        // The plugin owns this directory: it may not exist yet.
        try {
          await mkdir(target, { recursive: true, mode: 0o700 });
        } catch (error) {
          throw new Error(`默认 Workspace 目录创建失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (!(await existingDirectory(target))) {
        throw new Error(`Workspace 目录不存在或不是目录：${target}`);
      }
      const canonicalPath = await canonical(target);
      const already = registered({ path: canonicalPath });
      if (already) {
        const ref: WorkspaceRef = { ...already, pluginOwned };
        cache.set(target, ref);
        return ref;
      }
      const found = registry();
      if (!found) {
        const ref: WorkspaceRef = {
          id: '', path: canonicalPath, title: pluginOwned ? PLUGIN_WORKSPACE_TITLE : basename(canonicalPath),
          pluginOwned, registered: false,
        };
        cache.set(target, ref);
        return ref;
      }
      try {
        const workspace = await found.create(canonicalPath, pluginOwned ? PLUGIN_WORKSPACE_TITLE : undefined);
        const ref: WorkspaceRef = {
          id: String(workspace.id), path: workspace.path, title: workspace.title,
          pluginOwned, registered: true,
        };
        cache.set(target, ref);
        return ref;
      } catch (error) {
        throw new Error(`Workspace 注册失败（${canonicalPath}）：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async describe(path) {
      const configured = normalizePath(path);
      const target = configured || options.defaultPath;
      const cached = cache.get(target);
      if (cached) return cached;
      const already = registered({ path: target });
      if (already) {
        const ref: WorkspaceRef = { ...already, pluginOwned: !configured || already.pluginOwned };
        cache.set(target, ref);
        return ref;
      }
      const canonicalPath = await canonical(target);
      if (canonicalPath !== target) {
        const byCanonical = registered({ path: canonicalPath });
        if (byCanonical) {
          const ref: WorkspaceRef = { ...byCanonical, pluginOwned: !configured || byCanonical.pluginOwned };
          cache.set(target, ref);
          return ref;
        }
      }
      if (!(await existingDirectory(canonicalPath))) {
        if (!configured) {
          // The plugin's own directory is created lazily; describe it as-is.
          return { id: '', path: canonicalPath, title: PLUGIN_WORKSPACE_TITLE, pluginOwned: true, registered: false };
        }
        throw new Error(`Workspace 目录不存在或不是目录：${target}`);
      }
      return {
        id: '', path: canonicalPath,
        title: configured && basename(canonicalPath) ? basename(canonicalPath) : PLUGIN_WORKSPACE_TITLE,
        pluginOwned: !configured, registered: false,
      };
    },
    list() {
      const found = registry();
      if (!found) return [];
      // Archived Sessions keep their Workspace assignment but can never
      // notify anybody, so the page counts and shows only live ones.
      const archived = new Set(found.archivedSessionIds ?? []);
      return found.list().map(workspace => {
        const active = workspace.sessionIds.filter(id => !archived.has(id));
        return {
          id: String(workspace.id),
          path: workspace.path,
          title: workspace.title,
          pluginOwned: owned(workspace.path),
          sessionCount: active.length,
          archivedSessionCount: workspace.sessionIds.length - active.length,
        };
      });
    },
    invalidate() { cache.clear(); },
  };
}

/** Directory of the plugin's own Workspace below a plugin home directory. */
export function pluginWorkspacePath(pluginHome: string): string {
  return join(pluginHome, PLUGIN_WORKSPACE_DIRECTORY);
}
