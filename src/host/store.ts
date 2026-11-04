import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME, DEFAULT_LOG_RETENTION_DAYS, DEFAULT_PERMISSION_MODE,
  DEFAULT_QUESTION_TIMEOUT_MS, isPermissionMode,
  MAX_BINDINGS, MAX_GROUPS, MAX_LABEL_CHARS, MAX_LOG_RETENTION_DAYS, MAX_QUESTION_TIMEOUT_MS,
  MIN_LOG_RETENTION_DAYS, MIN_QUESTION_TIMEOUT_MS, STORE_FILE, STORE_VERSION,
  type BindingKind, type BindingRecord, type GroupRecord, type GroupSessionMemory, type ModelSelection, type PermissionMode,
  type StoreSettings, type StoreSettingsPatch,
} from '../shared/protocol.js';
import { uniqueIds } from './config.js';

/**
 * The plugin's own durable document: `<DSH home>/wecom-soul-bot/settings.json`.
 *
 * It holds everything the operator edits except the connection identity, which
 * stays in the plugin Config because a DSH profile declares it and the credential
 * service resolves it:
 *
 *   - the settings block: administrators, the notification scope, the WebSocket
 *     endpoint, the question timeout, remote approvals and the journal;
 *   - the user groups (each owning a Workspace, a model, an agent preset and its
 *     Workspace access — read-only unless the operator grants more);
 *   - the members assigned to them — one row authorizes one WeCom principal, by
 *     userid for a private chat or by chatid for a group, and records the DSH
 *     Session that principal talks to;
 *   - the operator notes (备注), keyed by person rather than by membership, so a
 *     note survives being moved between groups, being removed, and belonging to
 *     no group at all (an administrator);
 *   - each administrator's own preference: the Workspace their `/sessions` and
 *     `/new` commands default to, written by the Bot itself.
 *
 * Everything here is written through this one module — the settings page posts
 * ops, and the Bot writes its own preferences — so a write is serialized and
 * atomic (write-then-rename, `0600`). None of it is Config: an edit must never
 * rewrite the DSH profile document or rebuild the bridge, because adding an
 * administrator must not drop the WeCom socket while somebody is talking to the
 * Bot.
 *
 * There is deliberately no migration path from an earlier layout: the plugin has
 * no deployment on one, a file of another version is set aside instead of being
 * half-read, and describing the current version is the whole job.
 */

export interface BindingKeyParts {
  readonly chat: string;
  readonly user: string;
  readonly chatType: 'single' | 'group';
}

export interface GroupPatch {
  readonly name?: string;
  readonly workspace?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly preset?: string;
  readonly permission?: PermissionMode;
}

export interface BindingPatch {
  readonly groupId?: string;
  readonly sessionId?: string;
  /** Model override is tied to the current Session and cleared on replacement. */
  readonly sessionSelection?: ModelSelection;
}

