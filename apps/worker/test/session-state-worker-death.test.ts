import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const fakeDb = {};
const publishedEvents: unknown[] = [];
const workerDeathCalls: unknown[] = [];
let currentTurn: { id: string; status: string } | null = null;
let workerDeathResult:
  | { action: "requeued"; redispatches: number; events: any[] }
  | { action: "exceeded"; redispatches: number; events: any[] }
  | { action: "stale"; events: []; turnStatus: string | null; activeTurnId: string | null };

const realDb = await import("@opengeni/db");
const realEvents = await import("@opengeni/events");
const realParentWake = await import("../src/activities/parent-wake");
const realObservability = await import("../src/observability-metrics");

mock.module("@opengeni/db", () => ({
  ...realDb,
  getSessionTurn: mock(async () => currentTurn),
  getSessionEvent: mock(async () => ({ id: "trigger-1", type: "goal.continuation", payload: {} })),
  countTurnSessionHistoryItems: mock(async () => 0),
  countQueuedTurns: mock(async () => 0),
  applySessionTurnWorkerDeath: mock(async (...args: unknown[]) => {
    workerDeathCalls.push(args[2]);
    return workerDeathResult;
  }),
}));

mock.module("@opengeni/events", () => ({
  ...realEvents,
  publishDurableSessionEvents: mock(
    async (_bus: unknown, _workspaceId: string, _sessionId: string, events: unknown[]) => {
      publishedEvents.push(...events);
    },
  ),
}));

const parentWakes: unknown[] = [];
mock.module("../src/activities/parent-wake", () => ({
  ...realParentWake,
  notifyParentOfChildTerminal: mock(async (...args: unknown[]) => {
    parentWakes.push(args);
  }),
}));

mock.module("../src/observability-metrics", () => ({
  ...realObservability,
  recordTurnsQueuedGauge: mock(() => undefined),
}));

afterAll(() => {
  mock.restore();
});

async function runRequeue(timeoutType: "HEARTBEAT" | "SCHEDULE_TO_START" = "HEARTBEAT") {
  const { createSessionStateActivities } = await import("../src/activities/session-state");
  const activities = createSessionStateActivities(
    async () =>
      ({
        db: fakeDb,
        bus: { publish: async () => undefined },
        settings: { sessionHistorySource: "items", openaiReasoningEffort: "medium" },
        observability: {},
        wakeSessionWorkflow: mock(async () => undefined),
      }) as any,
  );
  return activities.requeueTurnAfterWorkerDeath({
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    triggerEventId: "trigger-1",
    workflowId: "workflow-1",
    turnId: "turn-1",
    dispatchId: "activity-7",
    timeoutType,
  });
}

describe("requeueTurnAfterWorkerDeath: atomic dispatch fence", () => {
  beforeEach(() => {
    currentTurn = { id: "turn-1", status: "running" };
    workerDeathCalls.length = 0;
    publishedEvents.length = 0;
    parentWakes.length = 0;
    workerDeathResult = {
      action: "requeued",
      redispatches: 1,
      events: [{ id: "preempted-1", type: "turn.preempted" }],
    };
  });

  test("passes the exact Temporal dispatch and publishes already-durable requeue events", async () => {
    expect(await runRequeue()).toEqual({ action: "requeued", redispatches: 1 });
    expect(workerDeathCalls).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        triggerEventId: "trigger-1",
        dispatchId: "activity-7",
        allowLegacyUnregistered: true,
        allowPriorAttemptForScheduleToStart: false,
        maxRedispatches: 3,
      }),
    ]);
    expect(publishedEvents).toEqual([{ id: "preempted-1", type: "turn.preempted" }]);
  });

  test("marks schedule-to-start as the explicit no-registration recovery case", async () => {
    await runRequeue("SCHEDULE_TO_START");
    expect(workerDeathCalls).toEqual([
      expect.objectContaining({ allowPriorAttemptForScheduleToStart: true }),
    ]);
  });

  test("a terminal or missing turn is stale before the atomic helper", async () => {
    currentTurn = { id: "turn-1", status: "completed" };
    expect(await runRequeue()).toEqual({ action: "stale" });
    expect(workerDeathCalls).toHaveLength(0);
    currentTurn = null;
    expect(await runRequeue()).toEqual({ action: "stale" });
    expect(workerDeathCalls).toHaveLength(0);
  });

  test("an event-free stale helper result remains stale", async () => {
    workerDeathResult = {
      action: "stale",
      events: [],
      turnStatus: "running",
      activeTurnId: "turn-1",
    };
    expect(await runRequeue()).toEqual({ action: "stale" });
    expect(publishedEvents).toHaveLength(0);
  });

  test("exhaustion is already terminal and wakes the parent once", async () => {
    workerDeathResult = {
      action: "exceeded",
      redispatches: 3,
      events: [{ id: "failed-1", type: "turn.failed" }],
    };
    expect(await runRequeue()).toEqual({ action: "exceeded", redispatches: 3 });
    expect(publishedEvents).toEqual([{ id: "failed-1", type: "turn.failed" }]);
    expect(parentWakes).toHaveLength(1);
  });
});
