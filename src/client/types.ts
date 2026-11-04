/** Browser-side contracts of the DSH services this page uses. */

/**
 * Stored Host Config (see src/host/config.ts): the connection identity, and
 * only that. Everything else the operator edits lives in the plugin's own
 * document and arrives as {@link BridgeStateView.settings}.
 */
export interface StoredConfig {
  readonly botId: string;
  readonly secretEnv: string;
}

export interface FormSnapshot {
  readonly status: string;
  readonly revision: number;
  readonly writable?: boolean;
  readonly value?: Partial<StoredConfig>;
}

export type FormOperation =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] };

export interface ConfigFormScope {
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  /** Atomic write of `ops` based on `revision`; false on conflict or refusal. */
  mutate(ops: readonly FormOperation[], revision: number): Promise<boolean>;
}

export interface ConfigForms {
  get(namespace: string): ConfigFormScope;
  whileServed(namespaces: readonly string[], register: () => () => void): () => void;
}

export interface CredentialInfo {
  readonly configured: boolean;
  readonly writable?: boolean;
}

/** Remote calls may answer either bare values or `{ ok, value | error }` envelopes. */
export interface RemoteEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly message?: string };
}

export interface CredentialsRemote {
  describe(refs: readonly string[]): Promise<Record<string, CredentialInfo> | RemoteEnvelope<Record<string, CredentialInfo>>>;
  set(ref: string, value: string): Promise<void | RemoteEnvelope<unknown>>;
}

export interface ClientRemote {
  readonly credentials?: CredentialsRemote;
  $on?(event: string, listener: (...args: unknown[]) => void): () => void;
}

export interface SlotProps {
  readonly view: 'summary' | 'page' | string;
}

export interface SlotRegistry {
  register(options: { readonly name: string; readonly key: string }, component: (props: SlotProps) => unknown): () => void;
  inject(name: string, register: () => () => void): () => void;
}

/** The only face used from the installed uiWorkspace Client navigation service. */
export interface SessionNavigation {
  openSession(sessionId: string): void;
}

export type OpenSession = (sessionId: string) => void | Promise<void>;

export interface ClientContext {
  get(name: string): unknown;
  effect(setup: () => () => void, label?: string): unknown;
}