export interface PluginStore {
  /** Read the file once; safe to call repeatedly and concurrently. */
  load(): Promise<void>;
  /**
   * The settings block. Defaults until `load()` finishes; every caller that acts
   * on it (the runtime, the page) loads the store first.
   */
  settings(): StoreSettings;
  /** Merge one settings edit; omitted fields keep their stored value. */
  setSettings(patch: StoreSettingsPatch): Promise<StoreSettings>;
  groups(): readonly GroupRecord[];
  group(id: string): GroupRecord | undefined;
  bindings(): readonly BindingRecord[];
  get(key: string): BindingRecord | undefined;
  /** Members of one group, newest activity last. */
  inGroup(groupId: string): readonly BindingRecord[];
  createGroup(name?: string): Promise<GroupRecord>;
  updateGroup(id: string, patch: GroupPatch): Promise<GroupRecord | undefined>;
  /** Deletes a group and every membership in it; the default group is refused. */
  removeGroup(id: string): Promise<{ readonly ok: boolean; readonly removed: number }>;
  /** Authorize a principal (or re-assign an existing one) into a group. */
  create(kind: BindingKind, id: string, options: { readonly groupId: string; readonly label?: string }): Promise<BindingRecord>;
  /**
   * Patch a member; changing its group always detaches its Session.
   * `expected`, when supplied, must be the exact current row returned by this
   * store. A replaced or removed row refuses the write (undefined), including
   * remove/re-authorize and move-away/move-back races with identical timestamps.
   */
  update(key: string, patch: BindingPatch, expected?: BindingRecord): Promise<BindingRecord | undefined>;
  remove(key: string): Promise<boolean>;
  /** The operator note for one principal, whether or not it is a member. */
  label(key: string): string;
  /** Set (or clear) one principal's note; survives membership changes. */
  setLabel(key: string, label: string): Promise<string>;
  /** The Workspace one administrator's commands default to; empty means all. */
  adminWorkspace(user: string): string;
  /** Point one administrator's commands at one Workspace ('' clears it). */
  setAdminWorkspace(user: string, path: string): Promise<void>;
  /** Drop one principal's remembered Session for one group (a stale candidate). */
  forgetSession(key: string, groupId: string): Promise<void>;
  /** Every member currently pointing at one Session. */
  forSession(sessionId: string): readonly BindingRecord[];
  /** True when no new member may be created. */
  full(): boolean;
  flush(): Promise<void>;
  /** Absolute path of the backing file. */
  readonly file: string;
}

export interface PluginStoreOptions {
  readonly directory: string;
  readonly maxEntries?: number;
  readonly maxGroups?: number;
  now?(): number;
  onError?(error: unknown, stage: string): void;
}

interface StoredFile {
  readonly version?: unknown;
  readonly settings?: unknown;
  readonly groups?: unknown;
  readonly bindings?: unknown;
  readonly labels?: unknown;
  /** Per-administrator preferences, keyed by userid; see {@link AdminDefaults}. */
  readonly adminDefaults?: unknown;
}

/**
 * One administrator's preferences. An object rather than a bare path so a
 * second preference can join `workspace` later without changing the file
 * shape again.
 */
export interface AdminDefaults {
  readonly workspace: string;
}

/** `user:<userid>` for private chats, `group:<chatid>` for groups. */
export function bindingKey(kind: BindingKind, id: string): string {
  return `${kind}:${id}`;
}

export function bindingKeyFor(parts: BindingKeyParts): string {
  return parts.chatType === 'group' ? bindingKey('group', parts.chat) : bindingKey('user', parts.user);
}

export function parseBindingKey(key: string): { readonly kind: BindingKind; readonly id: string } | undefined {
  const match = /^(user|group):(.+)$/.exec(key.trim());
  if (!match) return undefined;
  return { kind: match[1] as BindingKind, id: match[2]! };
}

/** Bounded, control-character-free WeCom identifier. */
export function validBindingId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** One-line operator note, bounded and free of control characters. */
export function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const squashed = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (/[\u0000-\u001f\u007f-\u009f]/.test(squashed)) return '';
  return squashed.slice(0, MAX_LABEL_CHARS);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** A settings block with every default in place. */
export function defaultStoreSettings(): StoreSettings {
  return {
    wsUrl: '',
    adminUserIds: [],
    adminWorkspaces: [],
    questionTimeoutMs: DEFAULT_QUESTION_TIMEOUT_MS,
    remoteApprovals: true,
    logEnabled: true,
    logRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
  };
}

/**
 * The settings block, re-typed from untrusted content.
 *
 * The operator can edit this file by hand — and `settings.set` patches arrive
 * over HTTP — so every field is coerced and clamped rather than rejected, and a
 * nonsense value falls back to its default. Whether a `wsUrl` is *usable* is the
 * runtime's judgement, not this one's: an unusable endpoint has to surface as a
 * connection state, not as a setting that quietly did nothing.
 */
