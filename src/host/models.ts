import type { ModelCatalogView, ModelChoice, ModelSelection } from '../shared/protocol.js';
import type { AgentDefaultModel, ModelCatalog, SessionController } from './dsh.js';

/**
 * The provider/model choices DSH offers, and the one place a Session-local
 * model is installed.
 *
 * DSH has no "set the model of one Session" call that leaves the deployment
 * default alone: `sessionController.selectModel` also saves the selection as
 * the default model in the background. The plugin therefore restores the
 * previous default right after selecting, so configuring a model for WeCom
 * Sessions never silently changes what the DSH GUI starts new Sessions with.
 */

export interface ModelService {
  /** Last read catalog, or undefined before the first successful read. */
  snapshot(): ModelCatalogView | undefined;
  /** Read the catalog, cached for `ttlMs` unless `refresh` is set. */
  load(options?: { readonly refresh?: boolean }): Promise<ModelCatalogView>;
  /** Install one Session-local model selection. */
  select(sessionId: string, selection: ModelSelection): Promise<ModelSelection>;
  /** The deployment default model, when the service is available. */
  deploymentDefault(): ModelSelection | undefined;
  /** Whether a configured selection exists in the last read catalog. */
  known(selection: ModelSelection): boolean;
}

export interface ModelServiceOptions {
  readonly sessionController: Pick<SessionController, 'modelCatalog' | 'selectModel'>;
  readonly defaults?: () => AgentDefaultModel | undefined;
  readonly ttlMs?: number;
  now?(): number;
  readonly log?: { warn(message: string): void };
}

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '');
}

function toView(catalog: ModelCatalog, fetchedAt: number): ModelCatalogView {
  const choices: ModelChoice[] = [];
  for (const group of catalog.groups) {
    for (const model of group.models) {
      choices.push({
        provider: group.id, providerName: group.name,
        model: model.id, name: model.name || model.id,
        ...(model.reasoning
          ? {
            efforts: model.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })),
            ...(model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
          }
          : {}),
      });
    }
  }
  return {
    choices,
    dshDefault: {
      provider: catalog.default.provider,
      model: catalog.default.model,
      ...(catalog.default.reasoningEffort === undefined ? {} : { reasoningEffort: String(catalog.default.reasoningEffort) }),
    },
    failures: catalog.failures.map(failure => ({ id: failure.id, name: failure.name, message: failure.message })),
    fetchedAt,
  };
}

export function createModelService(options: ModelServiceOptions): ModelService {
  const ttl = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? { warn() {} };
  let cached: { readonly view: ModelCatalogView; readonly at: number } | undefined;
  let inflight: Promise<ModelCatalogView> | undefined;

  async function fetchCatalog(): Promise<ModelCatalogView> {
    const catalog = await options.sessionController.modelCatalog();
    const view = toView(catalog, now());
    cached = { view, at: now() };
    return view;
  }

  function deploymentDefault(): ModelSelection | undefined {
    const model = options.defaults?.();
    if (!model) return undefined;
    try {
      const current = model.currentSelection();
      return {
        provider: current.provider,
        model: current.model,
        ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) }),
      };
    } catch {
      return undefined;
    }
  }

  return {
    snapshot: () => cached?.view,
    load(loadOptions = {}) {
      if (!loadOptions.refresh && cached && now() - cached.at < ttl) return Promise.resolve(cached.view);
      inflight ??= fetchCatalog().finally(() => { inflight = undefined; });
      return inflight;
    },
    deploymentDefault,
    known(selection) {
      const view = cached?.view;
      if (!view) return true; // no catalog read yet: do not call a configured model wrong
      return view.choices.some(choice => choice.provider === selection.provider && choice.model === selection.model);
    },
    async select(sessionId, selection) {
      const request = {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
      const previous = deploymentDefault();
      const result = await options.sessionController.selectModel(request);
      const selected: ModelSelection = {
        provider: result.selected.provider,
        model: result.selected.model,
        ...(result.selected.reasoningEffort === undefined ? {} : { reasoningEffort: String(result.selected.reasoningEffort) }),
      };
      // `selectModel` saves the deployment default in the background; put the
      // operator's own default back unless they picked exactly this model.
      if (previous && !sameSelection(previous, selected)) {
        const defaults = options.defaults?.();
        if (defaults) {
          try {
            await defaults.saveSelection(previous);
          } catch (error) {
            log.warn(`WeCom could not restore the DSH default model: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return selected;
    },
  };
}
