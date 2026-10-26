import type { Observability } from "@opengeni/observability";
import type { WorkerLifecycleState } from "./http";

export async function constructWithOwnedConnection<Connection, Result>(
  connect: () => Promise<Connection>,
  construct: (connection: Connection) => Promise<Result>,
  close: (connection: Connection) => Promise<void>,
): Promise<Result> {
  const connection = await connect();
  try {
    return await construct(connection);
  } catch (error) {
    await close(connection).catch(() => undefined);
    throw error;
  }
}

export type WorkerRunTarget = {
  run(): Promise<void>;
  shutdown(): void;
};

/** One process may poll several disjoint Temporal queues, but it still has one
 * host lifecycle. Start and stop every poller as a unit; a failed poller drains
 * its siblings and preserves the original failure. */
export function combineWorkerRunTargets(targets: readonly WorkerRunTarget[]): WorkerRunTarget {
  if (targets.length === 0) {
    throw new Error("a worker service requires at least one Temporal poller");
  }
  let runPromise: Promise<void> | undefined;
  const shutdown = (): void => {
    let firstError: unknown;
    for (const target of targets) {
      try {
        target.shutdown();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  };
  return {
    run: () => {
      runPromise ??= (async () => {
        const runs = targets.map((target) => {
          try {
            return target.run();
          } catch (error) {
            return Promise.reject(error);
          }
        });
        try {
          await Promise.all(runs);
        } catch (error) {
          try {
            shutdown();
          } catch {
            // Preserve the poller failure. Every sibling still received its
            // shutdown request even when one request itself failed.
          }
          await Promise.allSettled(runs);
          throw error;
        }
      })();
      return runPromise;
    },
    shutdown,
  };
}

export type WorkerServiceLifecycle = {
  state(): WorkerLifecycleState;
  run(): Promise<void>;
  drain(reason?: string): boolean;
  close(): Promise<void>;
};

/** Host intent survives an SDK finally error that masks its force-stop error.
 * This is not physical quiescence: the standalone process must still exit. */
export class WorkerForceStoppedError extends Error {
  readonly name = "WorkerForceStoppedError";
  constructor(
    readonly reason: "cleanup_containment" | "shutdown_deadline",
    cause: unknown,
  ) {
    super(`Worker deliberately force-stopped: ${reason}`, { cause });
  }
}

export function createWorkerServiceLifecycle(input: {
  role: "control" | "turn";
  worker: WorkerRunTarget;
  observability: Observability;
  closeOwnedResources: () => Promise<void>;
  onReady?: () => void;
  onDrainStarted?: () => void;
  cleanupContainmentRequested?: () => boolean;
  now?: () => number;
}): WorkerServiceLifecycle {
  const now = input.now ?? (() => performance.now());
  let state: WorkerLifecycleState = "starting";
  let runPromise: Promise<void> | undefined;
  let resourcesClosed: Promise<void> | undefined;
  let drainStartedAt: number | undefined;
  // Shutdown phase markers. Each says how long after the drain request the
  // phase ended, so a slow rollout shows whether Temporal (natural drain,
  // checkpoint, force stop) or resource teardown held the process.
  const shutdownPhase = (message: string, outcome: string) =>
    safeLifecycleLog(() =>
      input.observability.info(message, {
        surface: "worker_shutdown",
        outcome,
        ...(drainStartedAt === undefined
          ? {}
          : { durationMs: Math.max(0, Math.round(now() - drainStartedAt)) }),
      }),
    );
  const closeOwnedResources = () => {
    resourcesClosed ??= input
      .closeOwnedResources()
      .finally(() => shutdownPhase("Opengeni worker resources closed", "closed"));
    return resourcesClosed;
  };

  const lifecycle: WorkerServiceLifecycle = {
    state: () => state,
    run: () => {
      if (!runPromise && state === "draining") {
        runPromise = (async () => {
          state = "stopped";
          await closeOwnedResources();
        })();
        return runPromise;
      }
      if (!runPromise && (state === "stopped" || state === "failed")) {
        return Promise.reject(new Error(`cannot run a worker service that is ${state}`));
      }
      runPromise ??= (async () => {
        if (state === "starting") {
          state = "ready";
        }
        input.onReady?.();
        try {
          await input.worker.run();
          state = "stopped";
          shutdownPhase("Opengeni worker stopped polling; in-flight activities settled", "stopped");
        } catch (error) {
          state = "failed";
          const forceStopReason = input.cleanupContainmentRequested?.()
            ? "cleanup_containment"
            : error instanceof Error && error.name === "GracefulShutdownPeriodExpiredError"
              ? "shutdown_deadline"
              : null;
          shutdownPhase(
            "Opengeni worker polling ended before orderly shutdown completed",
            // The SDK force time expired with activities still running. Their
            // JavaScript may continue; the host must exit the process.
            forceStopReason ? "force_stopped" : "failed",
          );
          if (forceStopReason) throw new WorkerForceStoppedError(forceStopReason, error);
          throw error;
        } finally {
          await closeOwnedResources();
        }
      })();
      return runPromise;
    },
    drain: (_reason = "host request") => {
      if (state === "draining" || state === "stopped" || state === "failed") {
        return true;
      }
      const previousState = state;
      drainStartedAt = now();
      safeLifecycleLog(() =>
        input.observability.info("Opengeni worker draining (graceful shutdown)", {
          role: input.role,
          errorClass: "WorkerLifecycleOperation",
          errorCode: "worker_draining",
          origin: "worker-lifecycle",
        }),
      );
      state = "draining";
      try {
        input.worker.shutdown();
        safeLifecycleLog(() => input.onDrainStarted?.());
        return true;
      } catch {
        state = previousState;
        drainStartedAt = undefined;
        safeLifecycleLog(() =>
          input.observability.warn("worker shutdown request failed", {
            errorClass: "WorkerLifecycleOperationError",
            errorCode: "worker_shutdown_request_failed",
            origin: "worker-lifecycle",
          }),
        );
        return false;
      }
    },
    close: async () => {
      if (!lifecycle.drain("service close")) {
        throw new Error("worker shutdown request failed");
      }
      if (runPromise) {
        await runPromise.catch(() => undefined);
      } else {
        state = "stopped";
        await closeOwnedResources();
      }
    },
  };

  return lifecycle;
}

function safeLifecycleLog(log: () => void): void {
  try {
    log();
  } catch {
    // Telemetry cannot change worker lifecycle state or shutdown delivery.
  }
}

/** A cleanup stall first drains peers through WORKER_SHUTDOWN. The standalone
 * process owns the final exit, because Temporal cannot kill JavaScript writers.
 * Embedded hosts may supply their own termination policy at this same edge. */
export function createWorkerCleanupContainment(input: {
  drain: () => boolean;
  terminate?: () => void;
  observability: Observability;
  timeoutMs?: number;
}) {
  let requested = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    requested: () => requested,
    request() {
      if (requested || finished) return;
      requested = true;
      if (input.terminate) {
        timer = setTimeout(() => {
          safeLifecycleLog(() =>
            input.observability.error("worker cleanup drain exhausted; terminating host", {
              surface: "worker_shutdown",
              outcome: "force_stopped",
              reason: "cleanup_containment",
              errorClass: "WorkerLifecycleOperationError",
              errorCode: "worker_cleanup_drain_exhausted",
              origin: "worker-lifecycle",
            }),
          );
          input.terminate?.();
        }, input.timeoutMs ?? 100_000);
        timer.unref?.();
      }
      let accepted = false;
      try {
        accepted = input.drain();
      } catch {
        /* The host backstop remains armed. */
      }
      if (!accepted)
        safeLifecycleLog(() =>
          input.observability.error("worker cleanup drain request failed", {
            errorClass: "WorkerLifecycleOperationError",
            errorCode: "worker_shutdown_request_failed",
            origin: "worker-lifecycle",
          }),
        );
    },
    finished() {
      // Call only after Worker.run resolves. ForceShutdownError does not prove
      // its activity promises stopped, so rejection must retain the backstop.
      finished = true;
      clearTimeout(timer);
    },
  };
}