export function normalizeStoreSettings(value: unknown): StoreSettings {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    wsUrl: text(record.wsUrl),
    adminUserIds: uniqueIds(asArray(record.adminUserIds)),
    adminWorkspaces: uniqueIds(asArray(record.adminWorkspaces)),
    questionTimeoutMs: bounded(
      record.questionTimeoutMs, MIN_QUESTION_TIMEOUT_MS, MAX_QUESTION_TIMEOUT_MS, DEFAULT_QUESTION_TIMEOUT_MS,
    ),
    // Kept on disk for compatibility only; approval is always available to scoped admins.
    remoteApprovals: true,
    logEnabled: record.logEnabled !== false,
    logRetentionDays: bounded(
      record.logRetentionDays, MIN_LOG_RETENTION_DAYS, MAX_LOG_RETENTION_DAYS, DEFAULT_LOG_RETENTION_DAYS,
    ),
  };
}

/**
 * The Workspace stored in one `adminDefaults` entry. Only the object form is
 * read: this layout was never released any other way, and a bare string is
 * exactly the shape a future reader would have to guess about.
 */
function adminDefaultsWorkspace(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return text((value as Record<string, unknown>).workspace);
}

function stamp(value: unknown): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function normalizeGroup(value: unknown): GroupRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = text(record.id);
  if (!id || id.length > 64) return undefined;
  const name = normalizeLabel(record.name) || DEFAULT_GROUP_NAME;
  return {
    id,
    name,
    workspace: text(record.workspace),
    provider: text(record.provider),
    model: text(record.model),
    reasoningEffort: text(record.reasoningEffort),
    preset: text(record.preset),
    // A missing or unknown value is the safe one, never "whatever DSH defaults to".
    permission: isPermissionMode(record.permission) ? record.permission : DEFAULT_PERMISSION_MODE,
    createdAt: stamp(record.createdAt),
    updatedAt: stamp(record.updatedAt),
  };
}

function normalizeSelection(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = text(record.provider).slice(0, 512);
  const model = text(record.model).slice(0, 512);
  const reasoningEffort = text(record.reasoningEffort).slice(0, 128);
  return provider && model ? { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } : undefined;
}

/** One stored member row, or undefined when the entry is unusable. */
function normalizeBinding(value: unknown): BindingRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind === 'group' ? 'group' : record.kind === 'user' ? 'user' : undefined;
  if (!kind || !validBindingId(record.id)) return undefined;
  const sessionId = text(record.sessionId);
  const sessionSelection = sessionId ? normalizeSelection(record.sessionSelection) : undefined;
  const memories: [string, GroupSessionMemory][] = [];
  if (record.sessionsByGroup && typeof record.sessionsByGroup === 'object' && !Array.isArray(record.sessionsByGroup)) {
    for (const [groupId, entry] of Object.entries(record.sessionsByGroup).slice(0, MAX_GROUPS)) {
      if (!groupId || groupId.length > 64 || !entry || typeof entry !== 'object') continue;
      const memory = entry as Record<string, unknown>;
      const rememberedId = text(memory.sessionId);
      if (!rememberedId || rememberedId.length > 512 || typeof memory.workspace !== 'string') continue;
      const selection = normalizeSelection(memory.selection);
      memories.push([groupId, { sessionId: rememberedId, workspace: text(memory.workspace), ...(selection ? { selection } : {}) }]);
    }
  }
  return {
    kind,
    id: (record.id as string).trim(),
    groupId: text(record.groupId) || DEFAULT_GROUP_ID,
    sessionId,
    ...(sessionSelection ? { sessionSelection } : {}),
    ...(memories.length ? { sessionsByGroup: Object.fromEntries(memories) } : {}),
    createdAt: stamp(record.createdAt),
    updatedAt: stamp(record.updatedAt),
  };
}

