import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  enqueueSessionWorkflowWake,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { startTestServices, testSettings, waitFor, type TestServices } from "@opengeni/testing";
import {
  KNOWLEDGE_INDEXING_PERIOD_MS,
  KNOWLEDGE_INDEXING_SCHEDULE_ID,
  SANDBOX_REAPER_SCHEDULE_ID,
  SITE_AUTH_MAINTENANCE_PERIOD_MS,
  SITE_AUTH_MAINTENANCE_SCHEDULE_ID,
  startInternalMaintenanceCadences,
} from "../../apps/worker/src/internal-maintenance";
import {
  SANDBOX_IDLE_CHECKPOINT_SWEEP_WORKFLOW_ID,
  SANDBOX_REAPER_V2_WORKFLOW_ID,
  sandboxLifecycleTaskQueue,
} from "../../apps/worker/src/sandbox-reaper-contract";
import {
  BROWSER_DEADLINE_CHECKPOINT_SWEEP_ID,
  browserDeadlineCheckpointTaskQueue,
} from "../../apps/worker/src/browser-deadline-checkpoint-contract";
import {
  SESSION_WORKFLOW_WAKE_DISPATCH_REQUESTED_SIGNAL,
  SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS,
  SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
  SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_ID,
} from "@opengeni/core";

/**
 * Synthetic idle-deployment measurement. The deployment-wide dispatchers and
 * the sandbox reaper family run first the way earlier releases drove them (a
 * Temporal Schedule that starts a workflow every period; the reaper's router
 * then starts the drain inventory, both checkpoint sweeps and the maintenance
 * child) and then through the work-checked cadence, against a real Temporal
 * server and a freshly migrated, empty database. Each started workflow runs
 * exactly one stubbed activity, so activity calls count workflow executions.
 */
const WINDOW_MS = 61_000;
const workflowsPath = new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname;

let services: TestServices;
let connection: Connection;
let nativeConnection: NativeConnection;

beforeAll(async () => {
  services = await startTestServices({ temporal: true });
  await services.migrate();
  connection = await Connection.connect({ address: services.temporalHost });
  nativeConnection = await NativeConnection.connect({ address: services.temporalHost });
}, 300_000);

afterAll(async () => {
  await connection?.close();
  await nativeConnection?.close();
  await services?.down();
}, 120_000);

function stubActivities(
  calls: Record<string, number>,
  sweepMs = 0,
  routeReaper?: () => Promise<void>,
) {
  const count = (name: string) => async () => {
    calls[name] = (calls[name] ?? 0) + 1;
    if (sweepMs) await Bun.sleep(sweepMs);
    return {};
  };
  return {
    dispatchSessionWorkflowWakes: count("dispatchSessionWorkflowWakes"),
    indexKnowledge: count("indexKnowledge"),
    maintainSiteAuthConnections: count("maintainSiteAuthConnections"),
    // The old Schedule's router: one execution that starts three more.
    reapSandboxLeases: async () => {
      calls.reapSandboxLeases = (calls.reapSandboxLeases ?? 0) + 1;
      await routeReaper?.();
      return {};
    },
    prepareSandboxLeaseSweep: async () => {
      calls.prepareSandboxLeaseSweep = (calls.prepareSandboxLeaseSweep ?? 0) + 1;
      return {
        drainable: [],
        rotationsRequested: 0,
        timeoutClass: "fast",
        snapshotTimeoutMs: 60_000,
        captureTimeoutMs: 60_000,
      };
    },
    maintainSandboxLeaseSweep: count("maintainSandboxLeaseSweep"),
    listIdleSandboxCheckpoints: async () => {
      calls.listIdleSandboxCheckpoints = (calls.listIdleSandboxCheckpoints ?? 0) + 1;
      return { targets: [], timeoutClass: "fast" };
    },
    listDueBrowserCheckpoints: async () => {
      calls.listDueBrowserCheckpoints = (calls.listDueBrowserCheckpoints ?? 0) + 1;
      return [];
    },
  };
}

const total = (calls: Record<string, number>) =>
  Object.values(calls).reduce((sum, value) => sum + value, 0);
const SANDBOX_FAMILY = [
  "reapSandboxLeases",
  "prepareSandboxLeaseSweep",
  "maintainSandboxLeaseSweep",
  "listIdleSandboxCheckpoints",
  "listDueBrowserCheckpoints",
] as const;
const sandboxTotal = (calls: Record<string, number>) =>
  SANDBOX_FAMILY.reduce((sum, name) => sum + (calls[name] ?? 0), 0);
