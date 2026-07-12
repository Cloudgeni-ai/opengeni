import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { waitFor } from "@opengeni/testing";
import {
  Client,
  continueAsNewTestTimeoutMs,
  createTemporalWorkflowTestContext,
  decodeContinuedInput,
  testWorker,
  queuedTurn,
  workflowScope,
  type TemporalWorkflowTestContext,
} from "./temporal-workflow.test-support";

describe("Temporal workflow integration — continue-as-new continuity", () => {
  let context!: TemporalWorkflowTestContext;

  beforeAll(async () => {
    context = await createTemporalWorkflowTestContext();
  }, 300_000);

  afterAll(async () => {
    await context?.close();
  }, 60_000);

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
      const firstWorker = await testWorker(context, taskQueue, activities);
      const firstRun = firstWorker.run();
      const client = new Client({ connection: context.connection });
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId,
        args: [{ ...scope, sessionId, initialEventId: "event-1" }],
      });
      await waitFor(() => runs.length === 1);
      await Bun.sleep(100);
      firstWorker.shutdown();
      await firstRun;

      const replacement = await testWorker(context, taskQueue, activities);
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
          return { action: "none" };
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection: context.connection });
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
      const worker = await testWorker(context, taskQueue, {
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
        const client = new Client({ connection: context.connection });
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
      const worker = await testWorker(context, taskQueue, {
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
        const client = new Client({ connection: context.connection });
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
