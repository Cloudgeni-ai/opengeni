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

describe("Temporal workflow integration", () => {
  let services: TestServices;
  let connection: Connection;
  let nativeConnection: NativeConnection;

  beforeAll(async () => {
    services = await startTestServices({ temporal: true });
    connection = await Connection.connect({ address: services.temporalHost });
    nativeConnection = await NativeConnection.connect({ address: services.temporalHost });
  }, 300_000);

  afterAll(async () => {
    await connection?.close();
    await nativeConnection?.close();
    await services?.down();
  }, 60_000);

  test("dispatches initial and follow-up user message activities", async () => {
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
  }, temporalWorkflowTestTimeoutMs);

  test("waits for approval before resuming a requires_action segment", async () => {
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
  }, temporalWorkflowTestTimeoutMs);

  test("does not retry failed agent activities", async () => {
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
  }, temporalWorkflowTestTimeoutMs);

  test("re-dispatches a preempted turn instead of failing the session", async () => {
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
  }, temporalWorkflowTestTimeoutMs);

  test("re-dispatches a turn whose worker died (heartbeat timeout) instead of failing the session", async () => {
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
      expect(requeues).toEqual([expect.objectContaining({ turnId: turn.id, triggerEventId: "event-1" })]);
      expect(failures).toHaveLength(0);
    } finally {
      worker.shutdown();
      await run;
    }
  }, workerDeathTestTimeoutMs);

  test("fails the session for real once worker-death re-dispatches exceed the ceiling", async () => {
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
  }, workerDeathTestTimeoutMs);

  test("idle interrupt marks the session idle without cancelling a turn", async () => {
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
  }, temporalWorkflowTestTimeoutMs);

  test("interrupt during an active run cancels the active turn and continues queued work", async () => {
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
      expect(interrupts).toEqual([{ ...scope, sessionId, triggerEventId: "interrupt-event", workflowId }]);
      expect(runs[1]).toMatchObject({ ...scope, sessionId, turnId: second.id, triggerEventId: second.triggerEventId, workflowId });
    } finally {
      allowFirstRunToFinish = true;
      worker.shutdown();
      await run;
    }
  }, temporalWorkflowTestTimeoutMs);

  test("interrupt while awaiting approval cancels the blocked turn and continues queued work", async () => {
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
      expect(interrupts).toEqual([{ ...scope, sessionId, triggerEventId: "interrupt-event", workflowId }]);
      expect(runs[1]).toMatchObject({ ...scope, sessionId, turnId: second.id, triggerEventId: second.triggerEventId, workflowId });
    } finally {
      worker.shutdown();
      await run;
    }
  }, temporalWorkflowTestTimeoutMs);

  test("synthesizes goal continuation turns until the goal declines", async () => {
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
      expect(runs.map((input) => input.triggerEventId)).toEqual(["event-1", "goal-event-1", "goal-event-2"]);
      expect(goalChecks.length).toBeGreaterThanOrEqual(3);
      expect(goalChecks[0]).toMatchObject({ ...scope, sessionId, workflowId });
    } finally {
      worker.shutdown();
      await run;
    }
  }, temporalWorkflowTestTimeoutMs);

  test("holds the loop for continueDelayMs before the goal continuation check", async () => {
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
  }, temporalWorkflowTestTimeoutMs);

  test("idle interrupt pauses the goal before marking the session idle", async () => {
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
      expect(pauses).toEqual([{ workspaceId: scope.workspaceId, sessionId }]);
    } finally {
      worker.shutdown();
      await run;
    }
  }, temporalWorkflowTestTimeoutMs);

  test("a failing goal continuation check falls back to idle shutdown", async () => {
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
  }, temporalWorkflowTestTimeoutMs);

  test("dispatches document index workflow activity", async () => {
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
        args: [{ accountId: scope.accountId, workspaceId: scope.workspaceId, documentId: "document-1" }],
      });
      const result = await handle.result();
      expect(calls).toEqual([{ accountId: scope.accountId, workspaceId: scope.workspaceId, documentId: "document-1" }]);
      expect(result).toMatchObject({ id: "document-1", status: "ready" });
    } finally {
      worker.shutdown();
      await run;
    }
  }, temporalWorkflowTestTimeoutMs);

  test("scheduled task fire workflow starts a session child workflow", async () => {
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
      expect(dispatches[0]).toMatchObject({ workspaceId: scope.workspaceId, triggerType: "scheduled" });
      expect(runs[0]).toMatchObject({ ...scope, sessionId, triggerEventId, workflowId: childWorkflowId });
    } finally {
      worker.shutdown();
      await run;
    }
  }, temporalWorkflowTestTimeoutMs);

  test("scheduled task fire workflow signals a reusable session workflow", async () => {
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
  }, temporalWorkflowTestTimeoutMs);
});

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

async function testWorker(nativeConnection: NativeConnection, taskQueue: string, activities: Record<string, (...args: any[]) => Promise<unknown>>): Promise<Worker> {
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
      ...activities,
      // Mirror production registration: the session workflow schedules the
      // LEGACY activity name (replay safety for in-flight multi-day sessions),
      // so the turn mock must answer to it as well.
      ...(activities.runAgentTurn ? { runAgentSegment: activities.runAgentTurn } : {}),
    },
  });
}
