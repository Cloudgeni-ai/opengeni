import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { startTestServices, type TestServices, waitFor } from "@opengeni/testing";
import { currentActivityContext } from "../../apps/worker/src/activities/streaming";

// An ungraceful worker death cannot be faked by throwing a TimeoutFailure
// from the activity (the worker coerces thrown activity errors into
// ApplicationFailure via ensureApplicationFailure), so the worker-death tests
// produce the REAL failure shape: the mock turn activity hangs without ever
// heartbeating and the Temporal server closes it with a heartbeat timeout
// (the session workflow's proxy sets heartbeatTimeout to 30s), delivering an
// ActivityFailure whose cause is a TimeoutFailure with timeoutType HEARTBEAT
// — exactly what a SIGKILLed worker produces. The hang resolves on the
// worker-shutdown cancellation so the test worker can drain at the end.
async function hangWithoutHeartbeating(): Promise<{ status: string }> {
  await new Promise<void>((resolve) => {
    const signal = currentActivityContext()?.cancellationSignal;
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return { status: "cancelled" };
}

// Generous bound for the server to detect a missed-heartbeat activity
// (30s heartbeat window + detection slack) plus the rest of the test.
const workerDeathTestTimeoutMs = 180_000;

const temporalWorkflowTestTimeoutMs = 30_000;

// continueAsNew tests legitimately span a continueAsNew chain (the handle only
// resolves on the FINAL run) plus a possible 5s idle-wait window before the
// continued run re-claims the durable-queue turn that arrived after the
// boundary. Run last in the suite, on a server already warmed by 18 prior
// tests, the 30s default is too tight under CI load — a slow worker poll or
// bundle reload can blow it even though the workflow logic is correct. The
// generous bound removes that flakiness without weakening what the test proves.
const continueAsNewTestTimeoutMs = 120_000;

describe("Temporal workflow integration", () => {
  let services: TestServices;
  let connection: Connection;
  let nativeConnection: NativeConnection;

  beforeAll(async () => {
    const externalTemporalHost = process.env.OPENGENI_TEST_TEMPORAL_HOST?.trim();
    services = externalTemporalHost
      ? ({ temporalHost: externalTemporalHost, down: async () => undefined } as TestServices)
      : await startTestServices({ temporal: true });
    connection = await Connection.connect({ address: services.temporalHost });
    nativeConnection = await NativeConnection.connect({ address: services.temporalHost });
  }, 300_000);

  afterAll(async () => {
    await connection?.close();
    await nativeConnection?.close();
    await services?.down();
  }, 60_000);

  test(
    "dispatches initial and follow-up user message activities",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const calls: unknown[] = [];
      const queuedTurns = [queuedTurn("event-1")];
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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

  test(
    "idle interrupt pauses the goal before marking the session idle",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const order: string[] = [];
      const pauses: unknown[] = [];
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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
      const worker = await testWorker(nativeConnection, taskQueue, {
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
        const client = new Client({ connection });
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

  test(
    "keeps a durable capacity wait alive across worker replacement",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      const queuedTurns = [queuedTurn("event-1")];
      const runs: Array<{ triggerEventId: string }> = [];
      const waiter = {
        waiterId: crypto.randomUUID(),
        generation: 11,
        nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
        wakeRevision: 4,
      };
      let resumed = false;
      let reconciliations = 0;
      const activities = {
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
        reconcileCodexCapacityWait: async () => {
          reconciliations += 1;
          resumed = true;
          queuedTurns.push(queuedTurn("capacity-after-worker-restart"));
          return { action: "resumed", turnId: queuedTurns[0]!.id };
        },
      };
      const firstWorker = await testWorker(nativeConnection, taskQueue, activities);
      const firstRun = firstWorker.run();
      const client = new Client({ connection });
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId,
        args: [{ ...scope, sessionId, initialEventId: "event-1" }],
      });
      await waitFor(() => runs.length === 1);
      await Bun.sleep(100);
      firstWorker.shutdown();
      await firstRun;

      const replacement = await testWorker(nativeConnection, taskQueue, activities);
      const replacementRun = replacement.run();
      try {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (reconciliations !== 0) break;
          await handle.signal("codexCapacityChanged", waiter.wakeRevision + attempt + 1);
          await Bun.sleep(25);
        }
        await handle.result();
        expect(runs.map((input) => input.triggerEventId)).toEqual([
          "event-1",
          "capacity-after-worker-restart",
        ]);
        expect(reconciliations).toBe(1);
      } finally {
        replacement.shutdown();
        await replacementRun;
      }
    },
    continueAsNewTestTimeoutMs,
  );

  test(
    "continues-as-new at the turn boundary, carrying state and stranding no queued turn",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      // Two turns sit in the (Postgres-backed) queue up front; the per-run
      // backstop is 1, so the workflow continues-as-new after each turn. The
      // SECOND turn can only be dispatched by the SECOND run — proving the
      // continueAsNew boundary strands nothing and the fresh run re-claims from
      // the durable queue rather than a replayed seed event.
      const queuedTurns = [queuedTurn("event-1"), queuedTurn("event-2")];
      const runs: Array<{ triggerEventId: string }> = [];
      const goalChecks: unknown[] = [];
      const worker = await testWorker(nativeConnection, taskQueue, {
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
          return { action: "none" };
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [{ ...scope, sessionId, initialEventId: "event-1", maxTurnsPerRun: 1 }],
        });
        // The handle follows the continueAsNew chain: it resolves only when the
        // FINAL run completes (idle, after both turns drained).
        await handle.result();
        // Both turns ran exactly once, in order, across the continueAsNew split.
        expect(runs.map((input) => input.triggerEventId)).toEqual(["event-1", "event-2"]);

        // The first run ended by continuing-as-new (history overflow guard), and
        // the continuation carried the self-contained input forward (same scope
        // and sessionId, and the propagated backstop) with NO initialEventId —
        // the new run claims from the queue, it does not replay a seed event.
        const firstRun = client.workflow.getHandle(workflowId, handle.firstExecutionRunId);
        const history = await firstRun.fetchHistory();
        const continuedEvent = (history.events ?? []).find(
          (event) => event.workflowExecutionContinuedAsNewEventAttributes != null,
        );
        expect(continuedEvent).toBeDefined();
        const continuedInput = decodeContinuedInput(continuedEvent);
        expect(continuedInput).toEqual({
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId,
          maxTurnsPerRun: 1,
        });
        expect(continuedInput.initialEventId).toBeUndefined();
      } finally {
        worker.shutdown();
        await run;
      }
    },
    continueAsNewTestTimeoutMs,
  );

  test(
    "a queueChanged signal buffered at the continueAsNew boundary is not stranded",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      // Exactly one turn is queued at start. The follow-up turn is enqueued
      // (durable Postgres queue) and a queueChanged signal sent only AFTER the
      // first turn has run — i.e. while the workflow is poised to continue-as-new.
      // The continueAsNew drops the in-memory wakeup counter, but the turn lives
      // in the queue, so the fresh run must still dispatch it.
      const queuedTurns = [queuedTurn("event-1")];
      const runs: Array<{ triggerEventId: string }> = [];
      const worker = await testWorker(nativeConnection, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: { triggerEventId: string }) => {
          runs.push(input);
          return { status: "idle" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
        maybeContinueGoal: async () => ({ action: "none" }),
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [{ ...scope, sessionId, initialEventId: "event-1", maxTurnsPerRun: 1 }],
        });
        await waitFor(() => runs.length === 1);
        // Mirror the signaler contract: write the turn to the durable queue, THEN
        // signal. The signal lands while the first run is at (or racing toward)
        // its continueAsNew boundary.
        queuedTurns.push(queuedTurn("event-2"));
        await client.workflow.getHandle(workflowId).signal("queueChanged");
        await handle.result();
        // The follow-up turn was claimed by the continued run, not lost.
        expect(runs.map((input) => input.triggerEventId)).toEqual(["event-1", "event-2"]);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    continueAsNewTestTimeoutMs,
  );

  test(
    "a stale approval left in the queue does not wedge the continueAsNew boundary",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      // Two turns are queued up front; the per-run backstop is 1, so the workflow
      // must continue-as-new after the first turn settles. The first turn returns
      // requires_action, blocking inside runTurn until an approval arrives. TWO
      // approvalDecision signals are sent while it is blocked (the API guard only
      // checks status==='requires_action', so two decisions both land in the
      // in-memory approvalQueue). The first approval re-runs the turn to idle and
      // settles it; the SECOND is left behind in the queue — a STALE entry.
      //
      // Regression: coupling the continueAsNew guard to `approvalQueue.length===0`
      // let that stale entry wedge the boundary forever, so the workflow grew to
      // the Temporal hard history cap and was force-terminated — the exact failure
      // this branch exists to prevent. The fix drops the surplus at the boundary:
      // continueAsNew must still fire and the continued run must dispatch event-2.
      const queuedTurns = [queuedTurn("event-1"), queuedTurn("event-2")];
      const runs: Array<{ triggerEventId: string }> = [];
      const worker = await testWorker(nativeConnection, taskQueue, {
        claimNextQueuedTurn: async () => queuedTurns.shift() ?? null,
        markSessionIdle: async () => undefined,
        runAgentTurn: async (input: { triggerEventId: string }) => {
          runs.push(input);
          // Only the ORIGINAL event-1 dispatch blocks on approval; the approval
          // re-run and event-2 settle straight to idle, so the turn completes
          // without re-entering requires_action and the second approval is
          // orphaned in the queue.
          return { status: input.triggerEventId === "event-1" ? "requires_action" : "idle" };
        },
        failSession: async () => undefined,
        interruptActiveTurn: async () => undefined,
        maybeContinueGoal: async () => ({ action: "none" }),
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId,
          args: [{ ...scope, sessionId, initialEventId: "event-1", maxTurnsPerRun: 1 }],
        });
        // Wait until the first turn is blocked on approval, then submit two
        // decisions. The surplus second decision is the stale entry under test.
        await waitFor(() => runs.length === 1);
        await client.workflow.getHandle(workflowId).signal("approvalDecision", "approval-1");
        await client.workflow.getHandle(workflowId).signal("approvalDecision", "approval-2");
        // The handle follows the continueAsNew chain: it resolves only if the
        // boundary was NOT wedged and the continued run drained event-2 to idle.
        await handle.result();
        // event-1 (requires_action), approval-1 (re-run to idle), event-2 (on the
        // continued run). The stale approval-2 never drives a dispatch.
        expect(runs.map((input) => input.triggerEventId)).toEqual([
          "event-1",
          "approval-1",
          "event-2",
        ]);

        // The first run ended by continuing-as-new despite the stale approval, and
        // event-2 was claimed by the fresh continued run — not stranded.
        const firstRun = client.workflow.getHandle(workflowId, handle.firstExecutionRunId);
        const history = await firstRun.fetchHistory();
        const continuedEvent = (history.events ?? []).find(
          (event) => event.workflowExecutionContinuedAsNewEventAttributes != null,
        );
        expect(continuedEvent).toBeDefined();
        const continuedInput = decodeContinuedInput(continuedEvent);
        expect(continuedInput).toEqual({
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId,
          maxTurnsPerRun: 1,
        });
        expect(continuedInput.initialEventId).toBeUndefined();
      } finally {
        worker.shutdown();
        await run;
      }
    },
    continueAsNewTestTimeoutMs,
  );
});

