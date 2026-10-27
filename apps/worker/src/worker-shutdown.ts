import {
  DEFAULT_TURN_WORKER_SHUTDOWN_FORCE_MS,
  DEFAULT_TURN_WORKER_SHUTDOWN_GRACE_MS,
  type Settings,
} from "@opengeni/config";
import { WorkerForceStoppedError } from "./worker-service-lifecycle";

/** Control workers keep their original short natural window. Their activities
 * are short DB/Temporal operations; a drain must not hold workflow tasks. */
export const CONTROL_WORKER_SHUTDOWN_GRACE_MS = 5_000;
export const CONTROL_WORKER_SHUTDOWN_FORCE_MS = 100_000;
/** Least time between WORKER_SHUTDOWN cancellation and the SDK force stop, so
 * a cancelled turn can checkpoint and close its attempt as recoverable. */
export const WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS = 10_000;
/** The standalone process exits at most this long after the SDK force time. */
export const WORKER_PROCESS_EXIT_MARGIN_MS = 10_000;
/** Each owned resource gets this long to close before the process exits. */
export const WORKER_RESOURCE_CLOSE_BUDGET_MS = 5_000;

export type WorkerShutdownTiming = {
  /** Natural completion window after polling stops (Temporal shutdownGraceTime). */
  readonly graceMs: number;
  /** SDK force-stop ceiling measured from the shutdown request. */
  readonly forceMs: number;
  /** Latest exit of a standalone process after a shutdown signal. */
  readonly processExitDeadlineMs: number;
  /** The configured grace when it had to shrink to keep the checkpoint window. */
  readonly configuredGraceMs?: number;
};

function wholeMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Shutdown sequencing for one worker role. A turn worker drains in-flight turns
 * naturally for its grace, then Temporal cancels the remainder with
 * WORKER_SHUTDOWN (the recoverable checkpoint path), then force-stops. The
 * grace never eats the checkpoint window: an inconsistent configuration keeps
 * the force time (which must fit the pod's termination grace) and shortens the
 * natural window instead of failing worker startup.
 */
export function resolveWorkerShutdownTiming(
  role: "control" | "turn",
  settings: Partial<Pick<Settings, "turnWorkerShutdownGraceMs" | "turnWorkerShutdownForceMs">>,
): WorkerShutdownTiming {
  if (role === "control") {
    return {
      graceMs: CONTROL_WORKER_SHUTDOWN_GRACE_MS,
      forceMs: CONTROL_WORKER_SHUTDOWN_FORCE_MS,
      processExitDeadlineMs: CONTROL_WORKER_SHUTDOWN_FORCE_MS + WORKER_PROCESS_EXIT_MARGIN_MS,
    };
  }
  const forceMs = Math.max(
    WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS,
    wholeMs(settings.turnWorkerShutdownForceMs, DEFAULT_TURN_WORKER_SHUTDOWN_FORCE_MS),
  );
  const configuredGraceMs = wholeMs(
    settings.turnWorkerShutdownGraceMs,
    DEFAULT_TURN_WORKER_SHUTDOWN_GRACE_MS,
  );
  const graceMs = Math.min(configuredGraceMs, forceMs - WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS);
  return {
    graceMs,
    forceMs,
    processExitDeadlineMs: forceMs + WORKER_PROCESS_EXIT_MARGIN_MS,
    ...(graceMs === configuredGraceMs ? {} : { configuredGraceMs }),
  };
}

/** Temporal Worker options for the resolved sequencing. */
export function temporalWorkerShutdownOptions(timing: WorkerShutdownTiming) {
  return {
    shutdownGraceTime: timing.graceMs,
    shutdownForceTime: timing.forceMs,
  } as const;
}

/**
 * Wait for a resource close without letting it hold a terminating process.
 * Resolves "closed", "failed" or "timed_out"; never rejects.
 */
export async function closeWithinBudget(
  close: () => Promise<unknown> | unknown,
  budgetMs: number = WORKER_RESOURCE_CLOSE_BUDGET_MS,
): Promise<"closed" | "failed" | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(close)
        .then(
          () => "closed" as const,
          () => "failed" as const,
        ),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), budgetMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Standalone-process backstop armed when a shutdown signal arrives. The SDK
 * force time bounds Temporal, but neither a stuck owned-resource close nor a
 * leftover referenced handle may keep a terminating pod alive until SIGKILL.
 * The timer is unref'd, so it never keeps an otherwise finished process alive.
 */
export function armWorkerProcessExitDeadline(input: {
  deadlineMs: number;
  onExpired: () => void;
}): () => void {
  const timer = setTimeout(() => {
    try {
      input.onExpired();
    } catch {
      // The caller owns the exit; a failing diagnostic cannot cancel it.
    }
  }, input.deadlineMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * The standalone worker entry point. Once `start` has settled, every owned
 * resource has closed (or exhausted its close budget), so exit explicitly
 * instead of waiting for the event loop to empty. A third-party handle left
 * referenced after the drain, such as a socket or timer opened for a turn,
 * otherwise keeps a terminating pod alive until the kubelet's SIGKILL. In
 * staging, old turn pods whose last turn held a sandbox lease stayed
 * Terminating until the 120-second kill (exit 137) although every activity had
 * already finished; the pod whose turns held none exited at once.
 *
 * `bun --watch` also keeps its supervisor alive after the application consumes
 * SIGINT; an interrupted run exits 0 so a later file edit cannot resurrect a
 * stopped process as a duplicate worker with stale env/code.
 */
export async function runWorkerProcessEntrypoint(
  start: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  let interrupted = false;
  const markInterrupted = () => {
    interrupted = true;
  };
  process.once("SIGINT", markInterrupted);
  let exitCode = 0;
  try {
    await start();
  } catch (error) {
    console.error(
      error instanceof WorkerForceStoppedError ? "[worker] force stop" : "[worker] fatal",
      error,
    );
    exitCode = 1;
  } finally {
    process.off("SIGINT", markInterrupted);
  }
  exit(interrupted ? 0 : exitCode);
}
