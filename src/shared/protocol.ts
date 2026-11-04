/**
 * Wire contract shared by the Host plugin and the browser settings page.
 *
 * This module holds only constants and types, so both halves can import it:
 * the Host through NodeNext (`../shared/protocol.js`) and the browser bundle
 * through esbuild (`../shared/protocol.ts`).
 */

export const PACKAGE_NAME = 'dsh-wecom-soul-bot';
/** Loader entry id from cordis.patch.yml; also the Config form namespace. */
export const CONFIG_NAMESPACE = 'wecom-soul-bot';
export const DEFAULT_SECRET_REF = 'WECOM_SOUL_BOT_SECRET';
/** Authenticated Connection Fetch route; the browser reads it document-relative. */
export const STATE_ROUTE = '/api/wecom-soul-bot/state';
/** Authenticated Connection Fetch route that applies settings/group/member edits. */
export const STORE_ROUTE = '/api/wecom-soul-bot/store';
/** Directory below the DSH home that holds this plugin's own data. */
export const PLUGIN_HOME_DIRECTORY = 'wecom-soul-bot';
/** Authenticated Connection Fetch route for the persona and memory settings. */
export const SOUL_ROUTE = '/api/wecom-soul-bot/soul';

/** Persona and memory switches, stored in `<plugin home>/soul/settings.json`. */
export interface SoulSettings {
  /** Inject the persona and sender identity into Bot-bound Sessions. */
  readonly enabled: boolean;
  /** Reply with the model's text only: no 「已提交」 receipt, no Session card, no admin copy. */
  readonly chatMode: boolean;
  /** Long-term memory section and the wecom_memory_* tools. */
  readonly memoryEnabled: boolean;
  /** Persona card (Markdown). */
  readonly persona: string;
  /** WeCom userids the persona treats as its owner; empty falls back to the administrators. */
  readonly ownerUserIds: readonly string[];
}

export type SoulSettingsPatch = Partial<SoulSettings>;

export interface SoulMemoryStats {
  readonly sharedEntries: number;
  readonly directory: string;
}

export interface SoulStateView {
  readonly settings: SoulSettings;
  /** The owners actually in effect (ownerUserIds, else the administrators). */
  readonly effectiveOwners: readonly string[];
  readonly ownersFromAdmins: boolean;
  readonly memory: SoulMemoryStats;
}

export type SoulResponse =
  | { readonly ok: true; readonly state: SoulStateView }
  | { readonly ok: false; readonly error: string };
/** The plugin's own Workspace directory, below {@link PLUGIN_HOME_DIRECTORY}. */
export const PLUGIN_WORKSPACE_DIRECTORY = 'workspace';
/** Sidebar title of the plugin's own Workspace. */
export const PLUGIN_WORKSPACE_TITLE = '企业微信';
/**
 * Persisted plugin store version (`settings.json`). The layout is named after
 * the release line it belongs to (`0.5`) instead of counting every edit, so the
 * number in the file only moves when a new minor line changes the layout. A file
 * of any other version is set aside instead of migrated — the plugin has no
 * deployment on an earlier one, and a silent upgrader is exactly the kind of
 * code that cannot be tested after the fact.
 */
export const STORE_VERSION = '0.5';
/** The plugin's own document: settings, groups, memberships and notes. */
export const STORE_FILE = 'settings.json';
/** Upper bound on persisted members across all groups. */
export const MAX_BINDINGS = 500;
/** Upper bound on user groups. */
export const MAX_GROUPS = 20;
/** The built-in group that owns the plugin's default Workspace and model. */
export const DEFAULT_GROUP_ID = 'default';
export const DEFAULT_GROUP_NAME = '默认分组';
/** Longest accepted 备注 / group name, in characters. */
export const MAX_LABEL_CHARS = 60;
/** Bounds the page and the Host both enforce on the store's settings block. */
export const MIN_QUESTION_TIMEOUT_MS = 1000;
export const MAX_QUESTION_TIMEOUT_MS = 300000;
export const DEFAULT_QUESTION_TIMEOUT_MS = 60000;
export const MIN_LOG_RETENTION_DAYS = 1;
export const MAX_LOG_RETENTION_DAYS = 365;
export const DEFAULT_LOG_RETENTION_DAYS = 14;