function decodeContinuedInput(
  event:
    | {
        workflowExecutionContinuedAsNewEventAttributes?: {
          input?: { payloads?: unknown[] | null } | null;
        } | null;
      }
    | undefined,
): Record<string, unknown> {
  const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0] as
    | { data?: Uint8Array }
    | undefined;
  if (!payload?.data) {
    throw new Error("continueAsNew event carried no input payload");
  }
  return JSON.parse(Buffer.from(payload.data).toString("utf8")) as Record<string, unknown>;
}

function queuedTurn(triggerEventId: string): { id: string; triggerEventId: string } {
  return {
    id: crypto.randomUUID(),
    triggerEventId,
  };
}

function workflowScope(): { accountId: string; workspaceId: string } {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
}

async function testWorker(
  nativeConnection: NativeConnection,
  taskQueue: string,
  activities: Record<string, (...args: any[]) => Promise<unknown>>,
): Promise<Worker> {
  return await Worker.create({
    connection: nativeConnection,
    namespace: "default",
    taskQueue,
    workflowsPath: new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname,
    activities: {
      // Goal-less defaults; individual tests override these to exercise the
      // goal continuation loop.
      maybeContinueGoal: async () => ({ action: "none" }),
      pauseGoalForInterrupt: async () => undefined,
      getCodexCapacityWait: async () => null,
      reconcileCodexCapacityWait: async () => ({ action: "stale" }),
      ...activities,
      // Mirror production registration: the session workflow schedules the
      // LEGACY activity name (replay safety for in-flight multi-day sessions),
      // so the turn mock must answer to it as well.
      ...(activities.runAgentTurn ? { runAgentSegment: activities.runAgentTurn } : {}),
    },
  });
}
