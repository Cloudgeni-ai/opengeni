import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection } from "@temporalio/client";
import { Context } from "@temporalio/activity";
import { NativeConnection, Worker } from "@temporalio/worker";
import { startTestServices, waitFor, type TestServices } from "@opengeni/testing";

const currentWorkflows = new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname;
const legacyWorkflows = new URL(
  "../../apps/worker/test/fixtures/legacy-video-generation-workflow.ts",
  import.meta.url,
).pathname;

describe("versioned video activity queue isolation", () => {
  let services: TestServices | undefined;
  let connection: Connection;
  let nativeConnection: NativeConnection;
  let temporalAddress: string;

  beforeAll(async () => {
    const externalHost = process.env.OPENGENI_TEST_TEMPORAL_HOST?.trim();
    if (!externalHost) services = await startTestServices({ temporal: true });
    temporalAddress = externalHost ?? services!.temporalHost;
    connection = await Connection.connect({ address: temporalAddress });
    nativeConnection = await NativeConnection.connect({ address: temporalAddress });
  }, 120_000);

  afterAll(async () => {
    await nativeConnection?.close();
    await connection?.close();
    await services?.down();
  }, 120_000);

  async function runCase(options: {
    legacy?: boolean;
    enabled?: boolean;
    continueAsNew?: boolean;
    oldControlPoller?: boolean;
  }) {
    const queue = `video-routing-${crypto.randomUUID()}`;
    const routes: string[] = [];
    const handler = (route: string) => async () => {
      routes.push(route);
      return routes.length === 1
        ? { action: "wait" as const, delayMs: 1 }
        : { action: "terminal" as const };
    };
    // Separate clients model separate old/new hosts: pinned Core disallows
    // overlapping worker registrations on one client in the same process.
    const oldConnection = options.oldControlPoller
      ? await NativeConnection.connect({ address: temporalAddress })
      : undefined;
    const workers: Worker[] = [];
    const runs: Promise<void>[] = [];
    const startWorker = async (settings: Parameters<typeof Worker.create>[0]) => {
      const worker = await Worker.create(settings);
      workers.push(worker);
      runs.push(worker.run());
    };
    try {
      await startWorker({
        connection: nativeConnection,
        taskQueue: queue,
        workflowsPath: options.legacy ? legacyWorkflows : currentWorkflows,
        activities: options.legacy ? {} : { reconcileVideoGenerationOperation: handler("control") },
      });
      await startWorker({
        connection: nativeConnection,
        taskQueue: `${queue}-turns`,
        activities: { reconcileVideoGenerationOperation: handler("turns") },
      });
      if (oldConnection) {
        await startWorker({
          connection: oldConnection,
          taskQueue: queue,
          workflowsPath: legacyWorkflows,
        });
      }
      const client = new Client({ connection });
      const handle = await client.workflow.start("videoGenerationWorkflow", {
        taskQueue: queue,
        workflowId: `video-routing-proof-${crypto.randomUUID()}`,
        args: [
          {
            accountId: crypto.randomUUID(),
            workspaceId: crypto.randomUUID(),
            operationId: crypto.randomUUID(),
            baseTaskQueue: queue,
            ...(options.enabled === undefined
              ? {}
              : { controlQueueRoutingEnabled: options.enabled }),
            ...(options.continueAsNew ? { iterations: 99 } : {}),
          },
        ],
      });
      await handle.result();
      expect(routes).toEqual(
        options.enabled && !options.legacy ? ["control", "control"] : ["turns", "turns"],
      );
      const history = await handle.fetchHistory();
      const scheduled =
        history.events?.filter((event) => event.activityTaskScheduledEventAttributes) ?? [];
      expect(scheduled.length).toBeGreaterThan(0);
      for (const event of scheduled) {
        const activity = event.activityTaskScheduledEventAttributes!;
        expect(activity.activityType?.name).toBe("reconcileVideoGenerationOperation");
        expect(activity.taskQueue?.name).toBe(
          options.enabled && !options.legacy ? queue : `${queue}-turns`,
        );
        expect(activity.retryPolicy?.maximumAttempts).toBe(3);
      }
      const markers =
        history.events?.filter(
          (event) => event.markerRecordedEventAttributes?.markerName === "core_patch",
        ) ?? [];
      expect(markers.length > 0).toBe(options.enabled === true && !options.legacy);
      await Worker.runReplayHistory(
        { workflowsPath: currentWorkflows },
        history,
        handle.workflowId,
      );
    } finally {
      workers.forEach((worker) => worker.shutdown());
      try {
        await Promise.all(runs);
      } finally {
        await oldConnection?.close();
      }
    }
  }

  test(
    "historical turn-queue dispatches replay without a new marker or duplicate effect",
    () => runCase({ legacy: true }),
    120_000,
  );
  test(
    "new opted-in dispatches use control with unchanged retry behavior and replay",
    () => runCase({ enabled: true }),
    120_000,
  );
  test(
    "replays a missing marker at the dispatch boundary even with a true input",
    () => runCase({ legacy: true, enabled: true }),
    120_000,
  );
  test(
    "default-off phase is safe beside an old control poller with no video registration",
    () => runCase({ enabled: false, oldControlPoller: true }),
    120_000,
  );
  test(
    "default-off routing survives continue-as-new on the legacy turn queue",
    () => runCase({ continueAsNew: true }),
    120_000,
  );
  test(
    "opted-in routing survives continue-as-new on the control queue",
    () => runCase({ enabled: true, continueAsNew: true }),
    120_000,
  );

  for (const enabled of [undefined, true]) {
    test(`already scheduled legacy retry survives worker upgrade (${enabled ? "opted-in" : "legacy"})`, async () => {
      const queue = `video-retry-upgrade-${crypto.randomUUID()}`;
      const routes: string[] = [];
      const attempts: number[] = [];
      const turns = await Worker.create({
        connection: nativeConnection,
        taskQueue: `${queue}-turns`,
        activities: {
          reconcileVideoGenerationOperation: async () => {
            routes.push("turns");
            attempts.push(Context.current().info.attempt);
            if (routes.length === 1) throw new Error("deterministic legacy retry fixture");
            return routes.length === 2 ? { action: "wait", delayMs: 50 } : { action: "terminal" };
          },
        },
      });
      const legacy = await Worker.create({
        connection: nativeConnection,
        taskQueue: queue,
        workflowsPath: legacyWorkflows,
      });
      const legacyRun = legacy.run();
      const turnRun = turns.run();
      let legacyStopped = false;
      let upgraded: Worker | undefined;
      let upgradedRun: Promise<void> | undefined;
      try {
        const handle = await new Client({ connection }).workflow.start("videoGenerationWorkflow", {
          taskQueue: queue,
          workflowId: `video-retry-upgrade-proof-${crypto.randomUUID()}`,
          args: [
            {
              accountId: crypto.randomUUID(),
              workspaceId: crypto.randomUUID(),
              operationId: crypto.randomUUID(),
              baseTaskQueue: queue,
              ...(enabled ? { controlQueueRoutingEnabled: true } : {}),
            },
          ],
        });
        await waitFor(
          async () => {
            const metadata = await connection.workflowService.describeWorkflowExecution({
              namespace: "default",
              execution: { workflowId: handle.workflowId },
            });
            return (
              metadata.pendingActivities?.some((activity) => (activity.attempt ?? 0) >= 2) ?? false
            );
          },
          { timeoutMs: 10_000 },
        );
        legacy.shutdown();
        await legacyRun;
        legacyStopped = true;
        upgraded = await Worker.create({
          connection: nativeConnection,
          taskQueue: queue,
          workflowsPath: currentWorkflows,
          activities: {
            reconcileVideoGenerationOperation: async () => {
              routes.push("control");
              attempts.push(Context.current().info.attempt);
              return { action: "terminal" };
            },
          },
        });
        upgradedRun = upgraded.run();
        await handle.result();
        expect(routes).toEqual(
          enabled ? ["turns", "turns", "control"] : ["turns", "turns", "turns"],
        );
        expect(attempts).toEqual([1, 2, 1]);
        const history = await handle.fetchHistory();
        const queues = history.events?.flatMap((event) =>
          event.activityTaskScheduledEventAttributes
            ? [event.activityTaskScheduledEventAttributes.taskQueue?.name]
            : [],
        );
        expect(queues).toEqual([`${queue}-turns`, enabled ? queue : `${queue}-turns`]);
        await Worker.runReplayHistory(
          { workflowsPath: currentWorkflows },
          history,
          handle.workflowId,
        );
      } finally {
        if (!legacyStopped) legacy.shutdown();
        upgraded?.shutdown();
        turns.shutdown();
        await Promise.all([legacyRun, turnRun, upgradedRun]);
      }
    }, 120_000);
  }
});
