import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { waitFor } from "@opengeni/testing";
import {
  Client,
  createTemporalWorkflowTestContext,
  temporalWorkflowTestTimeoutMs,
  testWorker,
  queuedTurn,
  workflowScope,
  type TemporalWorkflowTestContext,
} from "./temporal-workflow.test-support";

describe("Temporal workflow integration — activities and scheduled tasks", () => {
  let context!: TemporalWorkflowTestContext;

  beforeAll(async () => {
    context = await createTemporalWorkflowTestContext();
  }, 300_000);

  afterAll(async () => {
    await context?.close();
  }, 60_000);

  test(
    "idle interrupt pauses the goal before marking the session idle",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const order: string[] = [];
      const pauses: unknown[] = [];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => null,
        markSessionIdle: async () => {
          order.push("idle");
        },
        runAgentTurn: async () => ({ status: "idle" }),
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
        pauseGoalForInterrupt: async (input: unknown) => {
          order.push("pause");
          pauses.push(input);
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [{ ...scope, sessionId }],
        });
        await handle.signal("interrupt", "interrupt-event");
        await handle.result();
        expect(order).toEqual(["pause", "idle"]);
        // The trigger event rides along so the activity can recognize (and
        // skip pausing for) steer-tagged interrupts.
        expect(pauses).toEqual([
          { workspaceId: scope.workspaceId, sessionId, triggerEventId: "interrupt-event" },
        ]);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "a failing goal continuation check falls back to idle shutdown",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const idleMarks: unknown[] = [];
      const queuedTurns = [queuedTurn("event-1")];
      const runs: unknown[] = [];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async (input: unknown) => {
          idleMarks.push(input);
        },
        runAgentTurn: async (input: unknown) => {
          runs.push(input);
          return { status: "idle" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
        maybeContinueGoal: async () => {
          throw new Error("goal store unavailable");
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [{ ...scope, sessionId, initialEventId: "event-1" }],
        });
        await handle.result();
        expect(runs).toHaveLength(1);
        expect(idleMarks).toEqual([{ workspaceId: scope.workspaceId, sessionId }]);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "dispatches document index workflow activity",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const calls: unknown[] = [];
      const worker = await testWorker(context, taskQueue, {
        indexDocument: async (input: unknown) => {
          calls.push(input);
          return {
            id: "document-1",
            baseId: "base-1",
            fileId: "file-1",
            status: "ready",
            title: "runbook.txt",
            parser: "liteparse",
            chunkCount: 1,
            error: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
        runAgentTurn: async () => ({ status: "idle" }),
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("documentIndexWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [
            {
              accountId: scope.accountId,
              workspaceId: scope.workspaceId,
              documentId: "document-1",
            },
          ],
        });
        const result = await handle.result();
        expect(calls).toEqual([
          { accountId: scope.accountId, workspaceId: scope.workspaceId, documentId: "document-1" },
        ]);
        expect(result).toMatchObject({ id: "document-1", status: "ready" });
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "scheduled task fire workflow starts a session child workflow",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const dispatches: unknown[] = [];
      const runs: unknown[] = [];
      const queuedTurns: Array<{ id: string; triggerEventId: string }> = [];
      const sessionId = crypto.randomUUID();
      const triggerEventId = crypto.randomUUID();
      const childWorkflowId = `session-${sessionId}`;
      const worker = await testWorker(context, taskQueue, {
        dispatchScheduledTaskRun: async (input: unknown) => {
          dispatches.push(input);
          queuedTurns.push(queuedTurn(triggerEventId));
          return {
            action: "start",
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            sessionId,
            triggerEventId,
            workflowId: childWorkflowId,
          };
        },
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: unknown) => {
          runs.push(input);
          return { status: "idle" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("scheduledTaskFireWorkflow", {
          taskQueue,
          workflowId: `scheduled-fire-${crypto.randomUUID()}`,
          args: [{ ...scope, taskId: crypto.randomUUID(), triggerType: "scheduled" }],
        });
        await handle.result();
        await waitFor(() => runs.length === 1);
        const followUpEventId = crypto.randomUUID();
        queuedTurns.push(queuedTurn(followUpEventId));
        await client.workflow.getHandle(childWorkflowId).signal("userMessage", followUpEventId);
        await waitFor(() => runs.length === 2);
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]).toMatchObject({
          workspaceId: scope.workspaceId,
          triggerType: "scheduled",
        });
        expect(runs[0]).toMatchObject({
          ...scope,
          sessionId,
          triggerEventId,
          workflowId: childWorkflowId,
        });
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );
});
