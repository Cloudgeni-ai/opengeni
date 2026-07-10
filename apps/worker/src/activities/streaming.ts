import type { SessionEventType } from "@opengeni/contracts";
import type { AppendEventInput } from "@opengeni/db";
import { Context } from "@temporalio/activity";

// Trailing-flush window. A burst of coalesced deltas followed by model silence
// must not sit in `pending` unbounded — without a timer, flush fires only on
// the NEXT push. Matched to the 33ms coalesce window so the client-visible
// latency added by batching is bounded to ~one window (imperceptible, and far
// cheaper than the per-delta DB round-trip it replaces).
const TRAILING_FLUSH_MS = 33;

export function createRuntimeBatcher(flushEvents: (events: AppendEventInput[]) => Promise<void>) {
  let pending: AppendEventInput[] = [];
  let lastFlush = Date.now();
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  // Serializes flushEvents: each flush chains after the in-flight one so two
  // flushEvents never overlap and the DB-assigned sequence order matches push
  // order (the ordering invariant). A rejected flush resolves the gate (a
  // single failed flush must not poison later flushes) while still rejecting
  // the caller that awaited it.
  let inFlight: Promise<void> | null = null;
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
    "session.requiresAction",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
  ]);
  return {
    push: async (event: { type: SessionEventType; payload: unknown }) => {
      // Append BEFORE the structural check so a structural event's flush always
      // carries any pending deltas in order (same flush, order preserved).
      pending.push({ type: event.type, payload: event.payload });
      const elapsed = Date.now() - lastFlush;
      if (pending.length >= 50 || elapsed >= 33 || structural.has(event.type)) {
        await flush();
      } else {
        armTrailingTimer();
      }
    },
    flush,
  };

  function armTrailingTimer() {
    if (trailingTimer !== null) {
      return;
    }
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      // Best-effort trailing flush: any error re-surfaces on the next awaited
      // push or the turn-end flush, so swallow here (a timer has no awaiter and
      // an unhandled rejection would crash the worker).
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

  function flush(): Promise<void> {
    // A flush is in-flight: wait for it, THEN drain whatever is pending now.
    // Never start a second flushEvents concurrently. `() => flush()` on both
    // settle paths so a failed in-flight flush still lets the queue drain.
    if (inFlight) {
      return inFlight.then(
        () => flush(),
        () => flush(),
      );
    }
    if (pending.length === 0) {
      return Promise.resolve();
    }
    clearTrailingTimer();
    const events = pending;
    pending = [];
    lastFlush = Date.now();
    inFlight = flushEvents(events).finally(() => {
      inFlight = null;
    });
    return inFlight;
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
