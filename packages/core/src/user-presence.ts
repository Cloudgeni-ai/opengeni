import { recordUserActivityPresence, type Database } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

/**
 * Throttled, batched server-side presence for managed humans.
 *
 * `touch` is called on the request path, so it only does an in-memory map
 * check: each person is queued at most once per throttle window per process,
 * and queued people are written in one batched database call after a short
 * delay, never awaited by the request. API keys, services and embedded-host
 * subjects are never passed here; anything outside the opaque `user:` shape is
 * ignored. The database turns a new UTC day into the `user.active` lifecycle
 * fact, and control workers read windowed counts for `opengeni_active_users`.
 */
export type UserPresenceRecorder = {
  /** Note authenticated activity for one managed human. Never throws. */
  touch(subjectId: string): void;
  /** Write everything queued now. Resolves even when the write fails. */
  flush(): Promise<void>;
  /** Flush and stop scheduling further writes. */
  close(): Promise<void>;
};

export const USER_PRESENCE_THROTTLE_MS = 60_000;
export const USER_PRESENCE_FLUSH_DELAY_MS = 5_000;
const USER_PRESENCE_MAX_TRACKED = 50_000;
const USER_PRESENCE_SUBJECT = /^user:[A-Za-z0-9_-]{8,128}$/;

const PRESENCE_FLUSH_METRIC = {
  name: "opengeni_user_presence_flushes_total",
  help: "Batched user presence writes from this API process by outcome.",
} as const;

export function createUserPresenceRecorder(options: {
  db: Database;
  observability?: Pick<Observability, "incrementCounter" | "warn"> | undefined;
  throttleMs?: number;
  flushDelayMs?: number;
  maxTracked?: number;
  now?: () => number;
  record?: (db: Database, subjectIds: readonly string[]) => Promise<number>;
}): UserPresenceRecorder {
  const throttleMs = options.throttleMs ?? USER_PRESENCE_THROTTLE_MS;
  const flushDelayMs = options.flushDelayMs ?? USER_PRESENCE_FLUSH_DELAY_MS;
  const maxTracked = options.maxTracked ?? USER_PRESENCE_MAX_TRACKED;
  const now = options.now ?? Date.now;
  const record = options.record ?? recordUserActivityPresence;
  const lastQueuedAt = new Map<string, number>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let lastWarningAt = 0;
  let tail: Promise<void> = Promise.resolve();

  const count = (outcome: "ok" | "failed") => {
    try {
      options.observability?.incrementCounter({ ...PRESENCE_FLUSH_METRIC, labels: { outcome } });
    } catch {
      // Telemetry only.
    }
  };

  const prune = (at: number) => {
    for (const [subject, queuedAt] of lastQueuedAt) {
      if (at - queuedAt >= throttleMs && !pending.has(subject)) lastQueuedAt.delete(subject);
    }
    // Still over the bound: forget the oldest entries; at worst a person is
    // written once more than the throttle would allow.
    if (lastQueuedAt.size > maxTracked) {
      const excess = lastQueuedAt.size - maxTracked;
      let removed = 0;
      for (const subject of lastQueuedAt.keys()) {
        if (removed >= excess) break;
        if (pending.has(subject)) continue;
        lastQueuedAt.delete(subject);
        removed += 1;
      }
    }
  };

  const writeBatch = async (): Promise<void> => {
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    try {
      await record(options.db, batch);
      count("ok");
    } catch (error) {
      // Let the next touch retry these people instead of waiting a window.
      for (const subject of batch) lastQueuedAt.delete(subject);
      count("failed");
      const at = now();
      if (at - lastWarningAt >= throttleMs) {
        lastWarningAt = at;
        options.observability?.warn("user presence write failed", {
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  };

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    tail = tail.then(writeBatch, writeBatch);
    return tail;
  };

  return {
    touch(subjectId) {
      if (closed || !USER_PRESENCE_SUBJECT.test(subjectId)) return;
      const at = now();
      const previous = lastQueuedAt.get(subjectId);
      if (previous !== undefined && at - previous < throttleMs) return;
      lastQueuedAt.set(subjectId, at);
      pending.add(subjectId);
      if (lastQueuedAt.size > maxTracked) prune(at);
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, flushDelayMs);
        (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      }
    },
    flush,
    async close() {
      closed = true;
      await flush();
    },
  };
}
