import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_LOG_RETENTION_DAYS, DEFAULT_QUESTION_TIMEOUT_MS, DEFAULT_SECRET_REF,
  MAX_LOG_RETENTION_DAYS, MAX_QUESTION_TIMEOUT_MS, MIN_LOG_RETENTION_DAYS, MIN_QUESTION_TIMEOUT_MS,
  type StoreSettings,
} from '../shared/protocol.js';

/**
 * Plugin Config: the connection identity, and only that.
 *
 * This is the one part of the plugin a DSH profile declares, so it is the one
 * part that must stay in the Config document: the Bot ID, and the *reference* to
 * the Secret in DSH's credential store (the Secret itself is never written to
 * any file). Everything else the operator edits — administrators, the
 * notification scope, the WebSocket endpoint, the question timeout, remote
 * approvals, the journal — lives in the plugin's own document
 * (`store.ts`, `<DSH home>/wecom-soul-bot/settings.json`) and is applied live.
 *
 * A Config write rebuilds the bridge and reconnects the socket, which is exactly
 * right for an identity change and wrong for everything else: adding an
 * administrator must not drop the WeCom connection while somebody is talking to
 * the Bot from their phone. See the convention in AGENTS.md.
 */
export const Config = z.object({
  botId: z.string().default('').volatile()
    .description('企业微信智能机器人的 Bot ID（必填）。'),
  secretEnv: z.string().role('credential-ref').default(DEFAULT_SECRET_REF).volatile()
    .description('Bot Secret 在 DSH 凭据库中的引用名；Secret 本身不写入配置。'),
});

interface Volatile<T> { get(): T }

export interface PluginConfig {
  readonly botId: Volatile<string>;
  readonly secretEnv: Volatile<string>;
}

/** Normalized settings consumed by the bridge. */
export interface BridgeSettings {
  readonly botId: string;
  readonly secretRef: string;
  /** Empty for the SDK default endpoint. */
  readonly wsUrl: string;
  readonly adminUserIds: readonly string[];
  /** Empty means every Workspace. */
  readonly adminWorkspaces: readonly string[];
  readonly questionTimeoutMs: number;
  readonly remoteApprovals: boolean;
}

export interface JournalSettings {
  readonly enabled: boolean;
  readonly retentionDays: number;
}

export function uniqueIds(values: readonly unknown[] | undefined): string[] {
  const result = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id) result.add(id);
  }
  return [...result];
}

/** Only a credential-free `wss://` URL may replace the SDK endpoint. */
export function isTrustedWsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/**
 * The connection identity plus the store's settings, as the bridge wants them.
 *
 * The identity comes from the Config (which DSH owns); everything else comes
 * from the store, and the bridge re-reads it on every message rather than
 * holding a snapshot, so a settings edit needs no rebuild.
 */
export function readBridgeSettings(config: PluginConfig, settings: StoreSettings): BridgeSettings {
  return {
    botId: config.botId.get().trim(),
    secretRef: config.secretEnv.get().trim(),
    wsUrl: settings.wsUrl,
    adminUserIds: uniqueIds(settings.adminUserIds),
    adminWorkspaces: uniqueIds(settings.adminWorkspaces),
    questionTimeoutMs: clamp(
      settings.questionTimeoutMs, MIN_QUESTION_TIMEOUT_MS, MAX_QUESTION_TIMEOUT_MS, DEFAULT_QUESTION_TIMEOUT_MS,
    ),
    remoteApprovals: settings.remoteApprovals === true,
  };
}

export function readJournalSettings(settings: StoreSettings): JournalSettings {
  return {
    enabled: settings.logEnabled !== false,
    retentionDays: clamp(
      settings.logRetentionDays, MIN_LOG_RETENTION_DAYS, MAX_LOG_RETENTION_DAYS, DEFAULT_LOG_RETENTION_DAYS,
    ),
  };
}

/** Trailing separators and redundant `.` segments make two spellings of one path differ. */
export function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const collapsed = trimmed.replace(/[/\\]+$/, '');
  return collapsed || trimmed;
}

/** Whether a path lies in a configured workspace list; an empty list is every path. */
export function pathListed(values: readonly string[], path: string | undefined): boolean {
  if (!values.length) return true;
  if (!path) return false;
  const target = normalizePath(path);
  return values.some(value => normalizePath(value) === target);
}
