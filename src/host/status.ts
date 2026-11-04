import type { ConnectionPhase, ConnectionStatus, TrafficStats } from '../shared/protocol.js';
import type { Journal } from './journal.js';

/** Host-lifetime connection phase and traffic counters shown on the settings page. */
export interface StatusTracker {
  set(phase: ConnectionPhase, detail?: string): void;
  connection(): ConnectionStatus;
  count(counter: Exclude<keyof TrafficStats, 'since' | 'lastMessageAt'>, at?: number): void;
  traffic(): TrafficStats;
}

export function createStatusTracker(journal: Journal, now: () => number = Date.now): StatusTracker {
  let status: ConnectionStatus = { phase: 'unconfigured', since: now() };
  const counters = { received: 0, rejected: 0, prompts: 0, notifications: 0, failures: 0 };
  const since = now();
  let lastMessageAt: number | undefined;
  return {
    set(phase, detail) {
      if (status.phase === phase && status.detail === detail) return;
      const previous = status.phase;
      status = { phase, since: now(), ...(detail ? { detail } : {}) };
      journal.write({
        event: 'connection.phase',
        level: phase === 'error' || phase === 'displaced' || phase === 'invalid' ? 'warn' : 'info',
        phase, previous, ...(detail ? { detail } : {}),
      });
    },
    connection: () => status,
    count(counter, at = now()) {
      counters[counter]++;
      if (counter === 'received') lastMessageAt = at;
    },
    traffic: () => ({ since, ...counters, ...(lastMessageAt ? { lastMessageAt } : {}) }),
  };
}
