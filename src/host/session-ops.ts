import type { AgentRef, AgentService, CompactionResult, CompactionService, HostContext } from './dsh.js';
import type { CatalogService } from './catalog.js';
import type { SessionTitler } from './session-title.js';
import type { WorkspaceService } from './workspaces.js';

/**
 * The three DSH operations a WeCom conversation may ask for, kept in one place
 * because they all need a service the routing/view modules do not:
 *
 * - **archive** a Session (`ctx.get('workspaceRegistry')`), which is DSH's
 *   closest thing to deletion: the Session stops being resumed, so its history
 *   can never reach another request, and the member's next message starts a
 *   fresh one. The JSONL log itself stays on disk — DSH offers no API to
 *   remove it, and reaching into the store by hand would corrupt its index.
 * - **compact** a Session's context, after resolving the Agent that owns it
 *   (`sessionController.resolveAgent`), exactly the way DSH's own `/compact`
 *   command does. The service is read from the *agent's* context, not this
 *   plugin's: an agent preset composes `compaction` inside an isolated group,
 *   so the host plane never provides it (see {@link compactionFor}).
 * - **create** a Session in a chosen Workspace (administrator `/new`), titled
 *   so the DSH sidebar names the WeCom conversation it belongs to.
 *
 * Every method throws a Chinese, user-facing error message: the command layer
 * only wraps them in the Bot's reply shape.
 */

export interface CreateSessionRequest {
  /** Workspace path; empty means the plugin's own Workspace. */
  readonly workspace: string;
  /** Agent preset; omitted means the DSH default. */
  readonly preset?: string;
  /** Session title; omitted leaves DSH's own titling alone. */
  readonly title?: string;
}

export interface CompactOutcome {
  /** History items folded into the summary, as DSH counted them. */
  readonly items: number;
  /** Tokens the summary replaced. */
  readonly tokens: number;
}

export interface SessionOperations {
  archive(sessionId: string): Promise<void>;
  /** `null` means DSH found nothing safe to compact. */
  compact(sessionId: string): Promise<CompactOutcome | null>;
  create(request: CreateSessionRequest): Promise<{ readonly sessionId: string }>;
}

