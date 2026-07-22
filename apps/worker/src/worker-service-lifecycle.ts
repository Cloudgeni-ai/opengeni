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

export type WorkerServiceLifecycle = {
  state(): WorkerLifecycleState;
  run(): Promise<void>;
  drain(reason?: string): void;
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
    drain: (reason = "host request") => {
      if (state === "draining" || state === "stopped" || state === "failed") {
        return;
      }
      state = "draining";
      input.observability.info("OpenGeni worker draining (graceful shutdown)", {
        role: input.role,
        reason,
      });
      try {
        input.worker.shutdown();
      } catch (error) {
        input.observability.warn("worker shutdown request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    close: async () => {
      lifecycle.drain("service close");
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
