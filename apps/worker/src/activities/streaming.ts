import type { SessionEventType } from "@opengeni/contracts";
import type { AppendEventInput } from "@opengeni/db";
import { Context } from "@temporalio/activity";

// Trailing-flush window. A burst of coalesced deltas followed by model silence
// must not sit in `pending` unbounded — without a timer, flush fires only on
// the NEXT push. Matched to the 33ms coalesce window so the client-visible
// latency added by batching is bounded to ~one window (imperceptible, and far
// cheaper than the per-delta DB round-trip it replaces).
const TRAILING_FLUSH_MS = 33;
const MAX_BATCH_EVENTS = 50;
// Keep model ingestion independent from a slow durable append, but never let a
// provider outrun storage without bound. At the high-water mark `push` waits for
// the serialized drain before consuming more provider output.
const MAX_BUFFERED_EVENTS = 1_000;

/** Optional metrics seam for the batcher. `onFlush` fires once per flush (on both
 *  success and failure) with the coalesced event count and the flush duration, so
 *  the worker can meter batch shape without the batcher knowing about Observability.
 *  `now` is injectable for deterministic tests. Both are optional; absent ⇒ no-op. */
export type RuntimeBatcherOptions = {
  onFlush?: (info: { events: number; durationSeconds: number }) => void;
  now?: () => number;
};

export function createRuntimeBatcher(
  flushEvents: (events: AppendEventInput[]) => Promise<void>,
  options: RuntimeBatcherOptions = {},
) {
  const now = options.now ?? (() => performance.now());
  let pending: AppendEventInput[] = [];
  let lastFlush = Date.now();
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let activeBatchSize = 0;
  // One drain loop owns `flushEvents`, so DB-assigned sequence order always
  // matches push order. Ordinary deltas do not await this promise; structural
  // boundaries, explicit flushes, and the bounded high-water mark do.
  let drainPromise: Promise<void> | null = null;
  // A timer has no direct awaiter. Retain its failure so the next push or final
  // flush terminates the turn instead of silently losing streamed evidence.
  let flushFailed = false;
  let flushFailure: unknown;
  // The high-volume token deltas (agent.message.delta, agent.reasoning.delta,
  // sandbox.command.output.delta) are DELIBERATELY NOT here: they coalesce
  // under the 50-event / 33ms policy into one appendSessionEvents txn + one
  // publish per flush, instead of one DB round-trip per token. Only events that
  // must be delivered promptly stay structural (flush-immediately). PTY bytes
  // stay structural on purpose — an interactive terminal is useless batched
  // 33ms behind (P4.4).
  const structural = new Set<SessionEventType>([
    "terminal.pty.output.delta",
    "agent.toolCall.created",
    "agent.toolCall.output",
    "agent.message.completed",
    "tool.auth_needed",
    "credential.auth_needed",
    "session.requiresAction",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
  ]);
  return {
    push: async (event: { type: SessionEventType; payload: unknown }) => {
      throwIfFlushFailed();
      // Append BEFORE the structural check so a structural event's flush always
      // carries any pending deltas in order (same flush, order preserved).
      pending.push({ type: event.type, payload: event.payload });
      const elapsed = Date.now() - lastFlush;
      if (structural.has(event.type)) {
        await flush();
        return;
      }
      if (pending.length >= MAX_BATCH_EVENTS || elapsed >= TRAILING_FLUSH_MS) {
        // Start the serialized drain, but keep consuming provider deltas while
        // the append/publish round-trip is in flight. The active drain records
        // any failure for the next awaited boundary.
        void startDrain().catch(() => undefined);
      }
      if (activeBatchSize + pending.length >= MAX_BUFFERED_EVENTS) {
        await flush();
        return;
      }
      armTrailingTimer();
    },
    flush,
  };

  function armTrailingTimer() {
    if (trailingTimer !== null) {
      return;
    }
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      // A timer has no awaiter, so prevent an unhandled rejection. startDrain
      // retains the exact error and the next push/final flush rethrows it.
      void flush().catch(() => undefined);
    }, TRAILING_FLUSH_MS);
    if ("unref" in trailingTimer && typeof trailingTimer.unref === "function") {
      trailingTimer.unref();
    }
  }

  function clearTrailingTimer() {
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
  }

  async function flush(): Promise<void> {
    throwIfFlushFailed();
    clearTrailingTimer();
    await startDrain();
    throwIfFlushFailed();
  }

  function startDrain(): Promise<void> {
    if (drainPromise) {
      return drainPromise;
    }
    if (flushFailed) {
      return Promise.reject(flushFailure);
    }
    if (pending.length === 0) {
      return Promise.resolve();
    }
    clearTrailingTimer();
    const running = (async () => {
      while (pending.length > 0) {
        const events = pending.splice(0, MAX_BATCH_EVENTS);
        activeBatchSize = events.length;
        lastFlush = Date.now();
        const startedAt = now();
        try {
          await flushEvents(events);
        } catch (error) {
          flushFailed = true;
          flushFailure = error;
          throw error;
        } finally {
          activeBatchSize = 0;
          if (options.onFlush) {
            try {
              options.onFlush({
                events: events.length,
                durationSeconds: Math.max(0, (now() - startedAt) / 1000),
              });
            } catch {
              // Metrics emission must never affect a flush.
            }
          }
        }
      }
    })();
    drainPromise = running.finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  function throwIfFlushFailed(): void {
    if (flushFailed) {
      throw flushFailure;
    }
  }
}

export function currentActivityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}

export function startActivityHeartbeat(
  context: Context | null,
  details: Record<string, unknown>,
): ReturnType<typeof setInterval> | null {
  if (!context) {
    return null;
  }
  const timer = setInterval(() => {
    context.heartbeat({ ...details, at: new Date().toISOString() });
  }, 10_000);
  if ("unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

export async function nextStreamEvent<T>(
  iterator: AsyncIterator<T>,
  context: Context | null,
): Promise<IteratorResult<T>> {
  if (!context) {
    return await iterator.next();
  }
  return await Promise.race([iterator.next(), context.cancelled]);
}