export interface SessionOperationsOptions {
  readonly ctx: Pick<HostContext, 'sessionController' | 'get'>;
  readonly workspaces: WorkspaceService;
  readonly catalogs?: CatalogService;
  readonly titles?: SessionTitler;
  readonly journal?: { write(record: Record<string, unknown>): void };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** DSH's `ManualCompactionError` codes, in the Bot's own words. */
const COMPACTION_FAILURE: Record<string, string> = {
  busy: '会话正忙（有进行中的回合或压缩），请稍后重试。',
  cancelled: '上下文压缩已取消。',
  changed: '准备压缩的历史在压缩过程中发生了变化，请重试。',
  summary: '没能生成可用的摘要，请稍后重试。',
  commit: '压缩没有干净结束，请到 DSH 页面检查这个会话。',
  persistence: '压缩完成了，但会话保存失败。',
};

export function createSessionOperations(options: SessionOperationsOptions): SessionOperations {
  const journal = options.journal ?? { write() {} };

  /**
   * The compaction service that governs one Agent.
   *
   * `compaction` belongs to the Agent's *preset*, inside an isolated group
   * (`isolate: { compaction: true }`), so asking this plugin's own host-level
   * context finds nothing — that is exactly the 「没有挂载上下文压缩服务」 a
   * member saw. `agentPresets.serviceFor` is the documented way to read a
   * service out of an agent's own composition; `agent.ctx.get` reaches the
   * same store, and the host level stays as the last fallback for compositions
   * that keep the row on the host plane (`dsh-sdk-minimal`) .
   */
  function compactionFor(agent: AgentRef): CompactionService | undefined {
    const candidates: unknown[] = [];
    const presets = options.ctx.get?.('agentPresets') as
      | { serviceFor?(agent: AgentRef, name: string): unknown }
      | undefined;
    if (typeof presets?.serviceFor === 'function') {
      try { candidates.push(presets.serviceFor(agent, 'compaction')); } catch { /* a preset without the row answers nothing */ }
    }
    try { candidates.push(agent.ctx?.get?.('compaction')); } catch { /* never visible from this scope */ }
    try { candidates.push(options.ctx.get?.('compaction')); } catch { /* the host-plane row may be disabled */ }
    return candidates.find((candidate): candidate is CompactionService =>
      Boolean(candidate) && typeof (candidate as CompactionService).compactNow === 'function');
  }

  function registry(): { archiveSession(id: string, options?: { stopActivity?: boolean }): Promise<void> } | undefined {
    const found = options.ctx.get?.('workspaceRegistry') as
      | { archiveSession?(id: string, options?: { stopActivity?: boolean }): Promise<void> }
      | undefined;
    return found && typeof found.archiveSession === 'function'
      ? found as { archiveSession(id: string, options?: { stopActivity?: boolean }): Promise<void> }
      : undefined;
  }

  async function agentFor(sessionId: string): Promise<ReturnType<AgentService['get']>> {
    const agents = options.ctx.get?.('agents') as AgentService | undefined;
    const live = agents?.get?.(sessionId);
    if (live) return live;
    let resolved;
    try {
      resolved = await options.ctx.sessionController.resolveAgent(sessionId);
    } catch (error) {
      throw new Error(`无法恢复这个会话：${message(error)}`);
    }
    if ('error' in resolved) {
      const code = resolved.error.code ?? '';
      throw new Error(code.includes('not-found') ? '这个会话已经不存在了。' : `无法恢复这个会话：${resolved.error.message ?? code}`);
    }
    return resolved.agent;
  }

  return {
    async archive(sessionId) {
      const target = registry();
      if (!target) throw new Error('当前 DSH 没有挂载 Workspace 注册表，无法归档会话。');
      try {
        // Stopping activity is explicitly requested: archiving a Session that
        // is still running must cancel its work instead of being refused.
        await target.archiveSession(sessionId, { stopActivity: true });
      } catch (error) {
        throw new Error(`归档会话失败：${message(error)}`);
      }
      options.catalogs?.invalidate();
      journal.write({ event: 'dsh.session.archive', sessionId });
    },
    async compact(sessionId) {
      const agent = await agentFor(sessionId);
      if (!agent) throw new Error('无法恢复这个会话。');
      const compaction = compactionFor(agent);
      if (!compaction) throw new Error('这个会话所在的 preset 没有挂载上下文压缩服务，无法压缩它的上下文。');
      let result: CompactionResult | null;
      try {
        result = await compaction.compactNow(agent, AbortSignal.timeout(120_000));
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
        throw new Error(COMPACTION_FAILURE[code] ?? `上下文压缩失败：${message(error)}`);
      }
      if (!result) return null;
      options.catalogs?.invalidate();
      journal.write({
        event: 'dsh.session.compact', sessionId,
        items: result.shadowedSeqs.length, tokens: result.shadowedTokenCount, summarySeq: result.summarySeq,
      });
      return { items: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    },
    async create(request) {
      const workspace = await options.workspaces.resolve(request.workspace);
      const preset = request.preset?.trim();
      try {
        const created = await options.ctx.sessionController.create({
          ...(workspace.id ? { workspaceId: workspace.id } : { cwd: workspace.path }),
          ...(preset ? { agentPreset: preset } : {}),
        });
        options.catalogs?.invalidate();
        if (request.title) options.titles?.name(created.sessionId, request.title);
        journal.write({
          event: 'dsh.session.create', sessionId: created.sessionId,
          workspace: workspace.path, workspaceId: workspace.id, preset: preset || null, source: 'wecom-admin',
        });
        return { sessionId: created.sessionId };
      } catch (error) {
        throw new Error(`无法在 Workspace「${workspace.title}」中创建会话：${message(error)}`);
      }
    },
  };
}
