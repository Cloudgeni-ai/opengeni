import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { startTestServices, type TestServices, waitFor } from "@opengeni/testing";
import { currentActivityContext } from "../../apps/worker/src/activities/streaming";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
} from "../../apps/worker/src/concurrency";
import { turnTaskQueue } from "../../apps/worker/src/workflows/activities";

// An ungraceful worker death cannot be faked by throwing a TimeoutFailure
// from the activity (the worker coerces thrown activity errors into
// ApplicationFailure via ensureApplicationFailure), so the worker-death tests
// produce the REAL failure shape: the mock turn activity hangs without ever
// heartbeating and the Temporal server closes it with a heartbeat timeout
// (the session workflow's proxy sets heartbeatTimeout to 2 minutes), delivering an
// ActivityFailure whose cause is a TimeoutFailure with timeoutType HEARTBEAT
// — exactly what a SIGKILLed worker produces. The hang rejects on the late
// worker cancellation so ignored local completion cannot mutate fake durable
// state, while still allowing the test worker to drain at the end.
async function hangWithoutHeartbeating(): Promise<{ status: string }> {
  await new Promise<void>((_resolve, reject) => {
    const signal = currentActivityContext()?.cancellationSignal;
    if (!signal || signal.aborted) {
      reject(new Error("simulated dead worker activity cancelled after timeout"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("simulated dead worker activity cancelled after timeout")),
      { once: true },
    );
  });
  throw new Error("unreachable simulated dead worker completion");
}

// The end-to-end ownership chain has two independently bounded phases: the
// server may spend the full two-minute heartbeat window detecting the dead turn
// worker, then the control-plane recovery activity has its own two-minute
// start-to-close contract. Leave scheduling and worker-drain slack after both
// phases so a loaded CI host cannot cancel a valid recovery at the boundary.
// This finite test ceiling does not change either runtime timeout.
const workerDeathTestTimeoutMs = 360_000;

const temporalWorkflowTestTimeoutMs = 30_000;

// Goal-continuation cases run real workflow timers and activities after the two
// long heartbeat-recovery proofs. On a loaded shared runner, task polling and
// worker drain can legitimately exceed the general 30s test ceiling even though
// the workflow's delay and settlement assertions still pass. Keep a finite,
// narrowly scoped ceiling so a timed-out test cannot strand its worker and
// cascade into the following cases; this does not change any runtime timeout.
const goalContinuationTestTimeoutMs = 60_000;

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
      ? ({
          temporalHost: externalTemporalHost,
          down: async () => undefined,
        } as TestServices)
      : await startTestServices({ temporal: true });
    connection = await Connection.connect({ address: services.temporalHost });
    nativeConnection = await NativeConnection.connect({
      address: services.temporalHost,
    });
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
      const admission = createTurnAdmission(queuedTurns, async (input) => {
        calls.push(input);
        return { status: "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [
            {
              ...scope,
              sessionId: crypto.randomUUID(),
              initialEventId: "event-1",
            },
          ],
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
      const admission = createTurnAdmission(queuedTurns, async (input) => {
        calls.push(input);
        return { status: calls.length === 1 ? "requires_action" : "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [
            {
              ...scope,
              sessionId: crypto.randomUUID(),
              initialEventId: "event-1",
            },
          ],
        });
        await waitFor(() => calls.length === 1);
        await Bun.sleep(300);
        expect(calls).toHaveLength(1);
        admission.approve("approval-event");
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
      const admission = createTurnAdmission(queuedTurns, async () => {
        attempts += 1;
        throw new Error("boom");
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async (input: unknown) => {
          failures.push(input);
        },
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [
            {
              ...scope,
              sessionId: crypto.randomUUID(),
              initialEventId: "event-1",
            },
          ],
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
    "re-dispatches the same recovering inference instead of failing the session",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const turn = queuedTurn("event-1");
      const queuedTurns = [turn];
      const runs: Array<{
        trigger: { kind: string; triggerEventId?: string };
      }> = [];
      const failures: unknown[] = [];
      const admission = createTurnAdmission(queuedTurns, async (input) => {
        runs.push(input as (typeof runs)[number]);
        return { status: runs.length === 1 ? "recovering" : "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async (input: unknown) => {
          failures.push(input);
        },
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [
            {
              ...scope,
              sessionId: crypto.randomUUID(),
              initialEventId: "event-1",
            },
          ],
        });
        await handle.result();
        expect(runs).toHaveLength(2);
        expect(runs.map((attempt) => attempt.trigger)).toEqual([
          { kind: "next" },
          { kind: "next" },
        ]);
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
      const runs: Array<{ attemptId: string; trigger: { kind: string } }> = [];
      const recoveries: Array<{
        attemptId: string;
        timeoutType: string;
      }> = [];
      const failures: unknown[] = [];
      const admission = createTurnAdmission(queuedTurns, async (input) => {
        runs.push(input as (typeof runs)[number]);
        if (runs.length === 1) return await hangWithoutHeartbeating();
        return { status: "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        recoverDispatch: async (input: { attemptId: string; timeoutType: string }) => {
          recoveries.push(input);
          admission.recover();
          return { action: "recovering", turnId: turn.id, redispatches: 1 };
        },
        failSessionAttempt: async (input: unknown) => {
          failures.push(input);
        },
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [
            {
              ...scope,
              sessionId: crypto.randomUUID(),
              initialEventId: "event-1",
            },
          ],
        });
        await handle.result();
        expect(runs).toHaveLength(2);
        expect(runs.map((attempt) => attempt.trigger)).toEqual([
          { kind: "next" },
          { kind: "next" },
        ]);
        expect(recoveries).toEqual([
          expect.objectContaining({
            attemptId: runs[0]!.attemptId,
            timeoutType: "HEARTBEAT",
          }),
        ]);
        expect(failures).toHaveLength(0);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    workerDeathTestTimeoutMs,
  );

  for (const reason of ["provider_invalid_content", "transport_acceptance_unknown"] as const) {
    test(
      `a real heartbeat timeout settles ${reason} checkpoint without re-running the turn`,
      async () => {
        // Database integration proves the exact history/attempt/generation
        // transaction. This workflow proof supplies the real Temporal
        // ActivityFailure -> HEARTBEAT TimeoutFailure shape and verifies that
        // the terminal recovery result cannot dispatch runAgentTurn twice.
        const taskQueue = `workflow-test-${crypto.randomUUID()}`;
        const scope = workflowScope();
        const turn = queuedTurn("event-1");
        const queuedTurns = [turn];
        const runs: Array<{ attemptId: string }> = [];
        const recoveries: Array<{ attemptId: string; timeoutType: string }> = [];
        const failures: unknown[] = [];
        const admission = createTurnAdmission(queuedTurns, async (input) => {
          runs.push(input as (typeof runs)[number]);
          return await hangWithoutHeartbeating();
        });
        const worker = await testWorker(nativeConnection, taskQueue, {
          ...admission.activities,
          markSessionIdle: async () => undefined,
          recoverDispatch: async (input: { attemptId: string; timeoutType: string }) => {
            recoveries.push(input);
            admission.settleNoReplay();
            return {
              action: "settled_no_replay",
              turnId: turn.id,
              reason,
              checkpointSucceeded: true,
            };
          },
          failSessionAttempt: async (input: unknown) => {
            failures.push(input);
          },
          settleSessionInterruptions: async () => ({
            action: "continue" as const,
          }),
        });
        const run = worker.run();
        try {
          const client = new Client({ connection });
          const handle = await client.workflow.start("sessionWorkflow", {
            taskQueue,
            workflowId: `wf-${crypto.randomUUID()}`,
            args: [
              {
                ...scope,
                sessionId: crypto.randomUUID(),
                initialEventId: "event-1",
              },
            ],
          });
          await handle.result();
          expect(runs).toHaveLength(1);
          expect(recoveries).toEqual([
            expect.objectContaining({
              attemptId: runs[0]!.attemptId,
              timeoutType: "HEARTBEAT",
            }),
          ]);
          expect(failures).toHaveLength(0);
        } finally {
          worker.shutdown();
          await run;
        }
      },
      workerDeathTestTimeoutMs,
    );
  }

  for (const reason of ["provider_invalid_content", "transport_acceptance_unknown"] as const) {
    test(
      `a real heartbeat timeout terminally consumes incomplete ${reason} history without goal continuation`,
      async () => {
        const taskQueue = `workflow-test-${crypto.randomUUID()}`;
        const scope = workflowScope();
        const turn = queuedTurn("event-1");
        const queuedTurns = [turn];
        const runs: Array<{ attemptId: string }> = [];
        const recoveries: Array<{ attemptId: string; timeoutType: string }> = [];
        const goalChecks: unknown[] = [];
        const failures: unknown[] = [];
        const admission = createTurnAdmission(queuedTurns, async (input) => {
          runs.push(input as (typeof runs)[number]);
          return await hangWithoutHeartbeating();
        });
        const worker = await testWorker(nativeConnection, taskQueue, {
          ...admission.activities,
          markSessionIdle: async () => undefined,
          maybeContinueGoal: async (input: unknown) => {
            goalChecks.push(input);
            return { action: "none" as const };
          },
          recoverDispatch: async (input: { attemptId: string; timeoutType: string }) => {
            recoveries.push(input);
            admission.settleNoReplay();
            return {
              action: "settled_no_replay",
              turnId: turn.id,
              reason,
              checkpointSucceeded: false,
            };
          },
          failSessionAttempt: async (input: unknown) => {
            failures.push(input);
          },
          settleSessionInterruptions: async () => ({
            action: "continue" as const,
          }),
        });
        const run = worker.run();
        try {
          const client = new Client({ connection });
          const handle = await client.workflow.start("sessionWorkflow", {
            taskQueue,
            workflowId: `wf-${crypto.randomUUID()}`,
            args: [
              {
                ...scope,
                sessionId: crypto.randomUUID(),
                initialEventId: "event-1",
              },
            ],
          });
          await handle.result();
          expect(runs).toHaveLength(1);
          expect(recoveries).toEqual([
            expect.objectContaining({
              attemptId: runs[0]!.attemptId,
              timeoutType: "HEARTBEAT",
            }),
          ]);
          expect(goalChecks).toHaveLength(0);
          expect(failures).toHaveLength(0);
        } finally {
          worker.shutdown();
          await run;
        }
      },
      workerDeathTestTimeoutMs,
    );
  }

  test(
    "stops after atomic worker-death settlement exceeds the re-dispatch ceiling",
    async () => {
      // The counter mechanics and atomic terminal write are proven against the
      // real recoverTurnAfterWorkerDeath activity in worker-activity.integration.ts;
      // this proves the workflow honors that already-durable "exceeded" winner
      // on a real heartbeat-timeout failure without a second failSession write.
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const turn = queuedTurn("event-1");
      const queuedTurns = [turn];
      const runs: unknown[] = [];
      const recoveries: Array<{ attemptId: string; timeoutType: string }> = [];
      const failures: Array<{ error?: string }> = [];
      const admission = createTurnAdmission(queuedTurns, async (input) => {
        runs.push(input);
        return await hangWithoutHeartbeating();
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        recoverDispatch: async (input: { attemptId: string; timeoutType: string }) => {
          recoveries.push(input);
          return { action: "exceeded", turnId: turn.id, redispatches: 3 };
        },
        failSessionAttempt: async (input: { error?: string }) => {
          failures.push(input);
        },
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [
            {
              ...scope,
              sessionId: crypto.randomUUID(),
              initialEventId: "event-1",
            },
          ],
        });
        await handle.result();
        expect(runs).toHaveLength(1);
        expect(recoveries).toEqual([
          expect.objectContaining({
            timeoutType: "HEARTBEAT",
          }),
        ]);
        // The worker-death activity has already atomically failed the exact
        // turn/session and appended terminal events. The workflow must not run
        // a second split failSession settlement after that durable winner.
        expect(failures).toHaveLength(0);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    workerDeathTestTimeoutMs,
  );

  test(
    "idle Pause is already durable and never invents an attempt interruption",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const idleMarks: unknown[] = [];
      const controls: unknown[] = [];
      const worker = await testWorker(nativeConnection, taskQueue, {
        peekSessionWork: async () => ({ kind: "idle" as const }),
        markSessionIdle: async (input: unknown) => {
          idleMarks.push(input);
        },
        runAgentTurn: async () => ({ status: "idle" }),
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async (input: unknown) => {
          controls.push(input);
          return { action: "continue" as const };
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
        await handle.signal("sessionControl", "control-event");
        await handle.result();
        expect(idleMarks.length).toBeGreaterThanOrEqual(1);
        expect(
          idleMarks.every(
            (mark) =>
              JSON.stringify(mark) ===
              JSON.stringify({ workspaceId: scope.workspaceId, sessionId }),
          ),
        ).toBe(true);
        expect(controls).toHaveLength(0);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "Pause start-or-signals an idle session with no running workflow",
    async () => {
      // Reproduces the operator-can't-stop bug: a long-lived session that has gone
      // idle has NO running workflow execution. The OLD API client did
      // getHandle(workflowId).signal("sessionControl", …), which throws
      // WorkflowNotFoundError -> a 500. The FIXED client uses signalWithStart
      // exactly as wired below; it must start a fresh sessionWorkflow that
      // observes the Pause already committed by the API and closes through the
      // normal idle settlement, with no active attempt to interrupt.
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `wf-${crypto.randomUUID()}`;
      const idleMarks: unknown[] = [];
      const controls: unknown[] = [];
      const worker = await testWorker(nativeConnection, taskQueue, {
        peekSessionWork: async () => ({ kind: "idle" as const }),
        markSessionIdle: async (input: unknown) => {
          idleMarks.push(input);
        },
        runAgentTurn: async () => ({ status: "idle" }),
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async (input: unknown) => {
          controls.push(input);
          return { action: "continue" as const };
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        // EXACT production API-client wiring: no prior workflow.start — the only
        // call is signalWithStart, the start-or-signal path the fixed
        // signalSessionControl uses. Against a not-running workflow this must START it.
        const handle = await client.workflow.signalWithStart("sessionWorkflow", {
          taskQueue,
          workflowId,
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [{ ...scope, sessionId }],
          signal: "sessionControl",
          signalArgs: ["control-event"],
        });
        await handle.result();
        expect(idleMarks).toEqual([{ workspaceId: scope.workspaceId, sessionId }]);
        expect(controls).toHaveLength(0);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "a resume wake racing the final paused settlement cannot be closed into the old run",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const interruptedAttemptId = crypto.randomUUID();
      let pendingInterruption = true;
      let resumedWork = false;
      let turnRuns = 0;
      let releaseSettlement!: () => void;
      const settlementRelease = new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      });
      let settlementEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        settlementEntered = resolve;
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        peekSessionWork: async () => {
          if (pendingInterruption) {
            return {
              kind: "interruption-pending",
              attemptId: interruptedAttemptId,
            } as const;
          }
          return resumedWork && turnRuns === 0
            ? ({ kind: "runnable" } as const)
            : ({ kind: "idle" } as const);
        },
        settleSessionInterruptions: async () => {
          settlementEntered();
          await settlementRelease;
          pendingInterruption = false;
          return { action: "paused" as const };
        },
        runAgentTurn: async (input: { attemptId: string }) => {
          turnRuns += 1;
          return {
            status: "idle" as const,
            turnId: "resumed-turn",
            attemptId: input.attemptId,
          };
        },
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflow", {
          taskQueue,
          workflowId: `wf-${crypto.randomUUID()}`,
          args: [{ ...scope, sessionId: crypto.randomUUID() }],
        });
        await entered;
        resumedWork = true;
        await handle.signal("queueChanged");
        releaseSettlement();
        await waitFor(() => turnRuns === 1);
        await handle.result();
        expect(turnRuns).toBe(1);
      } finally {
        releaseSettlement();
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "Steer during an active run supersedes the active attempt and continues queued work",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `wf-${crypto.randomUUID()}`;
      const first = queuedTurn("event-1");
      const second = queuedTurn("event-2");
      const queuedTurns = [first];
      const runs: WorkflowTestTurn[] = [];
      const controls: unknown[] = [];
      let allowFirstRunToFinish = false;
      const admission = createTurnAdmission(queuedTurns, async (_input, turn) => {
        runs.push(turn);
        if (runs.length === 1) {
          while (true) {
            if (allowFirstRunToFinish) break;
            await Bun.sleep(10);
          }
        }
        return { status: "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async (input: unknown) => {
          controls.push(input);
          allowFirstRunToFinish = true;
          return { action: "continue" as const };
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
        await handle.signal("sessionControl", "control-event");
        await waitFor(() => runs.length === 2);
        expect(controls).toEqual([
          { ...scope, sessionId, attemptId: expect.any(String), workflowId },
          {
            ...scope,
            sessionId,
            attemptId: expect.any(String),
            workflowId,
            phase: "attempt_quiesced",
          },
        ]);
        expect((controls[1] as { attemptId: string }).attemptId).toBe(
          (controls[0] as { attemptId: string }).attemptId,
        );
        expect(runs[1]).toEqual(second);
      } finally {
        allowFirstRunToFinish = true;
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "Steer fails closed without a quiescence receipt when the cancelled activity terminates as a failure",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `wf-${crypto.randomUUID()}`;
      const first = queuedTurn("event-1");
      const second = queuedTurn("event-2");
      const queuedTurns = [first];
      const controls: unknown[] = [];
      let runs = 0;
      let terminateFirst = false;
      const admission = createTurnAdmission(queuedTurns, async () => {
        runs += 1;
        if (runs === 1) {
          await waitFor(() => terminateFirst);
          throw new Error("physical cancellation was not confirmed");
        }
        return { status: "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async (input: unknown) => {
          controls.push(input);
          terminateFirst = true;
          return { action: "continue" as const };
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
        await waitFor(() => runs === 1);
        queuedTurns.push(second);
        await handle.signal("userMessage", second.triggerEventId);
        await handle.signal("sessionControl", "control-event");
        await expect(handle.result()).rejects.toBeDefined();

        expect(runs).toBe(1);
        expect(controls).toEqual([
          { ...scope, sessionId, attemptId: expect.any(String), workflowId },
        ]);
      } finally {
        terminateFirst = true;
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "Steer while awaiting approval supersedes the blocked turn and continues queued work",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `wf-${crypto.randomUUID()}`;
      const first = queuedTurn("event-1");
      const second = queuedTurn("event-2");
      const queuedTurns = [first];
      const runs: WorkflowTestTurn[] = [];
      const controls: unknown[] = [];
      const admission = createTurnAdmission(queuedTurns, async (_input, turn) => {
        runs.push(turn);
        return { status: runs.length === 1 ? "requires_action" : "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async (input: unknown) => {
          controls.push(input);
          admission.supersede();
          return { action: "continue" as const };
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
        admission.requestInterruption();
        await handle.signal("userMessage", second.triggerEventId);
        await handle.signal("sessionControl", "control-event");
        await waitFor(() => runs.length === 2);
        expect(controls).toEqual([
          { ...scope, sessionId, attemptId: expect.any(String), workflowId },
        ]);
        expect(runs[1]).toEqual(second);
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
      const runs: string[] = [];
      const goalChecks: unknown[] = [];
      const queuedTurns = [queuedTurn("event-1")];
      let continuations = 0;
      const admission = createTurnAdmission(queuedTurns, async (_input, turn) => {
        runs.push(turn.triggerEventId);
        return { status: "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
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
        expect(runs).toEqual(["event-1", "goal-event-1", "goal-event-2"]);
        expect(goalChecks.length).toBeGreaterThanOrEqual(3);
        expect(goalChecks[0]).toMatchObject({
          ...scope,
          sessionId,
          workflowId,
        });
      } finally {
        worker.shutdown();
        await run;
      }
    },
    goalContinuationTestTimeoutMs,
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
      const admission = createTurnAdmission([queuedTurn("event-1")], async () => {
        segmentReturnedAt = Date.now();
        // Provider backpressure idle: the workflow must hold the loop before
        // admitting the goal continuation.
        return { status: "idle", continueDelayMs: delayMs };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
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
    goalContinuationTestTimeoutMs,
  );

  test(
    "a failing goal continuation check falls back to idle shutdown",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const idleMarks: unknown[] = [];
      const goalRetryWakes: unknown[] = [];
      const queuedTurns = [queuedTurn("event-1")];
      const runs: unknown[] = [];
      const admission = createTurnAdmission(queuedTurns, async (input) => {
        runs.push(input);
        return { status: "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async (input: unknown) => {
          idleMarks.push(input);
        },
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
        maybeContinueGoal: async () => {
          throw new Error("goal store unavailable");
        },
        enqueueGoalRetryWake: async (input: unknown) => {
          goalRetryWakes.push(input);
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
        expect(goalRetryWakes).toEqual([
          {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            sessionId,
            workflowId: expect.any(String),
          },
        ]);
        expect(idleMarks).toEqual([{ workspaceId: scope.workspaceId, sessionId }]);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    goalContinuationTestTimeoutMs,
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
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
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
          {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            documentId: "document-1",
          },
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
    "scheduled task fire workflow delegates one durable dispatch activity",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const dispatches: unknown[] = [];
      const sessionId = crypto.randomUUID();
      const triggerEventId = crypto.randomUUID();
      const childWorkflowId = `session-${sessionId}`;
      const worker = await testWorker(nativeConnection, taskQueue, {
        runAgentTurn: async () => ({ status: "idle" }),
        dispatchScheduledTaskRun: async (input: unknown) => {
          dispatches.push(input);
          return {
            action: "start",
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            sessionId,
            triggerEventId,
            workflowId: childWorkflowId,
            workflowWakeRevision: 1,
          };
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("scheduledTaskFireWorkflow", {
          taskQueue,
          workflowId: `scheduled-fire-${crypto.randomUUID()}`,
          args: [
            {
              ...scope,
              taskId: crypto.randomUUID(),
              triggerType: "scheduled",
            },
          ],
        });
        await handle.result();
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]).toMatchObject({
          workspaceId: scope.workspaceId,
          triggerType: "scheduled",
        });
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "workflow-wake dispatcher delegates one bounded canonical outbox sweep",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      let dispatches = 0;
      const expected = {
        claimed: 4,
        delivered: 4,
        failed: 0,
        exhaustedBatchLimit: false,
      };
      const worker = await testWorker(nativeConnection, taskQueue, {
        runAgentTurn: async () => ({ status: "idle" }),
        dispatchSessionWorkflowWakes: async () => {
          dispatches += 1;
          return expected;
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const handle = await client.workflow.start("sessionWorkflowWakeDispatcherWorkflow", {
          taskQueue,
          workflowId: `wake-dispatch-${crypto.randomUUID()}`,
          args: [],
        });
        expect(await handle.result()).toEqual(expected);
        expect(dispatches).toBe(1);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    temporalWorkflowTestTimeoutMs,
  );

  test(
    "scheduled task fire workflow delegates reusable delivery to the activity",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const dispatches: unknown[] = [];
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      const triggerEventId = crypto.randomUUID();
      const worker = await testWorker(nativeConnection, taskQueue, {
        runAgentTurn: async () => ({ status: "idle" }),
        dispatchScheduledTaskRun: async (input: unknown) => {
          dispatches.push(input);
          return {
            action: "signal",
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            sessionId,
            triggerEventId,
            workflowId,
            workflowWakeRevision: 1,
          };
        },
      });
      const run = worker.run();
      try {
        const client = new Client({ connection });
        const fire = await client.workflow.start("scheduledTaskFireWorkflow", {
          taskQueue,
          workflowId: `scheduled-fire-${crypto.randomUUID()}`,
          args: [{ ...scope, taskId: crypto.randomUUID(), triggerType: "manual" }],
        });
        await fire.result();
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]).toMatchObject({
          workspaceId: scope.workspaceId,
          triggerType: "manual",
        });
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
      const runs: string[] = [];
      const reconciliations: Array<{ cause: string }> = [];
      const waiter = {
        waiterId: crypto.randomUUID(),
        generation: 1,
        nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
        wakeRevision: 1,
      };
      let resumed = false;
      const admission = createTurnAdmission(queuedTurns, async (_input, turn) => {
        runs.push(turn.triggerEventId);
        return turn.triggerEventId === "event-1"
          ? { status: "idle", capacityWait: waiter }
          : { status: "failed" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
        getCodexCapacityWait: async () => (resumed ? null : waiter),
        reconcileCodexCapacityWait: async (input: { cause: string }) => {
          reconciliations.push(input);
          if (!resumed) {
            resumed = true;
            admission.resumeCapacity();
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
        expect(runs).toEqual(["event-1", "capacity-resume"]);
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
      const runs: string[] = [];
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
      const admission = createTurnAdmission(queuedTurns, async (_input, turn) => {
        runs.push(turn.triggerEventId);
        if (turn.triggerEventId === "event-1") {
          await firstRunBlocked;
          return { status: "idle", capacityWait: waiter };
        }
        return { status: "failed" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
        getCodexCapacityWait: async () => waiter,
        reconcileCodexCapacityWait: async (input: { cause: string }) => {
          reconciliationCauses.push(input.cause);
          admission.resumeCapacity();
          queuedTurns.push(queuedTurn("capacity-resume"));
          return { action: "resumed", turnId: queuedTurns[0]!.id };
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
        await handle.signal("codexCapacityChanged", waiter.wakeRevision + 1);
        releaseFirstRun();
        await handle.result();
        expect(reconciliationCauses).toEqual(["signal"]);
        expect(runs).toEqual(["event-1", "capacity-resume"]);
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
      const runs: string[] = [];
      let goalChecks = 0;
      let reconciliations = 0;
      let resumed = false;
      const waiter = {
        waiterId: crypto.randomUUID(),
        generation: 7,
        nextCheckAt: new Date(0).toISOString(),
        wakeRevision: 3,
      };
      const admission = createTurnAdmission(queuedTurns, async (_input, turn) => {
        runs.push(turn.triggerEventId);
        return turn.triggerEventId === "event-1"
          ? { status: "idle", capacityWait: waiter }
          : { status: "failed" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
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
          admission.resumeCapacity();
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
        expect(runs).toEqual(["event-1", "capacity-after-continue-as-new"]);
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
      const runs: string[] = [];
      const waiter = {
        waiterId: crypto.randomUUID(),
        generation: 11,
        nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
        wakeRevision: 4,
      };
      let resumed = false;
      let reconciliations = 0;
      const admission = createTurnAdmission(queuedTurns, async (_input, turn) => {
        runs.push(turn.triggerEventId);
        return turn.triggerEventId === "event-1"
          ? { status: "idle", capacityWait: waiter }
          : { status: "failed" };
      });
      const activities = {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
        getCodexCapacityWait: async () => (resumed ? null : waiter),
        reconcileCodexCapacityWait: async () => {
          reconciliations += 1;
          resumed = true;
          admission.resumeCapacity();
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
        expect(runs).toEqual(["event-1", "capacity-after-worker-restart"]);
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
      const runs: string[] = [];
      const goalChecks: unknown[] = [];
      const admission = createTurnAdmission(queuedTurns, async (_input, turn) => {
        runs.push(turn.triggerEventId);
        return { status: "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
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
          args: [
            {
              ...scope,
              sessionId,
              initialEventId: "event-1",
              maxTurnsPerRun: 1,
            },
          ],
        });
        // The handle follows the continueAsNew chain: it resolves only when the
        // FINAL run completes (idle, after both turns drained).
        await handle.result();
        // Both turns ran exactly once, in order, across the continueAsNew split.
        expect(runs).toEqual(["event-1", "event-2"]);

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
      const runs: string[] = [];
      const admission = createTurnAdmission(queuedTurns, async (_input, turn) => {
        runs.push(turn.triggerEventId);
        return { status: "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
        maybeContinueGoal: async () => ({ action: "none" }),
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
              maxTurnsPerRun: 1,
            },
          ],
        });
        await waitFor(() => runs.length === 1);
        // Mirror the signaler contract: write the turn to the durable queue, THEN
        // signal. The signal lands while the first run is at (or racing toward)
        // its continueAsNew boundary.
        queuedTurns.push(queuedTurn("event-2"));
        await client.workflow.getHandle(workflowId).signal("queueChanged");
        await handle.result();
        // The follow-up turn was claimed by the continued run, not lost.
        expect(runs).toEqual(["event-1", "event-2"]);
      } finally {
        worker.shutdown();
        await run;
      }
    },
    continueAsNewTestTimeoutMs,
  );

  test(
    "a stale approval signal does not wedge the durable continueAsNew boundary",
    async () => {
      const taskQueue = `workflow-test-${crypto.randomUUID()}`;
      const scope = workflowScope();
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      // Approval truth lives in Postgres. Temporal signals are wakeups only, so a
      // duplicate/stale signal cannot manufacture another approval dispatch or
      // prevent continue-as-new. The durable pending approval is accepted once;
      // the surplus signal is ignored when the next peek observes normal work.
      const queuedTurns = [queuedTurn("event-1"), queuedTurn("event-2")];
      const runs: string[] = [];
      const admission = createTurnAdmission(queuedTurns, async (input, turn) => {
        const eventId =
          input.trigger.kind === "approval" ? input.trigger.triggerEventId : turn.triggerEventId;
        runs.push(eventId);
        return { status: eventId === "event-1" ? "requires_action" : "idle" };
      });
      const worker = await testWorker(nativeConnection, taskQueue, {
        ...admission.activities,
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
        maybeContinueGoal: async () => ({ action: "none" }),
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
              maxTurnsPerRun: 1,
            },
          ],
        });
        // Wait until the first turn is blocked on approval, then submit two
        // signals. Only approval-1 exists in durable admission state.
        await waitFor(() => runs.length === 1);
        admission.approve("approval-1");
        await client.workflow.getHandle(workflowId).signal("approvalDecision", "approval-1");
        await client.workflow.getHandle(workflowId).signal("approvalDecision", "approval-2");
        // The handle follows the continueAsNew chain: it resolves only if the
        // boundary was NOT wedged and the continued run drained event-2 to idle.
        await handle.result();
        // event-1 (requires_action), approval-1 (re-run to idle), event-2 (on the
        // continued run). The stale approval-2 never drives a dispatch.
        expect(runs).toEqual(["event-1", "approval-1", "event-2"]);

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

type WorkflowTestTurn = { id: string; triggerEventId: string };

function createTurnAdmission(
  queuedTurns: WorkflowTestTurn[],
  run: (
    input: {
      attemptId: string;
      trigger: { kind: "next" } | { kind: "approval"; triggerEventId: string };
      [key: string]: unknown;
    },
    turn: WorkflowTestTurn,
  ) => Promise<Record<string, unknown>>,
) {
  let current: WorkflowTestTurn | null = null;
  let currentAttemptId: string | null = null;
  let currentState: "running" | "approval" | "recovering" | "capacity" | null = null;
  let interruptionPending = false;
  let approvalEventId: string | null = null;
  let capacityRef: {
    waiterId: string;
    generation: number;
    nextCheckAt: string;
    wakeRevision: number;
  } | null = null;
  return {
    approve(eventId: string) {
      approvalEventId = eventId;
    },
    recover() {
      if (!current) throw new Error("cannot recover without a current turn");
      currentState = "recovering";
    },
    settleNoReplay() {
      if (!current) throw new Error("cannot terminally settle without a current turn");
      current = null;
      currentAttemptId = null;
      currentState = null;
    },
    requestInterruption() {
      if (!currentAttemptId) throw new Error("cannot interrupt without a current attempt");
      interruptionPending = true;
    },
    resumeCapacity() {
      if (currentState !== "capacity") {
        throw new Error("cannot resume without a durable capacity wait");
      }
      currentState = null;
      capacityRef = null;
    },
    supersede() {
      current = null;
      currentAttemptId = null;
      currentState = null;
      interruptionPending = false;
      approvalEventId = null;
      capacityRef = null;
    },
    activities: {
      peekSessionWork: async () => {
        if (interruptionPending) {
          if (!currentAttemptId) throw new Error("interruption lost its current attempt");
          return {
            kind: "interruption-pending",
            attemptId: currentAttemptId,
          } as const;
        }
        if (currentState === "approval") {
          return approvalEventId
            ? ({
                kind: "approval-pending",
                triggerEventId: approvalEventId,
              } as const)
            : ({ kind: "approval-wait" } as const);
        }
        if (currentState === "capacity") {
          if (!capacityRef) throw new Error("capacity admission lost its durable waiter");
          return { kind: "capacity-wait", ref: capacityRef } as const;
        }
        if (currentState === "recovering" || queuedTurns.length > 0) {
          return { kind: "runnable" } as const;
        }
        return { kind: "idle" } as const;
      },
      runAgentTurn: async (input: {
        attemptId: string;
        trigger: { kind: "next" } | { kind: "approval"; triggerEventId: string };
        [key: string]: unknown;
      }) => {
        if (input.trigger.kind === "approval") {
          if (!current || currentState !== "approval") {
            return { status: "unclaimed", reason: "stale-approval" } as const;
          }
          if (approvalEventId !== input.trigger.triggerEventId) {
            return { status: "unclaimed", reason: "stale-approval" } as const;
          }
          approvalEventId = null;
        } else if (currentState === "recovering") {
          if (!current) throw new Error("recovering admission lost its current turn");
        } else {
          current = queuedTurns.shift() ?? null;
          if (!current) return { status: "unclaimed", reason: "no-work" } as const;
        }
        currentState = "running";
        currentAttemptId = input.attemptId;
        const turn = current;
        const result = await run(input, turn!);
        if (result.status === "requires_action") {
          currentState = "approval";
        } else if (result.status === "recovering") {
          currentState = "recovering";
        } else if (result.capacityWait) {
          current = null;
          currentAttemptId = null;
          currentState = "capacity";
          capacityRef = result.capacityWait as typeof capacityRef;
        } else {
          current = null;
          currentAttemptId = null;
          currentState = null;
        }
        return {
          ...result,
          turnId: turn!.id,
          attemptId: input.attemptId,
        };
      },
    },
  };
}

function queuedTurn(triggerEventId: string): WorkflowTestTurn {
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
): Promise<{ run: () => Promise<void>; shutdown: () => void }> {
  const defaults = {
    enqueueGoalRetryWake: async () => undefined,
    maybeContinueGoal: async () => ({ action: "none" }),
    getCodexCapacityWait: async () => null,
    reconcileCodexCapacityWait: async () => ({ action: "stale" }),
    ...activities,
  };
  const { runAgentTurn, ...controlActivities } = defaults;
  if (!runAgentTurn) throw new Error("turn activity is missing from workflow test");
  const [control, turns] = await Promise.all([
    Worker.create({
      connection: nativeConnection,
      namespace: "default",
      taskQueue,
      workflowsPath: new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname,
      activities: controlActivities,
      maxConcurrentActivityTaskExecutions: CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
    }),
    Worker.create({
      connection: nativeConnection,
      namespace: "default",
      taskQueue: turnTaskQueue(taskQueue),
      activities: { runAgentTurn },
      maxConcurrentActivityTaskExecutions: TURN_WORKER_MAX_CONCURRENT_TURNS,
    }),
  ]);
  return {
    run: async () => {
      await Promise.all([control.run(), turns.run()]);
    },
    shutdown: () => {
      control.shutdown();
      turns.shutdown();
    },
  };
}
