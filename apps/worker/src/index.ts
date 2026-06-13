import { getSettings, retryStartupDependency, startupRetryOptions, type Settings } from "@opengeni/config";
import { createObservability, logStartupDependencyRetry } from "@opengeni/observability";
import { Connection, Client as TemporalClient } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities, type ActivityDependencies } from "./activities";
import type { WakeSessionWorkflowSignal } from "./activities/types";

export type WorkerOptions = {
  settings?: Settings;
  activities?: ReturnType<typeof createActivities>;
  activityDependencies?: ActivityDependencies;
};

export async function createOpenGeniWorker(options: WorkerOptions = {}): Promise<{
  worker: Worker;
  connection: NativeConnection;
}> {
  const settings = options.settings ?? getSettings();
  const observability = options.activityDependencies?.observability ?? createObservability(settings, { component: "worker" });
  const connection = await retryStartupDependency(
    "Temporal",
    () => NativeConnection.connect({ address: settings.temporalHost }),
    {
      ...startupRetryOptions(settings),
      onRetry: (event) => logStartupDependencyRetry(observability, event),
    },
  );
  const activities = options.activities ?? createActivities({
    ...options.activityDependencies,
    settings,
    observability,
  });
  const worker = await Worker.create({
    connection,
    namespace: settings.temporalNamespace,
    taskQueue: settings.temporalTaskQueue,
    workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
    activities,
  });
  return { worker, connection };
}

// A signalWithStart capability so a worker activity can wake a PARENT
// session's workflow when a spawned worker completes (the parent may have
// idled and let its run finish, so a plain signal would not start one).
// Separate from the worker's NativeConnection: the @temporalio/client
// Connection is what exposes workflow.signalWithStart.
export async function createWorkerWorkflowSignaler(settings: Settings): Promise<{ wakeSessionWorkflow: WakeSessionWorkflowSignal; close: () => Promise<void> }> {
  const connection = await Connection.connect({ address: settings.temporalHost });
  const temporal = new TemporalClient({ connection, namespace: settings.temporalNamespace });
  return {
    wakeSessionWorkflow: async ({ accountId, workspaceId, sessionId, workflowId }) => {
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [{ accountId, workspaceId, sessionId }],
        signal: "queueChanged",
      });
    },
    close: async () => {
      await connection.close();
    },
  };
}

export async function startWorker() {
  const settings = getSettings();
  const observability = createObservability(settings, { component: "worker" });
  const signaler = await retryStartupDependency(
    "Temporal client",
    () => createWorkerWorkflowSignaler(settings),
    {
      ...startupRetryOptions(settings),
      onRetry: (event) => logStartupDependencyRetry(observability, event),
    },
  );
  const { worker, connection } = await createOpenGeniWorker({
    settings,
    activityDependencies: { observability, wakeSessionWorkflow: signaler.wakeSessionWorkflow },
  });
  observability.info("OpenGeni worker listening", {
    temporalTaskQueue: settings.temporalTaskQueue,
  });
  try {
    await worker.run();
  } finally {
    await connection.close();
    await signaler.close();
  }
}

if (import.meta.main) {
  await startWorker();
}
