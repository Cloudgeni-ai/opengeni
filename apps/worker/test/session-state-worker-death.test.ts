import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

const fakeDb = {};
const publishedEvents: unknown[] = [];
const recoveryCalls: unknown[] = [];
const parentWakeCalls: unknown[] = [];
const recoveryMetricCalls: unknown[] = [];
let recoveryResult:
  | { action: "unclaimed"; events: [] }
  | { action: "recovering"; turnId: string; redispatches: number; events: any[] }
  | { action: "exceeded"; turnId: string; redispatches: number; events: any[] }
  | { action: "stale"; events: []; turnStatus: string | null; activeTurnId: string | null };

function makeActivities() {
  return createSessionStateActivities(
    async () =>
      ({
        db: fakeDb,
        bus: { publish: async () => undefined },
        settings: {
          sessionHistorySource: "items",
          openaiReasoningEffort: "medium",
        },
        observability: {},
        wakeSessionWorkflow: null,
      }) as any,
    {
      recoverSessionDispatch: mock(async (...args: unknown[]) => {
        recoveryCalls.push(args[2]);
        return recoveryResult as any;
      }),
      countQueuedTurns: mock(async () => 0),
      publishDurableSessionEvents: mock(
        async (_bus, _workspaceId, _sessionId, events: unknown[]) => {
          publishedEvents.push(...events);
        },
      ),
      deliverFailedChildTurnToParent: mock(async (...args: unknown[]) => {
        parentWakeCalls.push(args);
      }),
      recordTurnsQueuedGauge: mock(() => undefined),
      recordWorkerDeathRecoveryMetrics: mock((...args: unknown[]) => {
        recoveryMetricCalls.push(args[1]);
      }),
    },
  );
}

async function runRecovery(timeoutType: "HEARTBEAT" | "SCHEDULE_TO_START" = "HEARTBEAT") {
  return makeActivities().recoverDispatch({
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    attemptId: "attempt-1",
    timeoutType,
  });
}

describe("recoverDispatch: exact attempt ownership fence", () => {
  test("passes only the exact attempt identity and typed timeout", async () => {
    recoveryCalls.length = 0;
    publishedEvents.length = 0;
    parentWakeCalls.length = 0;
    recoveryMetricCalls.length = 0;
    recoveryResult = {
      action: "recovering",
      turnId: "turn-1",
      redispatches: 1,
      events: [{ id: "recovery-1", type: "turn.recovery.requested" }],
    };

    expect(await runRecovery()).toEqual({
      action: "recovering",
      turnId: "turn-1",
      redispatches: 1,
    });
    expect(recoveryCalls).toEqual([
      {
        sessionId: "session-1",
        attemptId: "attempt-1",
        timeoutType: "HEARTBEAT",
        maxRedispatches: 3,
      },
    ]);
    expect(publishedEvents).toEqual([{ id: "recovery-1", type: "turn.recovery.requested" }]);
    expect(parentWakeCalls).toHaveLength(0);
    expect(recoveryMetricCalls).toEqual([{ outcome: "recovering", timeoutType: "HEARTBEAT" }]);
  });

  test("preserves schedule-to-start as the sole typed unclaimed recovery", async () => {
    recoveryCalls.length = 0;
    publishedEvents.length = 0;
    recoveryMetricCalls.length = 0;
    recoveryResult = { action: "unclaimed", events: [] };
    expect(await runRecovery("SCHEDULE_TO_START")).toEqual({ action: "unclaimed" });
    expect(recoveryCalls).toEqual([expect.objectContaining({ timeoutType: "SCHEDULE_TO_START" })]);
    expect(publishedEvents).toHaveLength(0);
    expect(recoveryMetricCalls).toHaveLength(0);
  });

  test("delegates terminal, missing, or successor ownership classification atomically", async () => {
    recoveryCalls.length = 0;
    publishedEvents.length = 0;
    recoveryMetricCalls.length = 0;
    recoveryResult = {
      action: "stale",
      events: [],
      turnStatus: "completed",
      activeTurnId: null,
    };
    expect(await runRecovery()).toEqual({ action: "stale" });
    expect(recoveryCalls).toHaveLength(1);
    expect(publishedEvents).toHaveLength(0);
    expect(recoveryMetricCalls).toHaveLength(0);
  });

  test("exhaustion is already terminal and wakes the parent once", async () => {
    recoveryCalls.length = 0;
    publishedEvents.length = 0;
    parentWakeCalls.length = 0;
    recoveryMetricCalls.length = 0;
    recoveryResult = {
      action: "exceeded",
      turnId: "turn-1",
      redispatches: 3,
      events: [{ id: "failed-1", type: "turn.failed" }],
    };
    expect(await runRecovery()).toEqual({
      action: "exceeded",
      turnId: "turn-1",
      redispatches: 3,
    });
    expect(publishedEvents).toEqual([{ id: "failed-1", type: "turn.failed" }]);
    expect(parentWakeCalls).toHaveLength(1);
    expect(parentWakeCalls[0]).toEqual(
      expect.arrayContaining(["workspace-1", "session-1", "turn-1"]),
    );
    expect(recoveryMetricCalls).toEqual([{ outcome: "exhausted", timeoutType: "HEARTBEAT" }]);
  });
});

