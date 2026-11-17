import { isWorkerShutdownCancellation } from "./errors";

/**
 * How long a turn may keep unwinding on its own after WORKER_SHUTDOWN before
 * its run is abandoned for the handoff. A cooperative turn unwinds well inside
 * this; the rest of the shutdown checkpoint window (at least
 * WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS) is left for settling and
 * finalizing the attempt.
 */
export const WORKER_SHUTDOWN_TURN_UNWIND_MS = 3_000;

/**
 * Await a turn's run, but never past a worker shutdown. When Temporal cancels
 * the activity with WORKER_SHUTDOWN, the run gets `unwindMs` to observe the
 * cancellation and unwind itself. A run still parked after that, in a wait
 * that never observes cancellation (an unanswered machine or provider call),
 * is abandoned: this rejects with the shutdown cancellation, so the caller
 * settles and finalizes the attempt as a worker_shutdown handoff before the
 * worker is force-stopped. The abandoned run is fenced by the closed attempt
 * and ends with the process.
 *
 * Other cancellations keep their own semantics: the worker stays up, so the
 * run is awaited until it unwinds.
 */
export async function untilWorkerShutdown<T>(
  signal: AbortSignal | undefined,
  run: Promise<T>,
  unwindMs: number = WORKER_SHUTDOWN_TURN_UNWIND_MS,
): Promise<T> {
  if (!signal) return await run;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const abandoned = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (!isWorkerShutdownCancellation(signal.reason)) return;
      timer = setTimeout(() => reject(signal.reason), unwindMs);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run, abandoned]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
    // An abandoned run may still settle later; never let that surface as an
    // unhandled rejection.
    run.catch(() => undefined);
  }
}
