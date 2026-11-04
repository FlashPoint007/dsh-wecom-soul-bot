import type { ContentBlock, SessionEvent, SessionHandle } from './dsh.js';

/**
 * Summary of one finished DSH turn, read from the Session's committed log.
 * Only user-visible assistant text is relayed to WeCom; reasoning, tool
 * calls and tool results are counted but never copied.
 */
export interface TurnSummary {
  readonly sessionId: string;
  readonly turn?: number;
  readonly reason: string;
  /** Safe terminal classification only; provider messages/stacks may contain secrets. */
  readonly failure?: { readonly code?: string; readonly status?: number };
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly model?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string };
  readonly steps: number;
  readonly toolCalls: Readonly<Record<string, number>>;
  /** Text blocks of the final assistant message. */
  readonly assistantText: string;
  /** Block types of the final assistant message that were not relayed. */
  readonly omittedBlocks: Readonly<Record<string, number>>;
  /** `rpcId`s of user prompts that entered this turn (prompt `requestId`s). */
  readonly promptIds: readonly string[];
}

function textOf(content: readonly ContentBlock[] | undefined): string {
  return (content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/** Walk back from the end of the log to this turn's `turn/start`. */
export function summarizeTurn(session: SessionHandle, end: SessionEvent): TurnSummary {
  const events = session.snapshotEvents();
  const turn = end.data?.turn;
  let assistantText = '';
  let finalFound = false;
  const omittedBlocks: Record<string, number> = {};
  const toolCalls: Record<string, number> = {};
  const promptIds: string[] = [];
  let steps = 0;
  let startedAt: number | undefined;
  let model: TurnSummary['model'];

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event === end || event.type === 'turn/end') continue;
    if (event.type === 'turn/start') {
      if (turn === undefined || event.data?.turn === turn) { startedAt = event.time; break; }
      continue;
    }
    if (turn !== undefined && typeof event.data?.turn === 'number' && event.data.turn !== turn) continue;
    switch (event.type) {
      case 'assistant/message': {
        if (finalFound) break;
        const content = event.data?.message?.content;
        const text = textOf(content);
        if (!text) break;
        finalFound = true;
        assistantText = text;
        for (const block of content ?? []) {
          if (block.type !== 'text') omittedBlocks[block.type] = (omittedBlocks[block.type] ?? 0) + 1;
        }
        break;
      }
      case 'step/start':
        steps++;
        break;
      case 'tool/call': {
        const name = typeof event.data?.name === 'string' ? event.data.name : 'unknown';
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        break;
      }
      case 'user/message': {
        const source = event.data?.source;
        if (source?.kind === 'user' && typeof source.rpcId === 'string') promptIds.push(source.rpcId);
        break;
      }
      case 'request/header': {
        const config = event.data?.header?.config;
        if (config && !model) model = { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort };
        break;
      }
      default:
        break;
    }
  }
  const endedAt = end.time;
  const failure = end.data?.reason?.kind === 'error' ? end.data.reason.error : undefined;
  const detail = failure && typeof failure === 'object' ? failure as Record<string, unknown> : undefined;
  const failureCode = typeof detail?.code === 'string' && /^[a-z][a-z0-9_.\/-]{0,63}$/i.test(detail.code) ? detail.code : undefined;
  const failureStatus = typeof detail?.status === 'number' && Number.isInteger(detail.status) && detail.status >= 400 && detail.status <= 599 ? detail.status : undefined;
  return {
    ...(failureCode || failureStatus ? { failure: { ...(failureCode ? { code: failureCode } : {}), ...(failureStatus ? { status: failureStatus } : {}) } } : {}),
    sessionId: session.id,
    ...(turn === undefined ? {} : { turn }),
    reason: end.data?.reason?.kind ?? 'unknown',
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(startedAt !== undefined && endedAt !== undefined ? { durationMs: endedAt - startedAt } : {}),
    ...(model ? { model } : {}),
    steps,
    toolCalls,
    assistantText,
    omittedBlocks,
    promptIds: promptIds.reverse(),
  };
}