export function createStore(options: PluginStoreOptions): PluginStore {
  const file = join(options.directory, STORE_FILE);
  const max = options.maxEntries ?? MAX_BINDINGS;
  const maxGroups = options.maxGroups ?? MAX_GROUPS;
  const now = options.now ?? Date.now;
  const report = (error: unknown, stage: string) => { try { options.onError?.(error, stage); } catch { /* reporting must never throw */ } };
  const groups = new Map<string, GroupRecord>();
  const bindings = new Map<string, BindingRecord>();
  /** Notes by principal key (`user:<id>` / `group:<id>`), members or not. */
  const labels = new Map<string, string>();
  /** Per-administrator default Workspace, keyed by userid. */
  const adminWorkspaces = new Map<string, string>();
  let settings: StoreSettings = defaultStoreSettings();
  let loaded: Promise<void> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let dropped = false;

  function defaultGroup(): GroupRecord {
    const existing = groups.get(DEFAULT_GROUP_ID);
    if (existing) return existing;
    const at = now();
    const created: GroupRecord = {
      id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, workspace: '',
      provider: '', model: '', reasoningEffort: '', preset: '', permission: DEFAULT_PERMISSION_MODE,
      createdAt: at, updatedAt: at,
    };
    groups.set(DEFAULT_GROUP_ID, created);
    return created;
  }

  function loadOnce(): Promise<void> {
    loaded ??= readFileOnce();
    return loaded;
  }

  /** Move an unreadable file aside so the next write cannot destroy it. */
  async function setAside(suffix: string): Promise<void> {
    await rename(file, `${file}.${suffix}`).catch(cause => report(cause, 'quarantine'));
  }

  async function readFileOnce(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') report(error, 'read');
      defaultGroup();
      return;
    }
    let parsed: StoredFile;
    try {
      parsed = JSON.parse(raw) as StoredFile;
    } catch (error) {
      report(error, 'parse');
      await setAside('corrupt');
      defaultGroup();
      return;
    }
    const version = typeof parsed.version === 'number' || typeof parsed.version === 'string'
      ? String(parsed.version)
      : '';
    if (version !== STORE_VERSION || !Array.isArray(parsed.bindings)) {
      // Every earlier layout is gone by design (the plugin has no deployment on
      // one), so this is a read error, not something to migrate.
      report(new Error(`store file version ${version || '(missing)'} is not ${STORE_VERSION}`), 'version');
      // The version is untrusted file content: never let it choose a path.
      await setAside(`v${version.replace(/[^0-9A-Za-z.-]/g, '_').slice(0, 24) || 'unknown'}`);
      defaultGroup();
      return;
    }
    settings = normalizeStoreSettings(parsed.settings);
    if (Array.isArray(parsed.groups)) {
      for (const entry of parsed.groups) {
        const group = normalizeGroup(entry);
        if (!group || groups.has(group.id)) continue;
        groups.set(group.id, group);
      }
    }
    defaultGroup();
    for (const [key, value] of Object.entries((parsed.labels ?? {}) as Record<string, unknown>)) {
      const note = normalizeLabel(value);
      if (!note || !parseBindingKey(key)) continue;
      labels.set(key, note);
    }
    for (const [user, value] of Object.entries((parsed.adminDefaults ?? {}) as Record<string, unknown>)) {
      const path = adminDefaultsWorkspace(value);
      if (path && validBindingId(user)) adminWorkspaces.set(user, path);
    }
    for (const entry of parsed.bindings) {
      const record = normalizeBinding(entry);
      if (!record) continue;
      if (!bindings.has(bindingKey(record.kind, record.id))) bindings.set(bindingKey(record.kind, record.id), record);
    }
    // A member must never reference a group that is not there.
    for (const [key, record] of bindings) {
      const { sessionsByGroup, ...base } = record;
      const memories = Object.entries(sessionsByGroup ?? {}).filter(([id, memory]) =>
        id !== record.groupId && groups.has(id) && groups.get(id)!.workspace === memory.workspace);
      bindings.set(key, {
        ...base,
        ...(!groups.has(record.groupId) ? { groupId: DEFAULT_GROUP_ID } : {}),
        ...(memories.length ? { sessionsByGroup: Object.fromEntries(memories) } : {}),
      });
    }
  }

  function persist(): Promise<void> {
    const payload = JSON.stringify({
      version: STORE_VERSION,
      savedAt: new Date(now()).toISOString(),
      settings,
      groups: [...groups.values()],
      bindings: [...bindings.values()],
      labels: Object.fromEntries(labels),
      adminDefaults: Object.fromEntries(
        [...adminWorkspaces].map(([user, workspace]): [string, AdminDefaults] => [user, { workspace }]),
      ),
    }, undefined, 2);
    chain = chain.then(async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, file);
      } catch (error) {
        report(error, 'write');
      }
    });
    return chain;
  }

  function putBinding(record: BindingRecord): BindingRecord {
    bindings.set(bindingKey(record.kind, record.id), record);
    void persist();
    return record;
  }

  function putGroup(record: GroupRecord): GroupRecord {
    groups.set(record.id, record);
    void persist();
    return record;
  }

  async function writeLabel(key: string, value: string): Promise<string> {
    const note = normalizeLabel(value);
    if (note) labels.set(key, note);
    else labels.delete(key);
    await persist();
    return note;
  }

  /** Replace the row even on A→B→A: stale asynchronous work must fail its CAS. */
  function patchBinding(existing: BindingRecord, groupId: string, patch: BindingPatch): BindingRecord {
    const { sessionSelection: _selection, sessionsByGroup: _history, ...base } = existing;
    const memories: Record<string, GroupSessionMemory> = { ...existing.sessionsByGroup };
    let sessionId = existing.sessionId;
    let selection = existing.sessionSelection;
    if (groupId !== existing.groupId) {
      if (existing.sessionId) {
        memories[existing.groupId] = {
          sessionId: existing.sessionId, workspace: groups.get(existing.groupId)?.workspace ?? '',
          ...(existing.sessionSelection ? { selection: existing.sessionSelection } : {}),
        };
      }
      const memory = Object.hasOwn(memories, groupId) ? memories[groupId] : undefined;
      const reusable = memory && memory.workspace === groups.get(groupId)?.workspace;
      sessionId = reusable ? memory.sessionId : '';
      selection = reusable ? memory.selection : undefined;
      delete memories[groupId];
    } else if (patch.sessionId !== undefined) {
      sessionId = patch.sessionId.trim();
      if (sessionId !== existing.sessionId || !sessionId) selection = undefined;
      delete memories[groupId];
    }
    if (groupId === existing.groupId && sessionId && patch.sessionSelection) {
      selection = normalizeSelection(patch.sessionSelection);
    }
    return {
      ...base, groupId, sessionId,
      ...(selection ? { sessionSelection: selection } : {}),
      ...(Object.keys(memories).length ? { sessionsByGroup: memories } : {}),
      updatedAt: now(),
    };
  }

  function forgetGroupHistory(groupId: string): void {
    for (const [key, binding] of bindings) {
      if (!binding.sessionsByGroup || !Object.hasOwn(binding.sessionsByGroup, groupId)) continue;
      const { sessionsByGroup, ...base } = binding;
      const remaining = { ...sessionsByGroup };
      delete remaining[groupId];
      bindings.set(key, { ...base, ...(Object.keys(remaining).length ? { sessionsByGroup: remaining } : {}) });
    }
  }

  return {
    file,
    async load() {
      await loadOnce();
    },
    settings: () => settings,
    async setSettings(patch) {
      await loadOnce();
      // Merge only the fields the caller sent: one patch never clears the rest.
      const merged: Record<string, unknown> = { ...settings };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) merged[key] = value;
      }
      settings = normalizeStoreSettings(merged);
      await persist();
      return settings;
    },
    groups: () => [...groups.values()],
    group: id => groups.get(id),
    bindings: () => [...bindings.values()],
    get: key => bindings.get(key),
    inGroup: groupId => [...bindings.values()].filter(record => record.groupId === groupId),
    async createGroup(name) {
      await loadOnce();
      if (groups.size >= maxGroups) throw new Error(`group limit reached (${maxGroups})`);
      const at = now();
      const label = normalizeLabel(name) || `分组 ${groups.size}`;
      const id = `g${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      return putGroup({
        id, name: label, workspace: '', provider: '', model: '', reasoningEffort: '', preset: '',
        permission: DEFAULT_PERMISSION_MODE, createdAt: at, updatedAt: at,
      });
    },
    async updateGroup(id, patch) {
      await loadOnce();
      const existing = groups.get(id);
      if (!existing) return undefined;
      const name = patch.name === undefined ? existing.name : normalizeLabel(patch.name);
      const next: GroupRecord = {
        ...existing,
        name: name || existing.name,
        ...(patch.workspace !== undefined ? { workspace: patch.workspace.trim() } : {}),
        ...(patch.provider !== undefined ? { provider: patch.provider.trim() } : {}),
        ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
        ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort.trim() } : {}),
        ...(patch.preset !== undefined ? { preset: patch.preset.trim() } : {}),
        ...(patch.permission !== undefined && isPermissionMode(patch.permission) ? { permission: patch.permission } : {}),
        updatedAt: now(),
      };
      if (next.workspace !== existing.workspace) forgetGroupHistory(id);
      return putGroup(next);
    },
    async removeGroup(id) {
      await loadOnce();
      if (id === DEFAULT_GROUP_ID || !groups.has(id)) return { ok: false, removed: 0 };
      let removed = 0;
      for (const [key, record] of [...bindings]) {
        if (record.groupId !== id) continue;
        bindings.delete(key);
        removed++;
      }
      groups.delete(id);
      forgetGroupHistory(id);
      await persist();
      return { ok: true, removed };
    },
    async create(kind, id, createOptions) {
      await loadOnce();
      const cleanId = id.trim();
      const key = bindingKey(kind, cleanId);
      const label = normalizeLabel(createOptions.label);
      // A note typed while authorizing is the person's note from now on. Read
      // the membership after this await so a concurrent edit is not overwritten
      // with a snapshot from before the note was persisted.
      if (label) await writeLabel(key, label);
      const groupId = groups.has(createOptions.groupId) ? createOptions.groupId : DEFAULT_GROUP_ID;
      const existing = bindings.get(key);
      if (existing) {
        return putBinding(patchBinding(existing, groupId, {}));
      }
      if (bindings.size >= max) {
        if (!dropped) {
          dropped = true;
          report(new Error(`refusing to create more than ${max} members`), 'limit');
        }
        throw new Error(`member limit reached (${max})`);
      }
      const at = now();
      return putBinding({ kind, id: cleanId, groupId, sessionId: '', createdAt: at, updatedAt: at });
    },
    async update(key, patch, expected) {
      await loadOnce();
      const existing = bindings.get(key);
      if (!existing || (expected !== undefined && existing !== expected)) return undefined;
      const groupId = patch.groupId !== undefined && groups.has(patch.groupId) ? patch.groupId : existing.groupId;
      // A group move ignores caller-supplied Session ids; only its own remembered
      // Session is a candidate. The routing layer checks existence before use.
      return putBinding(patchBinding(existing, groupId, patch));
    },
    async remove(key) {
      await loadOnce();
      const existed = bindings.delete(key);
      if (existed) await persist();
      return existed;
    },
    label: key => labels.get(key) ?? '',
    async setLabel(key, value) {
      await loadOnce();
      return await writeLabel(key, value);
    },
    async forgetSession(key, groupId) {
      await loadOnce();
      const binding = bindings.get(key);
      if (!binding?.sessionsByGroup || !Object.hasOwn(binding.sessionsByGroup, groupId)) return;
      const { sessionsByGroup, ...base } = binding;
      const remaining = { ...sessionsByGroup };
      delete remaining[groupId];
      bindings.set(key, { ...base, ...(Object.keys(remaining).length ? { sessionsByGroup: remaining } : {}) });
      await persist();
    },
    adminWorkspace: user => adminWorkspaces.get(user) ?? '',
    async setAdminWorkspace(user, path) {
      await loadOnce();
      const clean = path.trim();
      if (clean) adminWorkspaces.set(user, clean);
      else adminWorkspaces.delete(user);
      await persist();
    },
    forSession: sessionId => [...bindings.values()].filter(record => record.sessionId && record.sessionId === sessionId),
    full: () => bindings.size >= max,
    flush: () => chain,
  };
}
