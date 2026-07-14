import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

const fakeDb = {};
const publishedEvents: unknown[] = [];
const workerDeathCalls: unknown[] = [];
let currentTurn: { id: string; status: string } | null = null;
let workerDeathResult:
  | { action: "recovering"; redispatches: number; events: any[] }
  | { action: "exceeded"; redispatches: number; events: any[] }
  | { action: "stale"; events: []; turnStatus: string | null; activeTurnId: string | null };

function makeActivities() {
  return createSessionStateActivities(
    async () =>
      ({
        db: fakeDb,
        bus: { publish: async () => undefined },
        settings: { sessionHistorySource: "items", openaiReasoningEffort: "medium" },
        observability: {},
        wakeSessionWorkflow: null,
      }) as any,
    {
      getSessionTurn: mock(async () => currentTurn as any),
      getSessionEvent: mock(async () => ({
        id: "trigger-1",
        type: "goal.continuation",
        payload: {},
      })),
      countQueuedTurns: mock(async () => 0),
      applySessionTurnWorkerDeath: mock(async (...args: unknown[]) => {
        workerDeathCalls.push(args[2]);
        return workerDeathResult;
      }),
      publishDurableSessionEvents: mock(
        async (_bus, _workspaceId, _sessionId, events: unknown[]) => {
          publishedEvents.push(...events);
        },
      ),
      notifyParentOfChildTerminal: mock(async () => undefined),
      recordTurnsQueuedGauge: mock(() => undefined),
    },
  );
}

async function runRecovery(timeoutType: "HEARTBEAT" | "SCHEDULE_TO_START" = "HEARTBEAT") {
  return makeActivities().recoverTurnAfterWorkerDeath({
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    triggerEventId: "trigger-1",
    workflowId: "workflow-1",
    turnId: "turn-1",
    attemptId: "attempt-1",
    dispatchId: "activity-7",
    timeoutType,
  });
}

describe("recoverTurnAfterWorkerDeath: atomic dispatch fence", () => {
  test("passes the exact Temporal dispatch and typed timeout", async () => {
    currentTurn = { id: "turn-1", status: "running" };
    workerDeathCalls.length = 0;
    publishedEvents.length = 0;
    workerDeathResult = {
      action: "recovering",
      redispatches: 1,
      events: [{ id: "recovery-1", type: "turn.recovery.requested" }],
    };

    expect(await runRecovery()).toEqual({ action: "recovering", redispatches: 1 });
    expect(workerDeathCalls).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        triggerEventId: "trigger-1",
        attemptId: "attempt-1",
        dispatchId: "activity-7",
        timeoutType: "HEARTBEAT",
        maxRedispatches: 3,
      }),
    ]);
    expect(publishedEvents).toEqual([{ id: "recovery-1", type: "turn.recovery.requested" }]);
  });

  test("preserves schedule-to-start as the sole typed no-registration recovery", async () => {
    currentTurn = { id: "turn-1", status: "running" };
    workerDeathCalls.length = 0;
    publishedEvents.length = 0;
    workerDeathResult = {
      action: "recovering",
      redispatches: 1,
      events: [],
    };
    await runRecovery("SCHEDULE_TO_START");
    expect(workerDeathCalls).toEqual([
      expect.objectContaining({ timeoutType: "SCHEDULE_TO_START" }),
    ]);
  });

  test("does not call the atomic helper for terminal or missing turns", async () => {
    currentTurn = { id: "turn-1", status: "completed" };
    workerDeathCalls.length = 0;
    expect(await runRecovery()).toEqual({ action: "stale" });
    expect(workerDeathCalls).toHaveLength(0);
    currentTurn = null;
    expect(await runRecovery()).toEqual({ action: "stale" });
    expect(workerDeathCalls).toHaveLength(0);
  });

  test("an event-free stale helper result remains stale", async () => {
    currentTurn = { id: "turn-1", status: "running" };
    workerDeathCalls.length = 0;
    publishedEvents.length = 0;
    workerDeathResult = {
      action: "stale",
      events: [],
      turnStatus: "running",
      activeTurnId: "turn-1",
    };
    expect(await runRecovery()).toEqual({ action: "stale" });
    expect(publishedEvents).toHaveLength(0);
  });

  test("exhaustion is already terminal and wakes the parent once", async () => {
    currentTurn = { id: "turn-1", status: "running" };
    workerDeathCalls.length = 0;
    publishedEvents.length = 0;
    workerDeathResult = {
      action: "exceeded",
      redispatches: 3,
      events: [{ id: "failed-1", type: "turn.failed" }],
    };
    expect(await runRecovery()).toEqual({ action: "exceeded", redispatches: 3 });
    expect(publishedEvents).toEqual([{ id: "failed-1", type: "turn.failed" }]);
  });
});
