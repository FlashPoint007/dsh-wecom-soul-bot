import { randomUUID } from 'node:crypto';
import type { Journal } from './journal.js';
import type { TurnSummary } from './turns.js';

/**
 * A "round" is one WeCom message and everything it caused: the passive
 * replies, the DSH prompt it submitted, and — for prompts — the DSH turn
 * that consumed it. Each finished round becomes one `round.complete` JSONL
 * line holding the raw request, the response and the metadata, so a reader
 * can follow a conversation without joining the detailed event lines.
 *
 * Prompts are matched to turns exactly: a prompt's `requestId` reappears as
 * the `rpcId` of the `user/message` event inside the turn that consumed it.
 * The tracker lives as long as the Host plugin, so a Config change that
 * rebuilds the WeCom connection does not lose rounds waiting for a turn.
 */

export interface RoundInit {
  readonly chatId: string;
  readonly userId: string;
  readonly chatType: 'single' | 'group';
  readonly msgId: string;
  readonly reqId: string;
  readonly msgtype: string;
  readonly text?: string;
}

export type RoundOutcome =
  | 'rejected' // access policy refused the sender or conversation
  | 'unsupported' // not a text message
  | 'command' // a slash command answered directly
  | 'blocked' // a plain message that could not be submitted (no Session, pending question, ...)
  | 'prompt-failed' // DSH refused the prompt
  | 'turn-ended' // the DSH turn that consumed the prompt finished
  | 'interrupted' // the Host plugin stopped before the turn finished
  | 'expired'; // no turn consumed the prompt within the retention window

export interface Round {
  readonly id: string;
  readonly init: RoundInit;
  readonly receivedAt: number;
  readonly replies: string[];
  command?: string;
  sessionId?: string;
  sessionTitle?: string | null;
  workspace?: string;
  requestId?: string;
  submittedAt?: number;
  done: boolean;
}

export interface RoundTracker {
  begin(init: RoundInit): Round;
  /** Record the text of one passive reply sent for this round. */
  reply(round: Round, text: string): void;
  /** Finish a round that will not wait for a DSH turn. */
  complete(round: Round, outcome: Exclude<RoundOutcome, 'turn-ended'>, extra?: Record<string, unknown>): void;
  /** The prompt was accepted; finish when the turn that consumes `requestId` ends. */
  awaitTurn(round: Round, requestId: string): void;
  /** Finish every round consumed by this turn; returns them. */
  onTurnEnd(summary: TurnSummary, notifiedChats?: readonly string[]): readonly Round[];
  hasPending(sessionId: string): boolean;
  pending(): number;
  closeAll(outcome: 'interrupted'): void;
}

export interface RoundTrackerOptions {
  readonly journal: Journal;
  readonly maxPending?: number;
  readonly ttlMs?: number;
  now?(): number;
}

export function createRoundTracker(options: RoundTrackerOptions): RoundTracker {
  const { journal } = options;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const maxPending = options.maxPending ?? 500;
  const byRequest = new Map<string, Round>();

  function emit(round: Round, outcome: RoundOutcome, extra: Record<string, unknown> = {}): void {
    if (round.done) return;
    round.done = true;
    if (round.requestId) byRequest.delete(round.requestId);
    const completedAt = now();
    const { response, metadata, ...rest } = extra as { response?: Record<string, unknown>; metadata?: Record<string, unknown> };
    journal.write({
      event: 'round.complete',
      level: outcome === 'prompt-failed' || outcome === 'expired' ? 'warn' : 'info',
      roundId: round.id,
      outcome,
      chatId: round.init.chatId,
      userId: round.init.userId,
      chatType: round.init.chatType,
      msgId: round.init.msgId,
      ...(round.sessionId ? { sessionId: round.sessionId } : {}),
      ...(round.sessionTitle !== undefined ? { sessionTitle: round.sessionTitle } : {}),
      ...(round.workspace ? { workspace: round.workspace } : {}),
      ...(round.requestId ? { requestId: round.requestId } : {}),
      request: {
        msgtype: round.init.msgtype,
        ...(round.init.text !== undefined ? { text: round.init.text } : {}),
        ...(round.command ? { command: round.command } : {}),
      },
      response: { replies: round.replies, ...response },
      ...(metadata ? { metadata } : {}),
      timing: {
        receivedAt: new Date(round.receivedAt).toISOString(),
        ...(round.submittedAt ? { submittedAt: new Date(round.submittedAt).toISOString() } : {}),
        completedAt: new Date(completedAt).toISOString(),
        totalMs: completedAt - round.receivedAt,
      },
      ...rest,
    });
  }

  function expire(): void {
    const cutoff = now() - ttl;
    for (const round of [...byRequest.values()]) {
      if ((round.submittedAt ?? round.receivedAt) <= cutoff) emit(round, 'expired');
    }
    while (byRequest.size > maxPending) emit(byRequest.values().next().value!, 'expired');
  }

  return {
    begin(init) {
      return { id: randomUUID(), init, receivedAt: now(), replies: [], done: false };
    },
    reply(round, text) {
      if (!round.done) round.replies.push(text);
    },
    complete(round, outcome, extra) {
      emit(round, outcome, extra);
    },
    awaitTurn(round, requestId) {
      if (round.done) return;
      round.requestId = requestId;
      round.submittedAt = now();
      byRequest.set(requestId, round);
      expire();
    },
    onTurnEnd(summary, notifiedChats = []) {
      const finished: Round[] = [];
      for (const requestId of summary.promptIds) {
        const round = byRequest.get(requestId);
        if (!round || round.sessionId !== summary.sessionId) continue;
        emit(round, 'turn-ended', {
          response: {
            reason: summary.reason,
            assistant: summary.assistantText,
            notifiedChats,
          },
          metadata: {
            turn: summary.turn,
            model: summary.model,
            steps: summary.steps,
            toolCalls: summary.toolCalls,
            omittedBlocks: summary.omittedBlocks,
            turnDurationMs: summary.durationMs,
          },
        });
        finished.push(round);
      }
      expire();
      return finished;
    },
    hasPending(sessionId) {
      for (const round of byRequest.values()) if (round.sessionId === sessionId) return true;
      return false;
    },
    pending: () => byRequest.size,
    closeAll(outcome) {
      for (const round of [...byRequest.values()]) emit(round, outcome);
    },
  };
}
