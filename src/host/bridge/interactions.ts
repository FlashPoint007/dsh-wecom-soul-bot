import { randomInt } from 'node:crypto';
import type { ApprovalOutcome, Question, QuestionAnswer, QuestionAnswerItem } from '../dsh.js';
import type { InteractionDelivery, InteractionSubmission } from '../interaction-transport.js';

/**
 * Pending structured questions and tool approvals answered from WeCom.
 *
 * Each wait is bound to one Session and one fresh, unpredictable short code
 * (the nonce). A reply must quote it, so a delayed or duplicated reply can
 * never claim a later request — even one with the same question id or tool.
 * Every wait resolves to `null` on timeout, abort or shutdown, which makes
 * the caller fall back to the DSH page.
 */

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Short, unambiguous, unpredictable verification code (≈ 30 bits). */
export function verificationCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export interface PendingState<T> {
  active(): boolean;
  submit(value: T): Promise<InteractionSubmission>;
}

export interface PendingQuestion extends PendingState<QuestionAnswer> {
  readonly sessionId: string;
  readonly questions: readonly Question[];
  readonly nonce: string;
  readonly answers: Map<string, QuestionAnswerItem>;
  finish(value: QuestionAnswer | null): void;
}

export interface PendingApproval extends PendingState<ApprovalOutcome> {
  readonly sessionId: string;
  readonly toolName: string;
  readonly callId?: string;
  readonly nonce: string;
  /** Only these single chats may answer. */
  readonly privateChats: ReadonlySet<string>;
  finish(value: ApprovalOutcome | null): void;
}

export interface Wait<T> {
  readonly nonce: string;
  readonly result: Promise<T | null>;
}

export interface InteractionRegistry {
  readonly questions: ReadonlyMap<string, PendingQuestion>;
  readonly approvals: ReadonlyMap<string, PendingApproval>;
  /** Undefined when this Session already has a pending question. */
  waitQuestion(sessionId: string, questions: readonly Question[], timeoutMs: number, signal?: AbortSignal, delivery?: InteractionDelivery): Wait<QuestionAnswer> | undefined;
  /** Undefined when this Session already has a pending approval. */
  waitApproval(
    sessionId: string,
    request: { readonly toolName: string; readonly callId?: string; readonly privateChats: readonly string[] },
    timeoutMs: number,
    signal?: AbortSignal,
    delivery?: InteractionDelivery,
  ): Wait<ApprovalOutcome> | undefined;
  findQuestion(nonce: string): PendingQuestion | undefined;
  findApproval(nonce: string): PendingApproval | undefined;
  hasQuestion(sessionId: string): boolean;
  isPending(nonce: string): boolean;
  /** Bounded, expiring tombstones distinguish a late attempt from an unknown nonce. */
  wasClosed(nonce: string): boolean;
  cancelAll(): void;
}

export function createInteractionRegistry(): InteractionRegistry {
  const questions = new Map<string, PendingQuestion>();
  const approvals = new Map<string, PendingApproval>();
  const terminal = new Map<string, number>();
  const normalized = (nonce: string) => nonce.trim().toLowerCase();
  const prune = (): void => {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [nonce, time] of terminal) if (time < cutoff) terminal.delete(nonce);
    while (terminal.size > 1000) terminal.delete(terminal.keys().next().value!);
  };
  const fresh = (): string => {
    prune();
    let nonce: string;
    do { nonce = verificationCode(); } while (terminal.has(nonce)
      || [...questions.values(), ...approvals.values()].some(state => state.nonce === nonce));
    return nonce;
  };

  function open<T, State extends PendingState<T> & { finish(value: T | null): void }>(
    map: Map<string, State>, key: string, nonce: string, timeoutMs: number, signal: AbortSignal | undefined,
    makeState: (finish: (value: T | null) => void, active: () => boolean, submit: (value: T) => Promise<InteractionSubmission>) => State,
    delivery?: InteractionDelivery,
  ): Promise<T | null> {
    return new Promise<T | null>(resolve => {
      let done = false;
      let submitting = false;
      const finish = (value: T | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (map.get(key) === state) map.delete(key);
        terminal.set(nonce, Date.now());
        prune();
        resolve(value);
      };
      const active = (): boolean => !done && !submitting;
      const submit = async (value: T): Promise<InteractionSubmission> => {
        if (!active()) return 'closed';
        submitting = true;
        if (!delivery) { finish(value); return 'accepted'; }
        const result = await delivery.submit(value);
        if (done) return 'closed';
        finish(result === 'closed' ? null : value);
        return result;
      };
      const abort = (): void => finish(null);
      const timer = setTimeout(abort, timeoutMs);
      const state = makeState(finish, active, submit);
      map.set(key, state);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  const findQuestion = (nonce: string) => [...questions.values()].find(state => state.nonce === normalized(nonce));
  const findApproval = (nonce: string) => [...approvals.values()].find(state => state.nonce === normalized(nonce));
  return {
    questions, approvals,
    waitQuestion(sessionId, list, timeoutMs, signal, delivery) {
      const key = delivery?.id ?? sessionId;
      if (questions.has(key) || signal?.aborted) return undefined;
      const nonce = fresh();
      const result = open<QuestionAnswer, PendingQuestion>(questions, key, nonce, timeoutMs, signal,
        (finish, active, submit) => ({ sessionId, questions: list, nonce, answers: new Map(), finish, active, submit }), delivery);
      return { nonce, result };
    },
    waitApproval(sessionId, request, timeoutMs, signal, delivery) {
      const key = delivery?.id ?? sessionId;
      if (approvals.has(key) || signal?.aborted) return undefined;
      const nonce = fresh();
      const result = open<ApprovalOutcome, PendingApproval>(approvals, key, nonce, timeoutMs, signal,
        (finish, active, submit) => ({
          sessionId, toolName: request.toolName, nonce, privateChats: new Set(request.privateChats), finish, active, submit,
          ...(request.callId ? { callId: request.callId } : {}),
        }), delivery);
      return { nonce, result };
    },
    findQuestion, findApproval,
    hasQuestion: sessionId => [...questions.values()].some(state => state.sessionId === sessionId),
    isPending: nonce => Boolean(findQuestion(nonce)?.active() || findApproval(nonce)?.active()),
    wasClosed(nonce) { prune(); return terminal.has(normalized(nonce)); },
    cancelAll() {
      for (const state of [...questions.values()]) state.finish(null);
      for (const state of [...approvals.values()]) state.finish(null);
    },
  };
}

export type ParsedAnswer =
  | { readonly ok: true; readonly item: QuestionAnswerItem }
  | { readonly ok: false; readonly error: string };

/** Map `1`, `1,3`, an exact option label, or free text onto one answer item. */
export function parseAnswer(question: Question, raw: string): ParsedAnswer {
  const value = raw.trim();
  if (!value) return { ok: false, error: '答案不能为空' };
  const options = question.options ?? [];
  const indices = value.split(/[,，、\s]+/).filter(Boolean).map(Number);
  let selected: string[] = [];
  if (options.length && indices.length && indices.every(n => Number.isInteger(n) && n >= 1 && n <= options.length)) {
    selected = [...new Set(indices)].map(n => options[n - 1]!.label);
  } else if (options.some(option => option.label === value)) {
    selected = [value];
  }
  if (selected.length > 1 && !question.multiSelect) return { ok: false, error: '这道题只能选择一个选项' };
  return { ok: true, item: { id: question.id, selected, ...(selected.length ? {} : { custom: value }) } };
}
