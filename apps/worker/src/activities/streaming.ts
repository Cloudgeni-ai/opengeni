import type { SessionEventType } from "@opengeni/contracts";
import { TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS } from "@opengeni/core";
import type { AppendEventInput } from "@opengeni/db";
import { SESSION_EVENT_COALESCED_TEXT_TARGET_BYTES } from "@opengeni/events";
import { Context } from "@temporalio/activity";

// Trailing-flush window. A burst of coalesced deltas followed by model silence
// must not sit in `pending` unbounded — without a timer, flush fires only on
// the NEXT push. The first fragment after a flush or a silence is sent at once
// (time to first token is unchanged); later fragments wait at most one window.
// Each flush stores adjacent text fragments as one row, so the window sets how
// many delta rows a stream writes: on staging traffic, 100ms stores about a
// fifth of the provider fragments.
export const TRAILING_FLUSH_MS = 100;
const MAX_BATCH_EVENTS = 50;
// Keep model ingestion independent from a slow durable append, but never let a
// provider outrun storage without bound. At the high-water mark `push` waits for
// the serialized drain before consuming more provider output.
const MAX_BUFFERED_EVENTS = 1_000;

const MERGEABLE_TEXT_DELTA_TYPES: ReadonlySet<string> = new Set([
  "agent.message.delta",
  "agent.reasoning.delta",
]);
const textEncoder = new TextEncoder();

type PlainTextDelta = { text: string; messageId?: string; phase?: string };

/** The plain fragment shape only: any other payload field would not survive a merge. */
function plainTextDelta(event: AppendEventInput): PlainTextDelta | null {
  if (!MERGEABLE_TEXT_DELTA_TYPES.has(event.type)) return null;
  for (const key of Object.keys(event)) {
    if (key !== "type" && key !== "payload") return null;
  }
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.text !== "string") return null;
  for (const key of Object.keys(record)) {
    if (key !== "text" && key !== "messageId" && key !== "phase") return null;
  }
  if (record.messageId !== undefined && typeof record.messageId !== "string") return null;
  if (record.phase !== undefined && typeof record.phase !== "string") return null;
  return record as PlainTextDelta;
}

/**
 * Stores adjacent text fragments of one stream as one delta: same type,
 * message and phase, at most the live stream's 48 KiB bound. The text and the
 * order of every other event are unchanged; only the provider's fragment
 * boundaries are dropped.
 */
export function mergeAdjacentTextDeltas(events: AppendEventInput[]): AppendEventInput[] {
  const merged: AppendEventInput[] = [];
  let run: {
    first: AppendEventInput;
    head: PlainTextDelta;
    parts: string[];
    bytes: number;
  } | null = null;
  const flushRun = () => {
    if (!run) return;
    merged.push(
      run.parts.length === 1
        ? run.first
        : {
            type: run.first.type,
            payload: {
              text: run.parts.join(""),
              ...(run.head.messageId !== undefined ? { messageId: run.head.messageId } : {}),
              ...(run.head.phase !== undefined ? { phase: run.head.phase } : {}),
            },
          },
    );
    run = null;
  };
  for (const event of events) {
    const delta = plainTextDelta(event);
    if (!delta) {
      flushRun();
      merged.push(event);
      continue;
    }
    const bytes = textEncoder.encode(delta.text).byteLength;
    if (
      run &&
      run.first.type === event.type &&
      run.head.messageId === delta.messageId &&
      run.head.phase === delta.phase &&
      run.bytes + bytes <= SESSION_EVENT_COALESCED_TEXT_TARGET_BYTES
    ) {
      run.parts.push(delta.text);
      run.bytes += bytes;
      continue;
    }
    flushRun();
    run = { first: event, head: delta, parts: [delta.text], bytes };
  }
  flushRun();
  return merged;
}

/** Optional metrics seam for the batcher. `onFlush` fires once per flush (on both
 *  success and failure) with the stored event count (after adjacent text deltas
 *  merge) and the flush duration, so the worker can meter batch shape without the
 *  batcher knowing about Observability.
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
  // under the 50-event / TRAILING_FLUSH_MS policy into one appendSessionEvents
  // txn + one publish per flush, instead of one DB round-trip per token, and
  // adjacent text fragments in a flush are stored as one row. Only events that
  // must be delivered promptly stay structural (flush-immediately). PTY bytes
  // stay structural on purpose — an interactive terminal is useless batched
  // behind a window (P4.4).
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
        const events = mergeAdjacentTextDeltas(pending.splice(0, MAX_BATCH_EVENTS));
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
  schedule: typeof setInterval = setInterval,
): ReturnType<typeof setInterval> | null {
  if (!context) {
    return null;
  }
  const timer = schedule(() => {
    context.heartbeat({ ...details, at: new Date().toISOString() });
  }, TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS);
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
  const signal = context.cancellationSignal;
  if (signal.aborted) {
    throw signal.reason;
  }

  // Context.cancelled never settles for a normally completed activity. Racing
  // every token/event read against that lifetime promise leaves one losing
  // Promise reaction attached for every event until the Context itself dies.
  // Use the equivalent Temporal AbortSignal and remove each listener as soon as
  // the iterator wins, so a long stream retains at most its one pending read.
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => settle(() => reject(signal.reason));

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let next: PromiseLike<IteratorResult<T>>;
    try {
      next = iterator.next();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    void Promise.resolve(next).then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
}
