import { getSettings, type Settings } from "@infra-agents/config";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities, type ActivityDependencies } from "./activities";

export type WorkerOptions = {
  settings?: Settings;
  activities?: ReturnType<typeof createActivities>;
  activityDependencies?: ActivityDependencies;
};

export async function createInfraAgentWorker(options: WorkerOptions = {}): Promise<{
  worker: Worker;
  connection: NativeConnection;
}> {
  const settings = options.settings ?? getSettings();
  const connection = await NativeConnection.connect({ address: settings.temporalHost });
  const activities = options.activities ?? createActivities({
    ...options.activityDependencies,
    settings,
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
  const { worker, connection } = await createInfraAgentWorker({ settings });
  console.log(`Infra Agents worker listening on Temporal task queue ${settings.temporalTaskQueue}`);
  try {
    await worker.run();
  } finally {
    await connection.close();
  }
}

if (import.meta.main) {
  await startWorker();
}
