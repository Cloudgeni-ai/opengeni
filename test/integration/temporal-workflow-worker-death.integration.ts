import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Client,
  createTemporalWorkflowTestContext,
  hangWithoutHeartbeating,
  temporalWorkflowTestTimeoutMs,
  testWorker,
  workerDeathTestTimeoutMs,
  queuedTurn,
  workflowScope,
  type TemporalWorkflowTestContext,
} from "./temporal-workflow.test-support";

describe("Temporal workflow integration — worker death", () => {
  let context!: TemporalWorkflowTestContext;

  beforeAll(async () => {
    context = await createTemporalWorkflowTestContext();
  }, 300_000);

  afterAll(async () => {
    await context?.close();
  }, 60_000);

  test(
    "re-dispatches a turn whose worker died (heartbeat timeout) instead of failing the session",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const turn = queuedTurn("event-1");
      const queuedTurns = [turn];
      const runs: Array<{ turnId?: string; triggerEventId: string }> = [];
      const requeues: Array<{ turnId: string; triggerEventId: string }> = [];
      const failures: unknown[] = [];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: { turnId?: string; triggerEventId: string }) => {
          runs.push(input);
          if (runs.length === 1) {
            // Ungracefully dead worker: never heartbeats, never returns.
            return await hangWithoutHeartbeating();
          }
          return { status: "idle" };
        },
        requeueTurnAfterWorkerDeath: async (input: { turnId: string; triggerEventId: string }) => {
          requeues.push(input);
          // Mirror the real activity: the same turn goes back on the queue
          // behind a synthesized worker-death resume trigger.
          queuedTurns.push({ id: turn.id, triggerEventId: "death-resume-event" });
          return { action: "requeued", redispatches: 1 };
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
        expect(runs[1]).toMatchObject({ turnId: turn.id, triggerEventId: "death-resume-event" });
        expect(requeues).toEqual([
          expect.objectContaining({ turnId: turn.id, triggerEventId: "event-1" }),
        ]);
        expect(failures).toHaveLength(0);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    workerDeathTestTimeoutMs,
  );

  test(
    "fails the session for real once worker-death re-dispatches exceed the ceiling",
    async () => {
      // The counter mechanics (persisted per-turn counter, ceiling, stale
      // detection) are proven against the real requeueTurnAfterWorkerDeath
      // activity in worker-activity.integration.ts; this proves the workflow
      // honors the activity's "exceeded" verdict on a real heartbeat-timeout
      // failure by failing the session with a clear error.
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const turn = queuedTurn("event-1");
      const queuedTurns = [turn];
      const runs: unknown[] = [];
      const failures: Array<{ error?: string }> = [];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: unknown) => {
          runs.push(input);
          // Crash-looping turn: every dispatch takes its worker down.
          return await hangWithoutHeartbeating();
        },
        requeueTurnAfterWorkerDeath: async () => ({ action: "exceeded", redispatches: 3 }),
        failSession: async (input: { error?: string }) => {
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
        expect(runs).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]?.error).toContain("giving up after 3 re-dispatches");
      } finally {
        worker.shutdown();
        await run;
      }
    },
    workerDeathTestTimeoutMs,
  );

  test(
    "idle interrupt marks the session idle without cancelling a turn",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const idleMarks: unknown[] = [];
      const interrupts: unknown[] = [];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => null,
        markSessionIdle: async (input: unknown) => {
          idleMarks.push(input);
        },
        runAgentTurn: async () => ({ status: "idle" }),
        failSession: async () => undefined,
        interruptActiveTurn: async (input: unknown) => {
          interrupts.push(input);
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        const sessionId = crypto.randomUUID();
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [{ ...scope, sessionId }],
        });
        await handle.signal("interrupt", "interrupt-event");
        await handle.result();
        expect(idleMarks).toEqual([{ workspaceId: scope.workspaceId, sessionId }]);
        expect(interrupts).toHaveLength(0);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "interrupt start-or-signals an idle session with no running workflow (the production 500 fix)",
    async () => {
      // Reproduces the operator-can't-stop bug: a long-lived session that has gone
      // idle has NO running workflow execution. The OLD API client did
      // getHandle(workflowId).signal("interrupt", …), which throws
      // WorkflowNotFoundError -> a 500. The FIXED client uses signalWithStart
      // exactly as wired below; it must start a fresh sessionWorkflow that
      // immediately honors the buffered interrupt via the idle-interrupt path
      // (pause goal for the trigger event + mark idle), with no active turn to
      // cancel.
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `wf-${crypto.randomUUID()}`;
      const idleMarks: unknown[] = [];
      const pauses: unknown[] = [];
      const interrupts: unknown[] = [];
      const worker = await testWorker(context, taskQueue, {
        claimNextQueuedTurn: async () => null,
        markSessionIdle: async (input: unknown) => {
          idleMarks.push(input);
        },
        pauseGoalForInterrupt: async (input: unknown) => {
          pauses.push(input);
        },
        runAgentTurn: async () => ({ status: "idle" }),
        failSession: async () => undefined,
        interruptActiveTurn: async (input: unknown) => {
          interrupts.push(input);
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
        // EXACT production API-client wiring: no prior workflow.start — the only
        // call is signalWithStart, the start-or-signal path the fixed
        // signalInterrupt uses. Against a not-running workflow this must START it.
        const handle = await client.workflow.signalWithStart("sessionWorkflow", {
          taskQueue,
          workflowId,
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [{ ...scope, sessionId }],
          signal: "interrupt",
          signalArgs: ["interrupt-event"],
        });
        await handle.result();
        // The idle-interrupt path ran: the goal was paused for the trigger event
        // and the session was marked idle. No active turn existed to cancel.
        expect(pauses).toEqual([
          { workspaceId: scope.workspaceId, sessionId, triggerEventId: "interrupt-event" },
        ]);
        expect(idleMarks).toEqual([{ workspaceId: scope.workspaceId, sessionId }]);
        expect(interrupts).toHaveLength(0);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );
});