/**
 * How far a Session may reach into the Workspace — DSH's own permission
 * presets (the sandbox mode they bundle), under the names DSH's Session picker
 * shows: `read-only` 仅可查看, `workspace-write` 工作区内修改,
 * `danger-full-access` 完全权限 (Full access).
 */
export const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
/** What a group starts with: a remote chat must be granted writes, never inherit them. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'read-only';
/** The one mode that needs an explicit risk acknowledgement, as in DSH. */
export const FULL_ACCESS_MODE: PermissionMode = 'danger-full-access';

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export type ConnectionPhase =
  | 'unconfigured' // Bot ID or Secret missing
  | 'invalid' // configuration rejected before connecting
  | 'connecting'
  | 'online' // authenticated; proactive messages can be sent
  | 'reconnecting'
  | 'offline'
  | 'displaced' // another connection took over this Bot
  | 'error';

export interface ConnectionStatus {
  readonly phase: ConnectionPhase;
  /** Epoch ms of the last phase change. */
  readonly since: number;
  /** Short, already-redacted explanation. */
  readonly detail?: string;
}

export interface TrafficStats {
  /** Epoch ms when these counters started (Host start). */
  readonly since: number;
  readonly received: number;
  readonly rejected: number;
  readonly prompts: number;
  readonly notifications: number;
  readonly failures: number;
  readonly lastMessageAt?: number;
}

/** Why the Bot did not answer a sender. Authorization is group membership. */
export type RejectionReason = 'unauthorized';

export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** How full a Session's context window is, as DSH's `contextPressure` fold sees it. */
export interface ContextUsage {
  /** Prompt-side tokens the next request will carry. */
  readonly used: number;
  /** The model's context window, when DSH reported one. */
  readonly window?: number;
}

export interface CatalogSession {
  readonly sessionId: string;
  /** Stored DSH title; null for an unnamed Session. */
  readonly title: string | null;
  readonly running: boolean;
  readonly pinned: boolean;
  readonly updatedAt: number;
  /** Model of the Session's latest request, when DSH reports one. */
  readonly model?: ModelSelection;
  /** Agent preset the Session runs, when DSH reports one. */
  readonly preset?: string;
  /** Permission preset the Session runs under (`custom`, `auto` possible), when DSH reports one. */
  readonly permission?: string;
  readonly context?: ContextUsage;
  /** Latest turn number the Session log shows, when DSH reports one. */
  readonly turns?: number;
  /** Steps the Session has entered, when DSH reports one. */
  readonly steps?: number;
}

export interface CatalogGroup {
  /** Workspace id, `dir:<path>`, or `ungrouped`. */
  readonly key: string;
  readonly kind: 'workspace' | 'directory' | 'ungrouped';
  readonly title: string;
  readonly path?: string;
  readonly sessions: readonly CatalogSession[];
}

/** A Session id that the catalog does not show as an operable Session. */
export interface HiddenSelection {
  readonly sessionId: string;
  readonly title: string | null;
  /** `blank`: never prompted; DSH may reuse such a Session for "New Session". */
  readonly reason: 'archived' | 'subagent' | 'blank' | 'missing';
}

export interface SessionCatalogView {
  readonly groups: readonly CatalogGroup[];
  readonly total: number;
  /** Number of archived Sessions omitted from groups. */
  readonly archived: number;
  readonly generatedAt: number;
  readonly hiddenSelections: readonly HiddenSelection[];
}

export interface JournalInfo {
  readonly enabled: boolean;
  /** Absolute directory of the JSONL files. */
  readonly directory: string;
  /** Absolute path of today's file. */
  readonly file: string;
  readonly retentionDays: number;
}

/* ------------------------------------------------------------------ *
 * The store's settings block: everything the operator edits, minus   *
 * the connection identity (which stays in the plugin Config)         *
 * ------------------------------------------------------------------ */