describe("reconcileSettledSessionAttempt: authenticated original activity proof", () => {
  const input = {
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    attemptId: "attempt-1",
    executionGeneration: 4,
    workflowId: "workflow-1",
    workflowRunId: "original-run",
    activityId: "original-activity",
  };
  const ref = {
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    activityId: input.activityId,
    quiesced: false,
  };

  test.each(["pending", "unknown", "unavailable", "absent"])(
    "%s inspection never reaches live-owner close",
    async (state) => {
      const close = mock(async () => ({ action: "recovering", events: [] }) as any);
      const activities = createSessionStateActivities(
        async () =>
          ({
            db: fakeDb,
            bus: {},
            settings: {},
            observability: {},
            inspectSessionAttemptActivity:
              state === "absent"
                ? null
                : async () => {
                    if (state === "unavailable")
                      throw new Error("inspector temporarily unavailable");
                    return state;
                  },
          }) as any,
        {
          getSessionAttemptActivityRef: mock(async () => ref),
          reconcileSettledSessionAttempt: close,
        },
      );
      expect(await activities.reconcileSettledSessionAttempt(input)).toEqual({ action: "pending" });
      expect(close).not.toHaveBeenCalled();
    },
  );

  test.each([
    null,
    { ...ref, workflowRunId: "replacement-run" },
    { ...ref, activityId: "replacement-activity" },
  ])("missing/replaced stored dispatch %j is stale before inspection", async (stored) => {
    const inspect = mock(async () => "settled");
    const close = mock(async () => ({ action: "recovering", events: [] }) as any);
    const activities = createSessionStateActivities(
      async () =>
        ({
          db: fakeDb,
          bus: {},
          inspectSessionAttemptActivity: inspect,
        }) as any,
      {
        getSessionAttemptActivityRef: mock(async () => stored),
        reconcileSettledSessionAttempt: close,
      },
    );
    expect(await activities.reconcileSettledSessionAttempt(input)).toEqual({ action: "stale" });
    expect(inspect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  test("only explicit settled authenticated original run proof crosses into bounded under-lock recovery", async () => {
    const inspect = mock(async () => "settled" as const);
    const close = mock(async () => ({ action: "recovering", events: [{ id: "recovery" }] }) as any);
    const fanout = mock(async () => {
      throw new Error("live fanout unavailable after durable wake commit");
    });
    const activities = createSessionStateActivities(
      async () =>
        ({
          db: fakeDb,
          bus: {},
          inspectSessionAttemptActivity: inspect,
        }) as any,
      {
        getSessionAttemptActivityRef: mock(async () => ref),
        reconcileSettledSessionAttempt: close,
        publishDurableSessionEvents: fanout,
      },
    );
    expect(await activities.reconcileSettledSessionAttempt(input)).toEqual({
      action: "recovering",
    });
    expect(inspect).toHaveBeenCalledWith(ref);
    expect(close).toHaveBeenCalledWith(fakeDb, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      executionGeneration: input.executionGeneration,
      temporalWorkflowId: input.workflowId,
      temporalWorkflowRunId: input.workflowRunId,
      temporalActivityId: input.activityId,
      activitySettled: true,
      maxRedispatches: 3,
    });
    expect(fanout).toHaveBeenCalledTimes(1);
  });
});
