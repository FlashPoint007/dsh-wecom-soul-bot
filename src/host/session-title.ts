import type { HostContext } from './dsh.js';

/**
 * The Bot's own Session titles.
 *
 * Every Session this plugin creates is named `wecom-soul-bot-<principal>` — the
 * member's userid for a private chat, the chat's id for a group chat, i.e. the
 * same identity the membership is stored under. The sidebar then says which
 * WeCom conversation a Session belongs to instead of repeating its first
 * message.
 *
 * The title is written through DSH's `sessionTitle` service. Its explicit
 * `rename()` appends a `session/title` event with the `user` source, which
 * *pins* the title: the automatic first-prompt generator never renames the
 * Session afterwards, and never spends a model call on it.
 *
 * Naming is decoration, never a precondition: a Session that is not live in
 * the store yet, or a deployment without the service, must not fail the
 * message that created it. Every attempt lands in the journal instead.
 */

export const SESSION_TITLE_PREFIX = 'wecom-soul-bot-';

/** The title for one WeCom principal (a userid, or a group chat's id). */
export function sessionTitleFor(principal: string): string {
  return `${SESSION_TITLE_PREFIX}${principal}`;
}

/** `ctx.sessions`: the in-memory Session store, for the live Session object. */
export interface SessionStore {
  get(id: string): unknown;
}

/** `ctx.sessionTitle`: title folding plus the explicit, pinning rename. */
export interface SessionTitleService {
  rename(session: never, title: string): unknown;
}

export interface SessionTitler {
  /** Give a just-created Session its Bot title; never throws. */
  name(sessionId: string, title: string): void;
}

export interface SessionTitlerOptions {
  readonly ctx: Pick<HostContext, 'get'>;
  readonly journal?: { write(record: Record<string, unknown>): void };
}

export function createSessionTitler(options: SessionTitlerOptions): SessionTitler {
  const journal = options.journal ?? { write() {} };
  return {
    name(sessionId, title) {
      try {
        const sessions = options.ctx.get?.('sessions') as SessionStore | undefined;
        const titles = options.ctx.get?.('sessionTitle') as SessionTitleService | undefined;
        const session = sessions?.get?.(sessionId);
        // `rename` requires the exact live Session object: a cold Session (or
        // one this store does not hold) has no log to pin a title into.
        if (!session || typeof titles?.rename !== 'function') {
          journal.write({ event: 'dsh.session.title', sessionId, title, outcome: 'unavailable' });
          return;
        }
        titles.rename(session as never, title);
        journal.write({ event: 'dsh.session.title', sessionId, title, outcome: 'renamed' });
      } catch (error) {
        journal.write({ event: 'dsh.session.title', level: 'warn', sessionId, title, error });
      }
    },
  };
}
