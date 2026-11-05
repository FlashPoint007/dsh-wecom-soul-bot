import type { AgentService, HostContext, SessionEvent } from './dsh.js';
import type { ModelService } from './models.js';
import { IDENTITY_TAG } from './soul/rules.js';

/**
 * Session controls borrowed from dsh-im: steer a running turn, clear the model
 * context, switch the Session model, read recent history.
 *
 * steer uses sessionController.prompt with mode "steer" (the session.prompt mode
 * dsh-im uses); clear runs DSH's own /clear through the Typert command gateway and
 * never falls back to anything else; history reads the live Session log.
 */

export interface HistoryItem {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface HostSessionControls {
  steer(sessionId: string, text: string, requestId: string): Promise<boolean>;
  clear(sessionId: string): Promise<'cleared' | 'unsupported' | { readonly error: string }>;
  models(sessionId: string): Promise<{ readonly current?: string; readonly choices: readonly { readonly label: string; readonly provider: string; readonly model: string }[] }>;
  selectModel(sessionId: string, provider: string, model: string): Promise<string>;
  history(sessionId: string, count: number): Promise<readonly HistoryItem[] | undefined>;
}

interface TypertGateway {
  invoke(request: Record<string, unknown>): Promise<unknown>;
}

interface LiveSession {
  snapshotEvents?(): readonly SessionEvent[];
}

export interface HostSessionControlsOptions {
  readonly ctx: Pick<HostContext, 'sessionController' | 'get'>;
  readonly models: ModelService;
  /** Whether a Session currently has a running turn. */
  running(sessionId: string): Promise<boolean>;
  /** The model a Session runs, as provider/model, when known. */
  currentModel(sessionId: string): Promise<string | undefined>;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n').trim();
}

/** Drop the plugin identity line from a WeCom prompt so history shows what the person typed. */
export function stripIdentity(text: string): string {
  if (!text.startsWith(IDENTITY_TAG)) return text;
  const cut = text.indexOf('\n\n');
  return cut < 0 ? '' : text.slice(cut + 2).trim();
}

/** The last count user/assistant exchanges of a Session log, oldest first. */
export function recentHistory(events: readonly SessionEvent[], count: number): HistoryItem[] {
  const out: HistoryItem[] = [];
  const finals = new Map<number, string>();
  for (const event of events) {
    const data = event.data;
    if (event.type === 'user/message' && data?.source?.kind === 'user') {
      const text = stripIdentity(textOf(data.content));
      if (text && !text.startsWith('/')) out.push({ role: 'user', text });
    } else if (event.type === 'assistant/message' && typeof data?.turn === 'number') {
      const text = textOf(data.message?.content);
      if (text) finals.set(data.turn, text);
    } else if (event.type === 'turn/end' && typeof data?.turn === 'number') {
      const text = finals.get(data.turn);
      finals.delete(data.turn);
      if (text && data.reason?.kind === 'completed') out.push({ role: 'assistant', text });
    }
  }
  return out.slice(-Math.max(1, count));
}

export function createHostSessionControls(options: HostSessionControlsOptions): HostSessionControls {
  const { ctx, models } = options;
  return {
    async steer(sessionId, text, requestId) {
      if (!(await options.running(sessionId))) return false;
      await ctx.sessionController.prompt({
        requestId, sessionId, mode: 'steer', content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000));
      return true;
    },
    async clear(sessionId) {
      const gateway = ctx.get?.('typertGateway') as TypertGateway | undefined;
      if (!gateway || typeof gateway.invoke !== 'function') return 'unsupported';
      try {
        const execution = await gateway.invoke({
          namespace: 'commands', method: 'execute',
          args: { agentId: sessionId, line: '/clear', images: [] },
          signal: AbortSignal.timeout(60_000),
        }) as { result?: { kind?: string; text?: string; message?: string } } | undefined;
        if (execution === undefined) return 'unsupported';
        const result = execution?.result;
        if (result?.kind === 'success') return 'cleared';
        return { error: result?.message ?? result?.text ?? '宿主没有执行 /clear。' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/unknown command|not registered|commands-unavailable/i.test(message)) return 'unsupported';
        return { error: message };
      }
    },
    async models(sessionId) {
      const catalog = await models.load();
      return {
        ...(await options.currentModel(sessionId).then(c => (c ? { current: c } : {}))),
        choices: catalog.choices.map(c => ({ label: c.providerName + ' / ' + (c.name || c.model), provider: c.provider, model: c.model })),
      };
    },
    async selectModel(sessionId, provider, model) {
      const selected = await models.select(sessionId, { provider, model });
      return selected.provider + '/' + selected.model;
    },
    async history(sessionId, count) {
      const agents = ctx.get?.('agents') as AgentService | undefined;
      let session = (agents?.get?.(sessionId) as { session?: LiveSession } | undefined)?.session;
      if (!session?.snapshotEvents) {
        const store = ctx.get?.('sessions') as { get?(id: string): unknown } | undefined;
        session = store?.get?.(sessionId) as LiveSession | undefined;
      }
      if (!session?.snapshotEvents) return undefined;
      return recentHistory(session.snapshotEvents(), count);
    },
  };
}
