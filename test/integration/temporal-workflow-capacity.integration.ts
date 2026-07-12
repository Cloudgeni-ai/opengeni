import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { waitFor } from "@opengeni/testing";
import {
  Client,
  continueAsNewTestTimeoutMs,
  createTemporalWorkflowTestContext,
  decodeContinuedInput,
  temporalWorkflowTestTimeoutMs,
  testWorker,
  queuedTurn,
  workflowScope,
  type TemporalWorkflowTestContext,
} from "./temporal-workflow.test-support";

describe("Temporal workflow integration — capacity waits", () => {
  let context!: TemporalWorkflowTestContext;

  beforeAll(async () => {
    context = await createTemporalWorkflowTestContext();
  }, 300_000);

  afterAll(async () => {
    await context?.close();
  }, 60_000);

  test(
    "scheduled task fire workflow signals a reusable session workflow",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const calls: unknown[] = [];
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      const triggerEventId = crypto.randomUUID();
      const queuedTurns = [queuedTurn("event-1")];
      const worker = await testWorker(context, taskQueue, {
        dispatchScheduledTaskRun: async () => {
          queuedTurns.push(queuedTurn(triggerEventId));
          return {
            action: "signal",
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            sessionId,
            triggerEventId,
            workflowId,
          };
        },
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: unknown) => {
          calls.push(input);
          return { status: "idle" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [{ ...scope, sessionId, initialEventId: "event-1" }],
        });
        await waitFor(() => calls.length === 1);
        const fire = await client.workflow.start("scheduledTaskFireWorkflow", {
          taskQueue,
          workflowId: `scheduled-fire-${crypto.randomUUID()}`,
          args: [{ ...scope, taskId: crypto.randomUUID(), triggerType: "manual" }],
        });
        await fire.result();
        await waitFor(() => calls.length === 2);
        expect(calls[1]).toMatchObject({ ...scope, sessionId, triggerEventId });
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "coalesces duplicate capacity signals into one normal continuation",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      const queuedTurns = [queuedTurn("event-1")];
      const runs: Array<{ triggerEventId: string }> = [];
      const reconciliations: Array<{ cause: string }> = [];
      const waiter = {
        waiterId: crypto.randomUUID(),
        generation: 1,
        nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
        wakeRevision: 1,
      };
      let resumed = false;
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: { triggerEventId: string }) => {
          runs.push(input);
          return input.triggerEventId === "event-1"
            ? { status: "idle", capacityWait: waiter }
            : { status: "failed" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
        getCodexCapacityWait: async () => (resumed ? null : waiter),
        reconcileCodexCapacityWait: async (input: { cause: string }) => {
          reconciliations.push(input);
          if (!resumed) {
            resumed = true;
            queuedTurns.push(queuedTurn("capacity-resume"));
            return { action: "resumed", turnId: queuedTurns[0]!.id };
          }
          return { action: "stale" };
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [{ ...scope, sessionId, initialEventId: "event-1" }],
        });
        await waitFor(() => runs.length === 1);
        // Signal until the workflow has entered its durable wait, then send a
        // duplicate. The row-locked activity is the sole enqueue writer.
        for (let attempt = 0; attempt < 20 && reconciliations.length === 0; attempt += 1) {
          await handle.signal("codexCapacityChanged", waiter.wakeRevision + attempt + 1);
          await Bun.sleep(25);
        }
        await handle.signal("codexCapacityChanged", waiter.wakeRevision + 100);
        await handle.result();
        expect(runs.map((input) => input.triggerEventId)).toEqual(["event-1", "capacity-resume"]);
        expect(reconciliations).toHaveLength(1);
        expect(reconciliations[0]?.cause).toBe("signal");
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "does not lose a capacity signal buffered before the waiter activity returns",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      const queuedTurns = [queuedTurn("event-1")];
      const runs: Array<{ triggerEventId: string }> = [];
      const reconciliationCauses: string[] = [];
      const waiter = {
        waiterId: crypto.randomUUID(),
        generation: 2,
        nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
        wakeRevision: 5,
      };
      let releaseFirstRun!: () => void;
      const firstRunBlocked = new Promise<void>((resolve) => {
        releaseFirstRun = resolve;
      });
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: { triggerEventId: string }) => {
          runs.push(input);
          if (input.triggerEventId === "event-1") {
            await firstRunBlocked;
            return { status: "idle", capacityWait: waiter };
          }
          return { status: "failed" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
        getCodexCapacityWait: async () => waiter,
        reconcileCodexCapacityWait: async (input: { cause: string }) => {
          reconciliationCauses.push(input.cause);
          queuedTurns.push(queuedTurn("capacity-resume"));
          return { action: "resumed", turnId: queuedTurns[0]!.id };
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [{ ...scope, sessionId, initialEventId: "event-1" }],
        });
        await waitFor(() => runs.length === 1);
        await handle.signal("codexCapacityChanged", waiter.wakeRevision + 1);
        releaseFirstRun();
        await handle.result();
        expect(reconciliationCauses).toEqual(["signal"]);
        expect(runs.map((input) => input.triggerEventId)).toEqual(["event-1", "capacity-resume"]);
      } finally {
        releaseFirstRun();
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "reconstructs a capacity timer across continue-as-new without goal polling",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      const queuedTurns = [queuedTurn("event-1")];
      const runs: Array<{ triggerEventId: string }> = [];
      let goalChecks = 0;
      let reconciliations = 0;
      let resumed = false;
      const waiter = {
        waiterId: crypto.randomUUID(),
        generation: 7,
        nextCheckAt: new Date(0).toISOString(),
        wakeRevision: 3,
      };
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: { triggerEventId: string }) => {
          runs.push(input);
          return input.triggerEventId === "event-1"
            ? { status: "idle", capacityWait: waiter }
            : { status: "failed" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
        maybeContinueGoal: async () => {
          goalChecks += 1;
          return { action: "none" };
        },
        getCodexCapacityWait: async () => (resumed ? null : waiter),
        reconcileCodexCapacityWait: async () => {
          reconciliations += 1;
          if (reconciliations === 1) {
            return { action: "waiting", ...waiter };
          }
          resumed = true;
          queuedTurns.push(queuedTurn("capacity-after-continue-as-new"));
          return { action: "resumed", turnId: queuedTurns[0]!.id };
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [
            {
              ...scope,
              sessionId,
              initialEventId: "event-1",
              maxCapacityChecksPerRun: 1,
            },
          ],
        });
        await handle.result();
        expect(runs.map((input) => input.triggerEventId)).toEqual([
          "event-1",
          "capacity-after-continue-as-new",
        ]);
        expect(reconciliations).toBe(2);
        expect(goalChecks).toBe(0);

        const firstRun = client.workflow.getHandle(workflowId, handle.firstExecutionRunId);
        const history = await firstRun.fetchHistory();
        const continuedEvent = (history.events ?? []).find(
          (event) => event.workflowExecutionContinuedAsNewEventAttributes != null,
        );
        expect(continuedEvent).toBeDefined();
        expect(decodeContinuedInput(continuedEvent)).toEqual({
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId,
          maxCapacityChecksPerRun: 1,
        });
      } finally {
        worker.shutdown();
        await run;
      }
    },
    continueAsNewTestTimeoutMs,
  );
});
