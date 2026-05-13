import { getSettings, retryStartupDependency, startupRetryOptions, type Settings } from "@opengeni/config";
import { createObservability, type Observability } from "@opengeni/observability";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities, type ActivityDependencies } from "./activities";

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
      onRetry: (event) => startupRetryLogger(event, observability),
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

export async function startWorker() {
  const settings = getSettings();
  const observability = createObservability(settings, { component: "worker" });
  const { worker, connection } = await createOpenGeniWorker({ settings, activityDependencies: { observability } });
  observability.info("OpenGeni worker listening", {
    temporalTaskQueue: settings.temporalTaskQueue,
  });
  try {
    await worker.run();
  } finally {
    await connection.close();
  }
}

if (import.meta.main) {
  await startWorker();
}

function startupRetryLogger(event: { label: string; attempt: number; attempts: number; delayMs: number; error: unknown }, observability: Observability) {
  const message = event.error instanceof Error ? event.error.message : String(event.error);
  observability.warn("Startup dependency connection failed; retrying", {
    dependency: event.label,
    attempt: event.attempt,
    attempts: event.attempts,
    delayMs: event.delayMs,
    error: message,
  });
}
