import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { getSettings, temporalConnectionOptions } from "@opengeni/config";

type PlacementInput = {
  sequence: number;
  enqueuedAtMs: number;
  delayMs: number;
  activityScheduledAtMs?: number;
};

type PlacementResult = {
  workerId: string;
  sequence: number;
  startedAtMs: number;
  apiToActivityStartMs: number;
  eligibleQueueWaitMs: number;
};

Runtime.install({ logger: new DefaultLogger("ERROR") });

if (process.argv.includes("--activity-child")) {
  await runActivityChild();
  process.exit(0);
}

const samples = positiveInteger(flag("--samples") ?? "3", "--samples");
const burst = positiveInteger(flag("--burst") ?? "20", "--burst");
const delayMs = positiveInteger(flag("--delay-ms") ?? "200", "--delay-ms");
const settings = getSettings();
const concurrency = positiveInteger(
  flag("--concurrency") ?? String(settings.turnWorkerMaxConcurrentTurns),
  "--concurrency",
);
const addWorker = booleanFlag(flag("--add-worker") ?? "true", "--add-worker");
const nativeConnection = await NativeConnection.connect(temporalConnectionOptions(settings));
const clientConnection = await Connection.connect(temporalConnectionOptions(settings));
const client = new Client({ connection: clientConnection, namespace: settings.temporalNamespace });

try {
  const results = [];
  for (let sample = 1; sample <= samples; sample += 1) {
    results.push(await runSample(sample));
  }
  console.log(JSON.stringify({ samples: results }, null, 2));
} finally {
  await Promise.all([nativeConnection.close(), clientConnection.close()]);
}

async function runSample(sample: number) {
  const suffix = `${process.pid}-${Date.now()}-${sample}`;
  const taskQueue = `opengeni-turn-placement-${suffix}`;
  const controlId = `placement-control-${suffix}`;
  const worker1Id = `placement-turn-1-${suffix}`;
  const worker2Id = `placement-turn-2-${suffix}`;
  const workflowsPath = fileURLToPath(
    new URL("../apps/worker/test/fixtures/turn-worker-placement-workflows.ts", import.meta.url),
  );
  const control = await Worker.create({
    connection: nativeConnection,
    namespace: settings.temporalNamespace,
    taskQueue,
    identity: controlId,
    workflowsPath,
    maxConcurrentActivityTaskExecutions: 1,
  });
  const worker1 = spawnActivityWorker(taskQueue, worker1Id, concurrency);
  const controlRun = control.run();
  let worker2: ReturnType<typeof spawnActivityWorker> | null = null;
  let receipt: object | null = null;
  let cleanupFailure: Error | null = null;
  try {
    await Promise.all([
      waitForPoller(taskQueue, 1, controlId),
      waitForPoller(taskQueue, 2, worker1Id),
    ]);
    const enqueuedAtMs = Date.now();
    const inputs = Array.from(
      { length: burst },
      (_, index) => ({ sequence: index, enqueuedAtMs, delayMs }) satisfies PlacementInput,
    );
    const execution = client.workflow.execute("placementBurstWorkflow", {
      taskQueue,
      workflowId: `placement-burst-${suffix}`,
      args: [inputs],
    }) as Promise<PlacementResult[]>;
    let worker2CreatedAtMs: number | null = null;
    let worker2PollerAtMs: number | null = null;
    if (addWorker) {
      await Bun.sleep(Math.min(100, Math.max(20, Math.floor(delayMs / 2))));
      worker2CreatedAtMs = Date.now();
      worker2 = spawnActivityWorker(taskQueue, worker2Id, concurrency);
      worker2PollerAtMs = await waitForPoller(taskQueue, 2, worker2Id);
    }
    const completed = await execution;
    const worker2Results = completed.filter((result) => result.workerId === worker2Id);
    const apiWaits = completed
      .map((result) => result.apiToActivityStartMs)
      .toSorted((a, b) => a - b);
    const eligibleWaits = completed
      .map((result) => result.eligibleQueueWaitMs)
      .toSorted((a, b) => a - b);
    const worker2FirstPickupAtMs = worker2Results.length
      ? Math.min(...worker2Results.map((result) => result.startedAtMs))
      : null;
    receipt = {
      sample,
      burst,
      delayMs,
      concurrency,
      worker2ReadyMs:
        worker2PollerAtMs !== null && worker2CreatedAtMs !== null
          ? worker2PollerAtMs - worker2CreatedAtMs
          : null,
      worker2FirstPickupAfterSpawnMs:
        worker2FirstPickupAtMs !== null && worker2CreatedAtMs !== null
          ? worker2FirstPickupAtMs - worker2CreatedAtMs
          : null,
      worker2FirstPickupRelativeToObservedPollerMs:
        worker2FirstPickupAtMs !== null && worker2PollerAtMs !== null
          ? worker2FirstPickupAtMs - worker2PollerAtMs
          : null,
      assignments: {
        worker1: completed.filter((result) => result.workerId === worker1Id).length,
        worker2: worker2Results.length,
      },
      apiToActivityStartMs: {
        min: apiWaits[0],
        median: apiWaits[Math.floor(apiWaits.length / 2)],
        max: apiWaits.at(-1),
      },
      eligibleQueueWaitMs: {
        min: eligibleWaits[0],
        median: eligibleWaits[Math.floor(eligibleWaits.length / 2)],
        max: eligibleWaits.at(-1),
      },
      exactSequences: completed
        .map((result) => result.sequence)
        .toSorted((a, b) => a - b)
        .every((sequence, index) => sequence === index),
    };
  } finally {
    control.shutdown();
    worker1.kill("SIGTERM");
    worker2?.kill("SIGTERM");
    const [controlResult, worker1Result, worker2Result] = await Promise.all([
      controlRun,
      worker1.exited,
      worker2?.exited,
    ]);
    void controlResult;
    if (worker1Result !== 0 || (worker2Result !== undefined && worker2Result !== 0)) {
      cleanupFailure = new Error(
        `placement activity worker did not drain cleanly: ${worker1Result}/${worker2Result ?? "n/a"}`,
      );
    }
  }
  if (cleanupFailure) throw cleanupFailure;
  if (!receipt) throw new Error("placement sample completed without a receipt");
  return receipt;
}

