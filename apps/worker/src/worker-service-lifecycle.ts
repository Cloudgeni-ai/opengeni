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

export function createWorkerServiceLifecycle(input: {
  role: "control" | "turn";
  worker: WorkerRunTarget;
  observability: Observability;
  closeOwnedResources: () => Promise<void>;
  onReady?: () => void;
}): WorkerServiceLifecycle {
  let state: WorkerLifecycleState = "starting";
  let runPromise: Promise<void> | undefined;
  let resourcesClosed: Promise<void> | undefined;
  const closeOwnedResources = () => {
    resourcesClosed ??= input.closeOwnedResources();
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
        } catch (error) {
          state = "failed";
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
      safeLifecycleLog(() =>
        input.observability.info("OpenGeni worker draining (graceful shutdown)", {
          role: input.role,
          errorClass: "WorkerLifecycleOperation",
          errorCode: "worker_draining",
          origin: "worker-lifecycle",
        }),
      );
      state = "draining";
      try {
        input.worker.shutdown();
        return true;
      } catch {
        state = previousState;
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
    request() {
      if (requested || finished) return;
      requested = true;
      if (input.terminate) {
        timer = setTimeout(() => {
          safeLifecycleLog(() =>
            input.observability.error("worker cleanup drain exhausted; terminating host", {
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
