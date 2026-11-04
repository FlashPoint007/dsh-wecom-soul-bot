import type { AgentPresetOption, PresetCatalogView } from '../shared/protocol.js';
import type { AgentPresetRegistry } from './dsh.js';

/**
 * The agent presets DSH offers, for the group form and the Session rows.
 *
 * A preset decides the tool schemas and prompt sections a Session's model
 * sees, and DSH only lets it be chosen while the Session is still blank — so a
 * group's preset applies to Sessions it creates from now on, never to one that
 * has already had a turn.
 *
 * Reading the roster is a local call, but it re-resolves the default preset
 * every time; the snapshot is therefore cached briefly like the model catalog.
 */

export interface PresetService {
  /** Last read roster, or undefined before the first successful read. */
  snapshot(): PresetCatalogView | undefined;
  /** Read the roster, cached for `ttlMs` unless `refresh` is set. */
  load(options?: { readonly refresh?: boolean }): Promise<PresetCatalogView>;
  /** Whether a group's preset exists in the last read roster. */
  known(id: string): boolean;
}

export interface PresetServiceOptions {
  /** `ctx.get('agentPresets')`: absent in deployments without the registry. */
  registry(): AgentPresetRegistry | undefined;
  readonly ttlMs?: number;
  now?(): number;
}

function usable(value: unknown): AgentPresetRegistry | undefined {
  const registry = value as AgentPresetRegistry | undefined;
  return registry && typeof registry.list === 'function' ? registry : undefined;
}

export function createPresetService(options: PresetServiceOptions): PresetService {
  const ttl = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let cached: { readonly view: PresetCatalogView; readonly at: number } | undefined;
  let inflight: Promise<PresetCatalogView> | undefined;

  async function fetchRoster(): Promise<PresetCatalogView> {
    const registry = usable(options.registry());
    // No preset registry: every Session follows whatever DSH composes by itself,
    // so a group's preset stays empty and the form offers no choice.
    if (!registry) return { presets: [], fetchedAt: now() };
    const rows = await registry.list();
    // `list()` carries no default flag; `resolve()` without an id answers the
    // preset a new Session would be composed with.
    const defaultId = await registry.resolve().then(row => row.id).catch(() => '');
    const presets: AgentPresetOption[] = rows.map(row => ({
      id: row.id,
      ...(row.name ? { name: row.name } : {}),
      ...(row.description ? { description: row.description } : {}),
      isDefault: row.id === defaultId,
      ...(row.broken ? { broken: row.broken } : {}),
    }));
    return { presets, fetchedAt: now() };
  }

  return {
    snapshot: () => cached?.view,
    load(loadOptions = {}) {
      if (!loadOptions.refresh && cached && now() - cached.at < ttl) return Promise.resolve(cached.view);
      inflight ??= fetchRoster()
        .then(view => { cached = { view, at: now() }; return view; })
        .finally(() => { inflight = undefined; });
      return inflight;
    },
    known(id) {
      const view = cached?.view;
      // An unread roster cannot call a configured preset wrong, and a deployment
      // without the registry does not judge preset ids at all.
      if (!view || !view.presets.length) return true;
      return view.presets.some(preset => preset.id === id);
    },
  };
}