function spawnActivityWorker(taskQueue: string, identity: string, maximumConcurrency: number) {
  return Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      "--activity-child",
      "--task-queue",
      taskQueue,
      "--identity",
      identity,
      "--concurrency",
      String(maximumConcurrency),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
}

async function runActivityChild(): Promise<void> {
  const taskQueue = requiredFlag("--task-queue");
  const identity = requiredFlag("--identity");
  const maximumConcurrency = positiveInteger(requiredFlag("--concurrency"), "--concurrency");
  const childSettings = getSettings();
  const connection = await NativeConnection.connect(temporalConnectionOptions(childSettings));
  const worker = await Worker.create({
    connection,
    namespace: childSettings.temporalNamespace,
    taskQueue,
    identity,
    activities: {
      placementActivity: async (input: PlacementInput): Promise<PlacementResult> => {
        const startedAtMs = Date.now();
        if (input.activityScheduledAtMs === undefined) {
          throw new Error("placement activity is missing its workflow schedule timestamp");
        }
        await Bun.sleep(input.delayMs);
        return {
          workerId: identity,
          sequence: input.sequence,
          startedAtMs,
          apiToActivityStartMs: startedAtMs - input.enqueuedAtMs,
          eligibleQueueWaitMs: startedAtMs - input.activityScheduledAtMs,
        };
      },
    },
    maxConcurrentActivityTaskExecutions: maximumConcurrency,
  });
  const stop = () => worker.shutdown();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await worker.run();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await connection.close();
  }
}

async function waitForPoller(taskQueue: string, taskQueueType: 1 | 2, identity: string) {
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < 10_000) {
    const response = await nativeConnection.workflowService.describeTaskQueue({
      namespace: settings.temporalNamespace,
      taskQueue: { name: taskQueue },
      taskQueueType,
      reportStats: true,
    });
    if (response.pollers?.some((poller) => poller.identity === identity)) return Date.now();
    await Bun.sleep(10);
  }
  throw new Error(`Temporal did not register ${identity} on ${taskQueue}`);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredFlag(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function booleanFlag(raw: string, name: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}
