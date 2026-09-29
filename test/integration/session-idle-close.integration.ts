import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection, type WorkflowHandle } from "@temporalio/client";
import { bundleWorkflowCode, NativeConnection, Worker } from "@temporalio/worker";
import { startTestServices, type TestServices, waitFor } from "@opengeni/testing";
import { turnTaskQueue } from "../../apps/worker/src/workflows/activities";
import type { MaybeContinueGoalResult } from "../../apps/worker/src/activities/types";

const patchId = "session-normal-idle-no-grace-v1";
const workflowsPath = new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname;
const legacyWorkflowsPath = new URL(
  "../../apps/worker/test/fixtures/legacy-session-normal-idle-workflow.ts",
  import.meta.url,
).pathname;
const timeoutMs = 60_000;
type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;
type Activities = Record<string, (...args: any[]) => Promise<unknown>>;

// Activities model durable queue truth, not signal payloads. Temporal itself,
// workflow tasks, activity scheduling, timers, signals and replay are real.
function durableQueue() {
  const queued = ["initial"];
  const runs: string[] = [];
  const attempts: string[] = [];
  const calls: string[] = [];
  return {
    queued,
    runs,
    attempts,
    calls,
    activities: {
      peekSessionWork: async () => {
        calls.push("peekSessionWork");
        return { kind: queued.length ? "runnable" : "idle" };
      },
      runAgentTurn: async (input: { attemptId: string }) => {
        calls.push("runAgentTurn");
        attempts.push(input.attemptId);
        const next = queued.shift();
        // Count every dispatch, including an erroneous unclaimed duplicate.
        runs.push(next ?? "UNEXPECTED_EMPTY_DISPATCH");
        return { status: "idle", turnId: crypto.randomUUID(), attemptId: input.attemptId };
      },
      maybeContinueGoal: async (): Promise<MaybeContinueGoalResult> => {
        calls.push("maybeContinueGoal");
        return { action: "none" };
      },
      markSessionIdle: async () => {
        calls.push("markSessionIdle");
      },
    },
  };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function timers(history: History) {
  return history.events?.filter((event) => event.timerStartedEventAttributes) ?? [];
}

function patchIds(history: History): string[] {
  return (history.events ?? []).flatMap((event) => {
    const data = event.markerRecordedEventAttributes?.details?.["patch-data"]?.payloads?.[0]?.data;
    return data ? [JSON.parse(Buffer.from(data).toString("utf8")).id as string] : [];
  });
}

describe("normal session idle close", () => {
  let services: TestServices | undefined;
  let connection: Connection;
  let nativeConnection: NativeConnection;
  let client: Client;
  let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  let legacyBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;

  beforeAll(async () => {
    const external = process.env.OPENGENI_TEST_TEMPORAL_HOST?.trim();
    if (!external) services = await startTestServices({ temporal: true });
    const address = external ?? services!.temporalHost;
    [connection, nativeConnection, workflowBundle, legacyBundle] = await Promise.all([
      Connection.connect({ address }),
      NativeConnection.connect({ address }),
      bundleWorkflowCode({ workflowsPath }),
      bundleWorkflowCode({ workflowsPath: legacyWorkflowsPath }),
    ]);
    client = new Client({ connection });
  }, 300_000);

  afterAll(async () => {
    await connection?.close();
    await nativeConnection?.close();
    await services?.down();
  }, 60_000);

  async function withWorker(
    activities: Activities,
    body: (
      start: () => Promise<WorkflowHandle>,
      options: {
        taskQueue: string;
        workflowId: string;
        args: [{ accountId: string; workspaceId: string; sessionId: string }];
      },
    ) => Promise<void>,
    legacy = false,
  ) {
    const taskQueue = `idle-close-${crypto.randomUUID()}`;
    const options = {
      taskQueue,
      workflowId: `session-${crypto.randomUUID()}`,
      args: [
        {
          accountId: crypto.randomUUID(),
          workspaceId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
        },
      ] as [{ accountId: string; workspaceId: string; sessionId: string }],
    };
    const { runAgentTurn, ...controlActivities } = activities;
    const control = await Worker.create({
      connection: nativeConnection,
      namespace: "default",
      taskQueue,
      workflowBundle: legacy ? legacyBundle : workflowBundle,
      activities: controlActivities,
    });
    const turns = await Worker.create({
      connection: nativeConnection,
      namespace: "default",
      taskQueue: turnTaskQueue(taskQueue),
      activities: { runAgentTurn: runAgentTurn! },
    });
    const handles: WorkflowHandle[] = [];
    const run = Promise.all([control.run(), turns.run()]);
    try {
      await body(async () => {
        const handle = await client.workflow.start("sessionWorkflow", options);
        handles.push(handle);
        return handle;
      }, options);
    } finally {
      // A failing assertion must not leave a live fixture waiting on the server.
      for (const handle of handles) {
        // An ALLOW_DUPLICATE restart has a different run ID: clean up the
        // latest run of this test-owned workflow ID, not only the first run.
        const latest = client.workflow.getHandle(handle.workflowId);
        if ((await latest.describe()).status.name === "RUNNING")
          await latest.terminate("idle-close test cleanup");
      }
      control.shutdown();
      turns.shutdown();
      await run;
    }
  }

  test(
    "settled ordinary work closes without a Temporal timer and preserves the final database recheck",
    async () => {
      const state = durableQueue();
      await withWorker(state.activities, async (start) => {
        const handle = await start();
        await handle.result();
        const history = await handle.fetchHistory();
        expect(timers(history)).toHaveLength(0);
        expect(patchIds(history)).toContain(patchId);
        expect(state.calls).toEqual([
          "peekSessionWork",
          "runAgentTurn",
          "peekSessionWork",
          "maybeContinueGoal",
          "peekSessionWork",
          "markSessionIdle",
        ]);
        expect(state.runs).toEqual(["initial"]);
        await Worker.runReplayHistory({ workflowBundle }, history);
      });
    },
    timeoutMs,
  );

  test(
    "final database recheck admits work committed without a delivered signal",
    async () => {
      const state = durableQueue();
      let committed = false;
      await withWorker(
        {
          ...state.activities,
          maybeContinueGoal: async () => {
            if (!committed) {
              committed = true;
              state.queued.push("committed-before-final-peek");
            }
            return { action: "none" };
          },
        },
        async (start) => {
          const handle = await start();
          await handle.result();
          expect(state.runs).toEqual(["initial", "committed-before-final-peek"]);
          expect(state.calls.filter((call) => call === "markSessionIdle")).toHaveLength(1);
          expect(timers(await handle.fetchHistory())).toHaveLength(0);
        },
      );
    },
    timeoutMs,
  );

  for (const boundary of ["before", "during"] as const) {
    test(
      `signal ${boundary} markSessionIdle re-peeks the same run without duplicate dispatch`,
      async () => {
        const state = durableQueue();
        const gate = barrier();
        let blocked = false;
        let first = true;
        const activities = {
          ...state.activities,
          peekSessionWork: async () => {
            const snapshot = await state.activities.peekSessionWork();
            // Final peek has no includeAdmissionFence: distinguish it from the
            // top-of-loop read by the immediately preceding goal evaluation.
            if (boundary === "before" && first && state.calls.at(-2) === "maybeContinueGoal") {
              first = false;
              blocked = true;
              await gate.promise;
            }
            return snapshot;
          },
          markSessionIdle: async () => {
            await state.activities.markSessionIdle();
            if (boundary === "during" && first) {
              first = false;
              blocked = true;
              await gate.promise;
            }
          },
        };
        await withWorker(activities, async (start) => {
          try {
            const handle = await start();
            await waitFor(() => blocked, { timeoutMs: 20_000 });
            state.queued.push("racing-follow-up");
            await handle.signal("userMessage", "racing-follow-up");
            await handle.signal("queueChanged"); // duplicate wake, not duplicate work
            gate.release();
            await handle.result();
            expect(state.runs).toEqual(["initial", "racing-follow-up"]);
            expect(new Set(state.attempts).size).toBe(2);
            expect(timers(await handle.fetchHistory())).toHaveLength(0);
          } finally {
            // Release before withWorker drains activities, including on a
            // failed signal/assertion; otherwise teardown waits on this gate.
            gate.release();
          }
        });
      },
      timeoutMs,
    );
  }

  for (const decision of ["none", "deferred", "paused"] as const) {
    test(
      `${decision} idle closes; a later ALLOW_DUPLICATE wake restarts the same session exactly once`,
      async () => {
        const state = durableQueue();
        let goalChecks = 0;
        await withWorker(
          {
            ...state.activities,
            maybeContinueGoal: async (): Promise<MaybeContinueGoalResult> => {
              goalChecks += 1;
              return { action: decision };
            },
          },
          async (start, options) => {
            const first = await start();
            await first.result();
            const firstRun = (await first.describe()).runId;
            expect(timers(await first.fetchHistory())).toHaveLength(0);
            expect(state.runs).toEqual(["initial"]);
            expect(goalChecks).toBe(1); // no goal polling during a durable hold/backoff
            state.queued.push("late-follow-up");
            const restarted = await client.workflow.signalWithStart("sessionWorkflow", {
              ...options,
              workflowIdReusePolicy: "ALLOW_DUPLICATE",
              signal: "queueChanged",
            });
            await restarted.result();
            expect((await restarted.describe()).runId).not.toBe(firstRun);
            expect(restarted.workflowId).toBe(first.workflowId);
            expect(state.runs).toEqual(["initial", "late-follow-up"]);
            expect(new Set(state.attempts).size).toBe(2);
            expect(timers(await restarted.fetchHistory())).toHaveLength(0);
          },
        );
      },
      timeoutMs,
    );
  }

  test(
    "held input-wait retains its five-second close-race timer and final recheck",
    async () => {
      const state = durableQueue();
      state.queued.length = 0;
      const waitTurnId = crypto.randomUUID();
      let peeks = 0;
      let settlements = 0;
      await withWorker(
        {
          ...state.activities,
          peekSessionWork: async () => {
            peeks += 1;
            return { kind: "input-wait", disposition: "held", waitTurnId };
          },
          settleSessionInputWait: async () => {
            settlements += 1;
            return { action: "held" };
          },
        },
        async (start) => {
          const handle = await start();
          await handle.result();
          const history = await handle.fetchHistory();
          expect(timers(history)).toHaveLength(1);
          expect(
            Number(timers(history)[0]!.timerStartedEventAttributes!.startToFireTimeout!.seconds),
          ).toBe(5);
          expect(history.events?.filter((event) => event.timerFiredEventAttributes)).toHaveLength(
            1,
          );
          expect(patchIds(history)).not.toContain(patchId);
          expect(peeks).toBe(2);
          expect(settlements).toBe(1);
          expect(state.runs).toEqual([]);
          expect(state.calls).toEqual(["markSessionIdle"]);
        },
      );
    },
    timeoutMs,
  );

  test(
    "upgrades a live legacy idle timer and activates no-grace on the next idle cycle in the same run",
    async () => {
      const state = durableQueue();
      state.queued.length = 0;
      const taskQueue = `idle-upgrade-${crypto.randomUUID()}`;
      const gate = barrier();
      let idleMarks = 0;
      let handle: WorkflowHandle | undefined;
      const { runAgentTurn, ...controlActivities } = state.activities;
      const legacy = await Worker.create({
        connection: nativeConnection,
        namespace: "default",
        taskQueue,
        workflowBundle: legacyBundle,
        activities: controlActivities,
      });
      try {
        // runUntil shuts down ONLY this worker. It neither cancels nor
        // terminates the server workflow, whose legacy timer is still pending.
        await legacy.runUntil(async () => {
          handle = await client.workflow.start("sessionWorkflow", {
            taskQueue,
            workflowId: `session-${crypto.randomUUID()}`,
            args: [
              {
                accountId: crypto.randomUUID(),
                workspaceId: crypto.randomUUID(),
                sessionId: crypto.randomUUID(),
              },
            ],
          });
          await waitFor(async () => timers(await handle!.fetchHistory()).length === 1, {
            timeoutMs: 20_000,
          });
          const pending = await handle.fetchHistory();
          expect(pending.events?.filter((event) => event.timerFiredEventAttributes)).toHaveLength(
            0,
          );
          expect(patchIds(pending)).not.toContain(patchId);
        });
        const running = handle!;
        const originalRunId = (await running.describe()).runId;
        expect((await running.describe()).status.name).toBe("RUNNING");
        const handoff = await running.fetchHistory();
        expect(handoff.events?.filter((event) => event.timerFiredEventAttributes)).toHaveLength(0);

        const upgraded = await Worker.create({
          connection: nativeConnection,
          namespace: "default",
          taskQueue,
          workflowBundle,
          activities: {
            ...controlActivities,
            markSessionIdle: async () => {
              await state.activities.markSessionIdle();
              idleMarks += 1;
              if (idleMarks === 1) await gate.promise;
            },
          },
        });
        const turns = await Worker.create({
          connection: nativeConnection,
          namespace: "default",
          taskQueue: turnTaskQueue(taskQueue),
          activities: { runAgentTurn },
        });
        await upgraded.runUntil(() =>
          turns.runUntil(async () => {
            try {
              // Reaching markSessionIdle proves that the new worker replayed
              // the old timer and processed its real server-side firing.
              await waitFor(() => idleMarks === 1, { timeoutMs: 20_000 });
              const resumed = await running.fetchHistory();
              expect(
                resumed.events?.filter((event) => event.timerFiredEventAttributes),
              ).toHaveLength(1);
              expect(patchIds(resumed)).not.toContain(patchId);
              state.queued.push("follow-up-after-worker-upgrade");
              await running.signal("queueChanged");
              gate.release();
              await running.result();
            } finally {
              gate.release();
            }
          }),
        );
        const history = await running.fetchHistory();
        expect((await running.describe()).runId).toBe(originalRunId);
        expect(state.runs).toEqual(["follow-up-after-worker-upgrade"]);
        expect(state.attempts).toHaveLength(1);
        expect(idleMarks).toBe(2);
        expect(patchIds(history)).toContain(patchId);
        // The second idle cycle activated the patch in this SAME run: the
        // only timer in the whole history is the inherited legacy timer.
        expect(timers(history)).toHaveLength(1);
        expect(
          Number(timers(history)[0]!.timerStartedEventAttributes!.startToFireTimeout!.seconds),
        ).toBe(5);
        expect(history.events?.filter((event) => event.timerCanceledEventAttributes)).toHaveLength(
          0,
        );
        await Worker.runReplayHistory({ workflowBundle }, history);
      } finally {
        gate.release();
        if (handle && (await handle.describe()).status.name === "RUNNING") {
          await handle.terminate("idle-upgrade test cleanup");
        }
      }
    },
    timeoutMs,
  );

  for (const signalDuringTimer of [false, true]) {
    test(
      `replays genuine prepatch history with a ${signalDuringTimer ? "signal-cancelled then fired" : "fired"} five-second idle timer`,
      async () => {
        const state = durableQueue();
        state.queued.length = 0;
        await withWorker(
          state.activities,
          async (start) => {
            const handle = await start();
            if (signalDuringTimer) {
              await waitFor(async () => timers(await handle.fetchHistory()).length === 1, {
                timeoutMs: 20_000,
              });
              await handle.signal("queueChanged");
            }
            await handle.result();
            const history = await handle.fetchHistory();
            expect(patchIds(history)).not.toContain(patchId);
            expect(timers(history)).toHaveLength(signalDuringTimer ? 2 : 1);
            for (const timer of timers(history))
              expect(Number(timer.timerStartedEventAttributes!.startToFireTimeout!.seconds)).toBe(
                5,
              );
            expect(history.events?.filter((event) => event.timerFiredEventAttributes)).toHaveLength(
              1,
            );
            expect(
              history.events?.filter((event) => event.timerCanceledEventAttributes),
            ).toHaveLength(signalDuringTimer ? 1 : 0);
            expect(state.runs).toEqual([]);
            // No marker deletion or synthetic history edits: replay the exact
            // server history against the new production workflow bundle.
            await Worker.runReplayHistory({ workflowBundle }, history);
          },
          true,
        );
      },
      timeoutMs,
    );
  }
});
