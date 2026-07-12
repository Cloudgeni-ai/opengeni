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

describe("Temporal workflow integration — interrupt and goal continuation", () => {
  let context!: TemporalWorkflowTestContext;

  beforeAll(async () => {
    context = await createTemporalWorkflowTestContext();
  }, 300_000);

  afterAll(async () => {
    await context?.close();
  }, 60_000);

  test(
    "interrupt during an active run cancels the active turn and continues queued work",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `wf-${crypto.randomUUID()}`;
      const first = queuedTurn("event-1");
      const second = queuedTurn("event-2");
      const queuedTurns = [first];
      const runs: unknown[] = [];
      const interrupts: unknown[] = [];
      let allowFirstRunToFinish = false;
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: unknown) => {
          runs.push(input);
          if (runs.length === 1) {
            while (!allowFirstRunToFinish) {
              await Bun.sleep(10);
            }
          }
          return { status: "idle" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async (input: unknown) => {
          interrupts.push(input);
          allowFirstRunToFinish = true;
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [{ ...scope, sessionId, initialEventId: first.triggerEventId }],
        });
        await waitFor(() => runs.length === 1);
        queuedTurns.push(second);
        await handle.signal("userMessage", second.triggerEventId);
        await handle.signal("interrupt", "interrupt-event");
        await waitFor(() => runs.length === 2);
        expect(interrupts).toEqual([
          { ...scope, sessionId, triggerEventId: "interrupt-event", workflowId },
        ]);
        expect(runs[1]).toMatchObject({
          ...scope,
          sessionId,
          turnId: second.id,
          triggerEventId: second.triggerEventId,
          workflowId,
        });
      } finally {
        allowFirstRunToFinish = true;
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "interrupt while awaiting approval cancels the blocked turn and continues queued work",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `wf-${crypto.randomUUID()}`;
      const first = queuedTurn("event-1");
      const second = queuedTurn("event-2");
      const queuedTurns = [first];
      const runs: unknown[] = [];
      const interrupts: unknown[] = [];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: unknown) => {
          runs.push(input);
          return { status: runs.length === 1 ? "requires_action" : "idle" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async (input: unknown) => {
          interrupts.push(input);
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [{ ...scope, sessionId, initialEventId: first.triggerEventId }],
        });
        await waitFor(() => runs.length === 1);
        queuedTurns.push(second);
        await handle.signal("userMessage", second.triggerEventId);
        await handle.signal("interrupt", "interrupt-event");
        await waitFor(() => runs.length === 2);
        expect(interrupts).toEqual([
          { ...scope, sessionId, triggerEventId: "interrupt-event", workflowId },
        ]);
        expect(runs[1]).toMatchObject({
          ...scope,
          sessionId,
          turnId: second.id,
          triggerEventId: second.triggerEventId,
          workflowId,
        });
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "synthesizes goal continuation turns until the goal declines",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const runs: Array<{ triggerEventId: string }> = [];
      const goalChecks: unknown[] = [];
      const queuedTurns = [queuedTurn("event-1")];
      let continuations = 0;
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: { triggerEventId: string }) => {
          runs.push(input);
          return { status: "idle" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
        maybeContinueGoal: async (input: unknown) => {
          goalChecks.push(input);
          if (continuations < 2) {
            continuations += 1;
            queuedTurns.push(queuedTurn(`goal-event-${continuations}`));
            return { action: "continue" };
          }
          return { action: "none" };
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const workflowId = `wf-${crypto.randomUUID()}`;
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [{ ...scope, sessionId, initialEventId: "event-1" }],
        });
        await handle.result();
        expect(runs.map((input) => input.triggerEventId)).toEqual([
          "event-1",
          "goal-event-1",
          "goal-event-2",
        ]);
        expect(goalChecks.length).toBeGreaterThanOrEqual(3);
        expect(goalChecks[0]).toMatchObject({ ...scope, sessionId, workflowId });
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "holds the loop for continueDelayMs before the goal continuation check",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const delayMs = 1500;
      let segmentReturnedAt = 0;
      let goalCheckedAt = 0;
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: (() => {
          const queuedTurns = [queuedTurn("event-1")];
          return async () => queuedTurns.shift() ?? null;
        })(),
        markSessionIdle: async () => undefined,
        runAgentTurn: async () => {
          segmentReturnedAt = Date.now();
          // Provider backpressure idle: the workflow must hold the loop before
          // admitting the goal continuation.
          return { status: "idle", continueDelayMs: delayMs };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
        maybeContinueGoal: async () => {
          if (!goalCheckedAt) {
            goalCheckedAt = Date.now();
          }
          return { action: "none" };
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
        expect(segmentReturnedAt).toBeGreaterThan(0);
        expect(goalCheckedAt).toBeGreaterThan(0);
        // Generous lower bound to absorb timer scheduling slack.
        expect(goalCheckedAt - segmentReturnedAt).toBeGreaterThanOrEqual(delayMs - 300);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );
});