const perHour = (executions: number) => Math.round((executions * 3_600_000) / WINDOW_MS);

describe("idle maintenance executions", () => {
  test("an idle deployment starts maintenance workflows only for due work", async () => {
    const taskQueue = `idle-maintenance-${crypto.randomUUID()}`;
    const calls: Record<string, number> = {};
    const client = new Client({ connection });
    const lifecycleQueue = sandboxLifecycleTaskQueue(taskQueue);
    const browserQueue = browserDeadlineCheckpointTaskQueue(taskQueue);
    // Exactly the starts the old router activity made on every reaper tick.
    const routeReaper = async () => {
      await Promise.allSettled(
        (
          [
            ["sandboxReaperWorkflowV2", SANDBOX_REAPER_V2_WORKFLOW_ID, lifecycleQueue],
            [
              "browserDeadlineCheckpointSweepWorkflow",
              BROWSER_DEADLINE_CHECKPOINT_SWEEP_ID,
              browserQueue,
            ],
            [
              "sandboxIdleCheckpointSweepWorkflow",
              SANDBOX_IDLE_CHECKPOINT_SWEEP_WORKFLOW_ID,
              lifecycleQueue,
            ],
          ] as const
        ).map(([type, workflowId, queue]) =>
          client.workflow.start(type, {
            taskQueue: queue,
            workflowId,
            workflowIdReusePolicy: "ALLOW_DUPLICATE",
            args: [],
          }),
        ),
      );
    };
    const workers = await Promise.all(
      [taskQueue, lifecycleQueue, browserQueue].map((queue) =>
        Worker.create({
          connection: nativeConnection,
          namespace: "default",
          taskQueue: queue,
          workflowsPath,
          activities: stubActivities(calls, 0, routeReaper),
        }),
      ),
    );
    const runs = workers.map((worker) => worker.run());
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      temporalHost: services.temporalHost,
      temporalTaskQueue: taskQueue,
    });
    const db = createDb(services.runtimeDatabaseUrl);
    const owner = postgres(services.databaseUrl, { max: 1 });
    try {
      // Before: what earlier releases registered for these dispatchers.
      for (const [scheduleId, workflowType, every] of [
        [
          SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
          "sessionWorkflowWakeDispatcherWorkflow",
          SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS,
        ],
        [KNOWLEDGE_INDEXING_SCHEDULE_ID, "knowledgeIndexingWorkflow", KNOWLEDGE_INDEXING_PERIOD_MS],
        [
          SITE_AUTH_MAINTENANCE_SCHEDULE_ID,
          "siteAuthMaintenanceWorkflow",
          SITE_AUTH_MAINTENANCE_PERIOD_MS,
        ],
        [SANDBOX_REAPER_SCHEDULE_ID, "sandboxReaperWorkflow", settings.sandboxLeaseReaperPeriodMs],
      ] as const) {
        await client.schedule.create({
          scheduleId,
          spec: { intervals: [{ every }] },
          action: { type: "startWorkflow", workflowType, taskQueue, args: [] },
          policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: "1m" },
        });
      }
      await Bun.sleep(WINDOW_MS);
      const before = total(calls);
      const sandboxBefore = sandboxTotal(calls);

      // After: the cadence deletes those Schedules and checks for work first.
      const cadences = await startInternalMaintenanceCadences({
        settings,
        observability: createObservability(settings, { component: "worker-control" }),
        db: db.db,
        documentServices: { embedder: { model: "test-embedding", dimensions: 3 } } as never,
      });
      try {
        for (const scheduleId of [
          SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
          KNOWLEDGE_INDEXING_SCHEDULE_ID,
          SITE_AUTH_MAINTENANCE_SCHEDULE_ID,
          SANDBOX_REAPER_SCHEDULE_ID,
        ]) {
          await expect(client.schedule.getHandle(scheduleId).describe()).rejects.toThrow();
        }
        // Let any execution a deleted Schedule started just before finish.
        await Bun.sleep(3_000);
        const afterStart = total(calls);
        await Bun.sleep(WINDOW_MS);
        const idle = total(calls) - afterStart;
        console.log(
          `[idle-maintenance] executions over ${WINDOW_MS / 1_000}s: ` +
            `schedules=${before} (${perHour(before)}/h, sandbox family ${sandboxBefore}), ` +
            `cadence=${idle} (${perHour(idle)}/h)`,
        );
        // Every reaper tick used to cost five executions.
        expect(sandboxBefore).toBeGreaterThanOrEqual(10);
        expect(before).toBeGreaterThanOrEqual(19);
        expect(idle).toBe(0);

        // Due work still starts the dispatcher within one period.
        const suffix = crypto.randomUUID();
        const access = await bootstrapWorkspace(db.db, {
          accountExternalSource: "test",
          accountExternalId: `idle-${suffix}`,
          accountName: "Idle maintenance",
          workspaceExternalSource: "test",
          workspaceExternalId: `idle-${suffix}`,
          workspaceName: "Idle maintenance",
          subjectId: `user:idle-${suffix}`,
        });
        const grant = access.workspaceGrants[0]!;
        const session = await createSession(db.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          initialMessage: "initial",
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium" as const,
          latencyMode: "standard" as const,
          sandboxBackend: "none",
        });
        await enqueueSessionWorkflowWake(db.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          temporalWorkflowId: `session-${session.id}`,
          reason: "idle-maintenance-measurement",
        });
        const dispatched = calls.dispatchSessionWorkflowWakes ?? 0;
        const dueAt = Date.now();
        await waitFor(() => (calls.dispatchSessionWorkflowWakes ?? 0) > dispatched, {
          timeoutMs: SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS + 5_000,
        });
        console.log(`[idle-maintenance] due wake dispatched after ${Date.now() - dueAt}ms`);

        // A warm sandbox is reaper work: the drain inventory and its
        // maintenance pass start within one reaper period, the idle checkpoint
        // sweep has nothing to do (no snapshot interval), and no browser is held.
        const prepared = calls.prepareSandboxLeaseSweep ?? 0;
        const maintained = calls.maintainSandboxLeaseSweep ?? 0;
        const warmAt = Date.now();
        const instanceId = `box-${suffix}`;
        await owner`INSERT INTO sandbox_leases (account_id, workspace_id, sandbox_group_id,
            liveness, refcount, turn_holders, viewer_holders, instance_id, backend, lease_epoch,
            resume_backend_id, resume_state, expires_at)
          VALUES (${grant.accountId}, ${grant.workspaceId!}, ${crypto.randomUUID()}, 'warm', 1,
            0, 1, ${instanceId}, 'modal', 1, 'modal',
            ${JSON.stringify({ backendId: "modal", sessionState: { providerState: { sandboxId: instanceId } } })}::text::jsonb,
            now() + interval '10 minutes')`;
        await waitFor(() => (calls.prepareSandboxLeaseSweep ?? 0) > prepared, {
          timeoutMs: settings.sandboxLeaseReaperPeriodMs + 5_000,
        });
        await waitFor(() => (calls.maintainSandboxLeaseSweep ?? 0) > maintained, {
          timeoutMs: 10_000,
        });
        console.log(`[idle-maintenance] warm sandbox reaped after ${Date.now() - warmAt}ms`);
      } finally {
        await cadences.close();
      }
    } finally {
      for (const worker of workers) worker.shutdown();
      await Promise.all(runs);
      await owner.end();
      await db.close();
    }
  }, 300_000);

  test("a dispatch request during a sweep buffers exactly one more sweep", async () => {
    const taskQueue = `wake-dispatch-buffer-${crypto.randomUUID()}`;
    const calls: Record<string, number> = {};
    const worker = await Worker.create({
      connection: nativeConnection,
      namespace: "default",
      taskQueue,
      workflowsPath,
      activities: stubActivities(calls, 1_500),
    });
    const run = worker.run();
    try {
      const client = new Client({ connection });
      const workflowId = `${SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_ID}-${crypto.randomUUID()}`;
      const request = async () =>
        await client.workflow.signalWithStart("sessionWorkflowWakeDispatcherWorkflow", {
          taskQueue,
          workflowId,
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [],
          signal: SESSION_WORKFLOW_WAKE_DISPATCH_REQUESTED_SIGNAL,
        });
      const first = await request();
      await waitFor(() => (calls.dispatchSessionWorkflowWakes ?? 0) === 1);
      // Two requests during the running sweep coalesce into one more sweep
      // on the same execution rather than starting new executions.
      await request();
      await request();
      await first.result();
      expect(calls.dispatchSessionWorkflowWakes).toBe(2);
      // A request after the execution closed starts a fresh one.
      const next = await request();
      await next.result();
      expect(calls.dispatchSessionWorkflowWakes).toBe(3);
    } finally {
      worker.shutdown();
      await run;
    }
  }, 120_000);
});
