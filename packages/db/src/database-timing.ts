import { AsyncLocalStorage } from "node:async_hooks";

export type DatabaseTimingStage =
  | "transaction_admission"
  | "savepoint_admission"
  | "rls_setup"
  | "scoped_callback";
export type DatabaseTimingObservation = {
  stage: DatabaseTimingStage;
  outcome: "completed" | "failed";
  durationMs: number;
};
export type DatabaseTimingObserver = (observation: DatabaseTimingObservation) => void;

const timingObserver = new AsyncLocalStorage<DatabaseTimingObserver>();

/** Opt-in, async-local diagnostics only; no identity or query payload is retained. */
export function withDatabaseTimingObserver<T>(
  observer: DatabaseTimingObserver,
  work: () => Promise<T>,
): Promise<T> {
  return timingObserver.run(observer, work);
}

export function startDatabaseTiming(
  stage: DatabaseTimingStage,
): (outcome: DatabaseTimingObservation["outcome"]) => void {
  const observer = timingObserver.getStore();
  if (!observer) return () => undefined;
  const started = performance.now();
  let finished = false;
  return (outcome) => {
    if (finished) return;
    finished = true;
    try {
      // Do not await observers or let rejected async observers escape either.
      const result = observer({ stage, outcome, durationMs: performance.now() - started });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Diagnostics must not replace database results or the original error.
    }
  };
}