/**
 * The operator-owned settings the plugin keeps in its own document, next to the
 * groups and memberships.
 *
 * Only the connection identity (`botId` and the Secret reference) lives in the
 * plugin Config, because that is what a DSH profile declares and what the
 * credential service resolves. Everything else lives here, and editing it never
 * rebuilds the bridge: adding an administrator or re-scoping notifications must
 * not drop the WeCom socket. Changing {@link StoreSettings.wsUrl} is the one
 * exception — it is half of the connection, so the bridge reconnects.
 */
export interface StoreSettings {
  /** Custom WebSocket endpoint; empty means the SDK default. Only `wss://`. */
  readonly wsUrl: string;
  /** Administrators: switch Sessions, receive approvals, reach every notice. */
  readonly adminUserIds: readonly string[];
  /** Workspaces an administrator's notices cover; empty means every one. */
  readonly adminWorkspaces: readonly string[];
  /** Legacy serialized value; DSH and WeCom now handle interactions concurrently. */
  readonly questionTimeoutMs: number;
  /** Legacy serialized value; scoped administrator approvals are always enabled. */
  readonly remoteApprovals: boolean;
  /** Whether the JSONL conversation journal is written. */
  readonly logEnabled: boolean;
  readonly logRetentionDays: number;
}

/** One settings edit; omitted fields keep their stored value. */
export type StoreSettingsPatch = Partial<StoreSettings>;

/* ------------------------------------------------------------------ *
 * Groups and members: one group owns Workspace+model, members route   *
 * ------------------------------------------------------------------ */

export type BindingKind = 'user' | 'group';

/**
 * A user group: the unit that owns a Workspace, a model and an agent preset.
 * The built-in {@link DEFAULT_GROUP_ID} group cannot be deleted and owns the
 * plugin's own Workspace unless it is pointed elsewhere.
 */
