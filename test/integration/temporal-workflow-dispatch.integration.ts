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

describe("Temporal workflow integration — dispatch", () => {
  let context!: TemporalWorkflowTestContext;

  beforeAll(async () => {
    context = await createTemporalWorkflowTestContext();
  }, 300_000);

  afterAll(async () => {
    await context?.close();
  }, 60_000);

  test(
    "dispatches initial and follow-up user message activities",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const calls: unknown[] = [];
      const queuedTurns = [queuedTurn("event-1")];
      const worker = await testWorker(context, taskQueue, {
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
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [{ ...scope, sessionId: crypto.randomUUID(), initialEventId: "event-1" }],
        });
        await waitFor(() => calls.length === 1);
        queuedTurns.push(queuedTurn("event-2"));
        await handle.signal("userMessage", "event-2");
        await waitFor(() => calls.length === 2);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "waits for approval before resuming a requires_action segment",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const calls: unknown[] = [];
      const queuedTurns = [queuedTurn("event-1")];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: unknown) => {
          calls.push(input);
          return { status: calls.length === 1 ? "requires_action" : "idle" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [{ ...scope, sessionId: crypto.randomUUID(), initialEventId: "event-1" }],
        });
        await waitFor(() => calls.length === 1);
        await Bun.sleep(300);
        expect(calls).toHaveLength(1);
        await handle.signal("approvalDecision", "approval-event");
        await waitFor(() => calls.length === 2);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "does not retry failed agent activities",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      let attempts = 0;
      const failures: unknown[] = [];
      const queuedTurns = [queuedTurn("event-1")];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async () => {
          attempts += 1;
          throw new Error("boom");
        },
        failSession: async (input: unknown) => {
          failures.push(input);
        },
        interruptActiveTurn: async () => undefined,
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [{ ...scope, sessionId: crypto.randomUUID(), initialEventId: "event-1" }],
        });
        await handle.result();
        expect(attempts).toBe(1);
        expect(failures).toHaveLength(1);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "re-dispatches a preempted turn instead of failing the session",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const turn = queuedTurn("event-1");
      const queuedTurns = [turn];
      const runs: Array<{ turnId?: string; triggerEventId: string }> = [];
      const failures: unknown[] = [];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: { turnId?: string; triggerEventId: string }) => {
          runs.push(input);
          if (runs.length === 1) {
            // Mirror the real preemption contract: the activity re-queues the
            // same turn (behind a synthesized resume trigger) before completing
            // with "preempted"; the workflow must claim and re-dispatch it.
            queuedTurns.push({ id: turn.id, triggerEventId: "resume-event" });
            return { status: "preempted" };
          }
          return { status: "idle" };
        },
        failSession: async (input: unknown) => {
          failures.push(input);
        },
        interruptActiveTurn: async () => undefined,
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [{ ...scope, sessionId: crypto.randomUUID(), initialEventId: "event-1" }],
        });
        await handle.result();
        expect(runs).toHaveLength(2);
        expect(runs[0]).toMatchObject({ turnId: turn.id, triggerEventId: "event-1" });
        expect(runs[1]).toMatchObject({ turnId: turn.id, triggerEventId: "resume-event" });
        expect(failures).toHaveLength(0);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );
});
