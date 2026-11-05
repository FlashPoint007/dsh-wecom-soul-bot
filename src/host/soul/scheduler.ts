import { randomUUID } from 'node:crypto';
import type { BindingRecord } from '../../shared/protocol.js';
import type { Journal } from '../journal.js';
import { inQuietHours, SCHEDULER_USER } from './rules.js';
import type { ScheduledKind, Sender, SoulService } from './service.js';
import type { Reminder, SoulStore } from './store.js';

/**
 * Plugin-initiated turns: due reminders, then (off by default) random proactive chat.
 *
 * Every tick (one minute by default) the scheduler first delivers due reminders,
 * then, when proactive chat is enabled and its own interval has elapsed, rolls a
 * local die (no model call) to decide whether to open one proactive turn with an
 * owner's private chat. Both go through submit(), which provisions the bound
 * Session and queues a prompt marked as plugin-initiated: the turn is never an
 * owner turn, so it stays chat-only, and the reply goes back through chat mode.
 *
 * Guards for proactive chat: quiet hours, a per-day cap, a cooldown after the
 * last proactive chat, and only owner private chats that already have a binding.
 * Reminders ignore quiet hours: they fire when the person asked for them.
 */

export interface SchedulerTarget {
  readonly binding: BindingRecord;
  readonly sessionId: string;
}

export interface SoulSchedulerOptions {
  readonly store: SoulStore;
  readonly soul: SoulService;
  readonly journal?: Pick<Journal, 'write'>;
  /** The binding row for a binding key ("user:<id>" / "group:<id>"), if still authorized. */
  bindingFor(key: string): BindingRecord | undefined;
  /** Submit one plugin-initiated prompt to the binding's Session; resolves to the Session id. */
  submit(binding: BindingRecord, text: string, requestId: string): Promise<string | undefined>;
  /** Whether the WeCom connection can deliver right now. */
  online(): boolean;
  now?: () => number;
  random?: () => number;
  tickMs?: number;
}

export interface SoulScheduler {
  start(): () => void;
  /** Run one tick now (tests and manual triggers). */
  tick(): Promise<void>;
}

const MINUTE = 60_000;
/** A reminder this late is reported as missed instead of delivered (e.g. after a long downtime). */
const MAX_LATENESS_MS = 12 * 60 * MINUTE;

export function createSoulScheduler(options: SoulSchedulerOptions): SoulScheduler {
  const { store, soul } = options;
  const journal = options.journal ?? { write() {} };
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const tickMs = options.tickMs ?? MINUTE;
  let lastRollAt = 0;
  let running = false;

  async function deliverReminder(reminder: Reminder): Promise<void> {
    const binding = options.bindingFor(reminder.bindingKey);
    if (!binding) {
      await store.settleReminder(reminder.id, 'failed');
      journal.write({ event: 'soul.reminder.dropped', level: 'warn', id: reminder.id, reason: 'binding-gone' });
      return;
    }
    if (now() - reminder.dueAt > MAX_LATENESS_MS) {
      await store.settleReminder(reminder.id, 'failed');
      journal.write({ event: 'soul.reminder.dropped', level: 'warn', id: reminder.id, reason: 'too-late' });
      return;
    }
    const chatType = binding.kind === 'group' ? 'group' : 'single';
    const sessionId = await submitScheduled(binding, 'reminder', chatType, reminder.text);
    if (sessionId) {
      await store.settleReminder(reminder.id, 'sent');
      journal.write({ event: 'soul.reminder.sent', id: reminder.id, sessionId, binding: reminder.bindingKey });
    }
  }

  async function submitScheduled(binding: BindingRecord, kind: ScheduledKind, chatType: 'single' | 'group', detail: string): Promise<string | undefined> {
    const requestId = randomUUID();
    const text = soul.decorateScheduled(kind, chatType, detail);
    try {
      return await options.submit(binding, text, requestId);
    } catch (error) {
      journal.write({ event: 'soul.scheduled.failed', level: 'warn', kind, binding: binding.kind + ':' + binding.id, error });
      return undefined;
    }
  }

  /** Whether proactive chat may roll now; returns the reason when it may not. */
  function proactiveBlocked(at: number): string | undefined {
    const s = store.settings();
    if (!s.enabled || !s.proactiveEnabled) return 'disabled';
    if (inQuietHours(new Date(at).getHours(), s.quietStartHour, s.quietEndHour)) return 'quiet-hours';
    const state = store.proactive();
    if (state.count >= s.proactiveDailyLimit) return 'daily-limit';
    if (state.lastAt && at - state.lastAt < s.proactiveCooldownMinutes * MINUTE) return 'cooldown';
    return undefined;
  }

  async function maybeProactive(): Promise<void> {
    const at = now();
    const s = store.settings();
    if (at - lastRollAt < s.proactiveIntervalMinutes * MINUTE) return;
    lastRollAt = at;
    const blocked = proactiveBlocked(at);
    if (blocked) return;
    const roll = random();
    if (roll >= s.proactiveChance) {
      journal.write({ event: 'soul.proactive.roll', hit: false, roll, chance: s.proactiveChance });
      return;
    }
    const targets = soul.owners().map(id => options.bindingFor('user:' + id)).filter((b): b is BindingRecord => Boolean(b));
    if (!targets.length) {
      journal.write({ event: 'soul.proactive.skipped', reason: 'no-owner-private-chat' });
      return;
    }
    const target = targets[Math.floor(random() * targets.length) % targets.length]!;
    const sessionId = await submitScheduled(target, 'proactive', 'single', '');
    if (sessionId) {
      await store.recordProactive(at);
      journal.write({ event: 'soul.proactive.sent', sessionId, binding: 'user:' + target.id, roll, chance: s.proactiveChance });
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (!options.online()) return;
      const s = store.settings();
      if (s.enabled && s.remindersEnabled) {
        const due = store.reminders().filter(r => r.status === 'pending' && r.dueAt <= now()).sort((a, b) => a.dueAt - b.dueAt);
        for (const reminder of due) await deliverReminder(reminder);
      }
      await maybeProactive();
    } catch (error) {
      journal.write({ event: 'soul.scheduler.error', level: 'warn', error });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      // The first proactive roll waits one full interval after start: a restart is not a reason to talk.
      lastRollAt = now();
      const timer = setInterval(() => { void tick(); }, tickMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    tick,
  };
}

export type { Sender };
export { SCHEDULER_USER };