export interface GroupRecord {
  readonly id: string;
  readonly name: string;
  /** Workspace path; empty means the plugin's own Workspace. */
  readonly workspace: string;
  /** Model for every Session in this group; empty means the DSH default. */
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
  /** Agent preset for Sessions created in this group; empty means the DSH default. */
  readonly preset: string;
  /** Workspace access for every Session in this group. */
  readonly permission: PermissionMode;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A principal's previous Session in one group; never shared across principals. */
export interface GroupSessionMemory {
  readonly sessionId: string;
  /** Configured Workspace when remembered; a Workspace edit invalidates it. */
  readonly workspace: string;
  readonly selection?: ModelSelection;
}

/** One authorized WeCom principal: its group membership and its Session. */
export interface BindingRecord {
  readonly kind: BindingKind;
  /** userid for a private chat, chatid for a group. */
  readonly id: string;
  /** Membership: the group that decides Workspace and model. */
  readonly groupId: string;
  /** Bound Session id; empty means "create one on the next message". */
  readonly sessionId: string;
  /** Explicit model for this Session only; replacements use group defaults. */
  readonly sessionSelection?: ModelSelection;
  /** At most one remembered Session per existing group, scoped to this principal. */
  readonly sessionsByGroup?: Readonly<Record<string, GroupSessionMemory>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Why a bound Session cannot be used as-is. */
export type BindingSessionState = 'bound' | 'auto' | 'blank' | 'missing' | 'archived' | 'unusable';

/** One member row inside a group card. */
export interface GroupMemberView {
  /** `user:<userid>` or `group:<chatid>`. */
  readonly key: string;
  readonly kind: BindingKind;
  readonly id: string;
  /** Operator note for this person; empty when unnamed. */
  readonly label: string;
  /** What the page shows: the note when set, the WeCom id otherwise. */
  readonly displayName: string;
  /** The sender is in the plugin's administrator list. */
  readonly admin: boolean;
  /** Configured Session id; empty means "create on the next message". */
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly sessionState: BindingSessionState;
  readonly sessionRunning: boolean;
  /** Model of the Session's latest request, when DSH reports one. */
  readonly sessionModel?: ModelSelection;
  /** Configured model for the next request, including a per-Session override. */
  readonly sessionSelection?: ModelSelection;
  /** Agent preset the bound Session runs, when DSH reports one. */
  readonly sessionPreset?: string;
  /** Permission preset the bound Session runs under right now, when DSH reports one. */
  readonly sessionPermission?: string;
  /** Context occupancy of the bound Session, when DSH reports one. */
  readonly sessionContext?: ContextUsage;
  readonly messages: number;
  readonly lastSeenAt?: number;
  readonly createdAt: number;
}

/** One group card: its Workspace/model/preset plus its members. */
export interface GroupView {
  readonly id: string;
  readonly name: string;
  /** The built-in group: always present, never deletable. */
  readonly isDefault: boolean;
  /** Configured Workspace path; empty means the plugin's own Workspace. */
  readonly workspace: string;
  readonly workspaceTitle: string;
  /** Effective absolute path; empty when unresolved. */
  readonly workspacePath: string;
  readonly workspaceError?: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  /** Agent preset new Sessions in this group start with; empty means the DSH default. */
  readonly preset: string;
  /** Workspace access every Session in this group runs with. */
  readonly permission: PermissionMode;
  /** Model a new Session in this group would use. */
  readonly effectiveProvider: string;
  readonly effectiveModel: string;
  readonly effectiveReasoningEffort?: string;
  readonly members: readonly GroupMemberView[];
  readonly memberCount: number;
  readonly messages: number;
  readonly lastSeenAt?: number;
}

/** One refused sender as the memory-only observation log knows it. */
export interface RejectedObservation {
  /** `user:<userid>` or `group:<chatid>`. */
  readonly key: string;
  readonly kind: BindingKind;
  readonly id: string;
  readonly chatType: 'single' | 'group';
  /** Latest rejected message, one line and length-bounded. */
  readonly text?: string;
  readonly messages: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

/**
 * A sender the Bot refused: it belongs to no group, so it was never answered.
 * Kept in memory only — the operator turns one into a member by assigning it
 * to a group, which is what authorizes it.
 */
export interface RejectedSenderView extends RejectedObservation {
  /** Operator note, when this person was known before being refused. */
  readonly label: string;
  /** The note when set, the WeCom id otherwise. */
  readonly displayName: string;
}

export interface RoutingView {
  readonly groups: readonly GroupView[];
  /** Total members across all groups. */
  readonly total: number;
  /** True when the store is at {@link MAX_BINDINGS} and refused new members. */
  readonly full: boolean;
}

/** One selectable provider/model pair from DSH's model catalog. */
export interface ModelChoice {
  readonly provider: string;
  readonly providerName: string;
  readonly model: string;
  readonly name: string;
  /** Reasoning efforts this model accepts, when it accepts any. */
  readonly efforts?: readonly { readonly id: string; readonly name: string }[];
  readonly defaultEffort?: string;
}

export interface ModelCatalogView {
  readonly choices: readonly ModelChoice[];
  /** Model a Session uses when its group picks none. */
  readonly dshDefault: ModelSelection | null;
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[];
  readonly fetchedAt: number;
}

/** One selectable agent preset from DSH's preset roster. */
export interface AgentPresetOption {
  readonly id: string;
  /** Published name; empty for a shipped preset the page names itself. */
  readonly name?: string;
  readonly description?: string;
  /** The preset DSH uses for a Session whose group picks none. */
  readonly isDefault: boolean;
  /** Activation failure worth showing next to the choice. */
  readonly broken?: string;
}

export interface PresetCatalogView {
  readonly presets: readonly AgentPresetOption[];
  readonly fetchedAt: number;
}

/** What DSH's permission presets offer, so the page can say when it cannot apply a mode. */
export interface PermissionCatalogView {
  /** False when the deployment has no permission-preset service: modes cannot be applied. */
  readonly available: boolean;
  /** The modes DSH currently lets a Session select. */
  readonly modes: readonly PermissionMode[];
}

export interface WorkspaceOption {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  /** The plugin's own Workspace under the DSH home. */
  readonly pluginOwned: boolean;
  /** Sessions that are not archived — the only ones that can notify anyone. */
  readonly sessionCount: number;
  /** Sessions the operator archived; hidden from the settings page. */
  readonly archivedSessionCount: number;
}

/** One administrator row: the store's settings grant the power, and keep the note. */
export interface AdminView {
  readonly id: string;
  /** Operator note; empty when unnamed. */
  readonly label: string;
  /** The note when set, the WeCom id otherwise. */
  readonly displayName: string;
  /** The group this administrator is also a member of, when they are one. */
  readonly groupName?: string;
}

/** Edits the settings page applies to the plugin's store. */
export type StoreOp =
  | { readonly op: 'group.add'; readonly name?: string }
  | {
    readonly op: 'group.update';
    readonly id: string;
    readonly patch: {
      readonly name?: string;
      readonly workspace?: string;
      readonly provider?: string;
      readonly model?: string;
      readonly reasoningEffort?: string;
      readonly preset?: string;
      readonly permission?: PermissionMode;
    };
  }
  | { readonly op: 'group.delete'; readonly id: string }
  | {
    readonly op: 'member.add';
    readonly groupId: string;
    readonly kind: BindingKind;
    readonly id: string;
    readonly label?: string;
  }
  | {
    readonly op: 'member.update';
    readonly key: string;
    readonly patch: {
      readonly groupId?: string;
      readonly sessionId?: string;
    };
  }
  | {
    /** Edit only this exact bound Session; a stale page cannot target its replacement. */
    readonly op: 'member.model';
    readonly key: string;
    readonly sessionId: string;
    readonly selection: ModelSelection;
  }
  | {
    /**
     * Set the Workspace access of this exact bound Session. Applied to the DSH
     * Session itself, which is where the value lives: it is not stored here.
     */
    readonly op: 'member.permission';
    readonly key: string;
    readonly sessionId: string;
    readonly permission: PermissionMode;
  }
  | { readonly op: 'member.remove'; readonly key: string }
  /**
   * Archive the member's bound Session and clear the binding, so the next
   * message creates a fresh Session from the group's defaults. Archiving is
   * what DSH offers instead of deletion: the Session stops being resumed, its
   * context no longer reaches any request.
   */
  | { readonly op: 'member.archive'; readonly key: string }
  /**
   * Set (or clear) a person's 备注. Independent of membership: an
   * administrator who is in no group still has a name, and the note survives
   * being removed from a group.
   */
  | { readonly op: 'label.set'; readonly key: string; readonly label: string }
  /**
   * Write the store's settings block: the administrator list, the notification
   * scope and the advanced knobs. This lands in the plugin's own document, so it
   * is applied live — no DSH config write, no bridge rebuild, no reconnect.
   */
  | { readonly op: 'settings.set'; readonly patch: StoreSettingsPatch };

export interface StoreRequest {
  readonly ops: readonly StoreOp[];
}

export interface StoreResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly routing?: RoutingView;
  /** The group a `group.add` op created, so the page can open its new form. */
  readonly createdGroupId?: string;
}

export interface BridgeStateView {
  readonly version: typeof STORE_VERSION;
  readonly connection: ConnectionStatus;
  readonly traffic: TrafficStats;
  /** Senders refused since Host start, newest first. */
  readonly rejected: readonly RejectedSenderView[];
  readonly sessions: SessionCatalogView | null;
  readonly sessionsError?: string;
  readonly routing: RoutingView | null;
  readonly routingError?: string;
  readonly models: ModelCatalogView | null;
  readonly modelsError?: string;
  readonly presets: PresetCatalogView | null;
  readonly presetsError?: string;
  readonly permissions: PermissionCatalogView;
  readonly workspaces: readonly WorkspaceOption[];
  /** The store's settings block, as the ④管理员 / ⑤连接与日志 cards edit it. */
  readonly settings: StoreSettings;
  readonly admins: readonly AdminView[];
  /** Non-fatal setup problems worth showing on the page. */
  readonly notices: readonly string[];
  readonly journal: JournalInfo;
}
