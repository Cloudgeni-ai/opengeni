import { beforeEach, describe, expect, mock, test } from "bun:test";

const appendedEvents: Array<{ type: string; turnId?: string | null; payload: any }> = [];
const finishedTurns: Array<{ turnId: string; status: string }> = [];
const statuses: Array<{ sessionId: string; status: string; activeTurnId: string | null }> = [];

mock.module("@opengeni/db", () => ({
  claimNextQueuedTurn: mock(async () => null),
  countQueuedTurns: mock(async () => 0),
  countTurnSessionHistoryItems: mock(async () => 0),
  finishTurn: mock(async (_db: unknown, _workspaceId: string, turnId: string, status: string) => {
    finishedTurns.push({ turnId, status });
  }),
  getSessionEvent: mock(async () => ({ id: "event-1", type: "user.message", payload: { text: "stop" } })),
  getSessionTurn: mock(async () => null),
  incrementTurnWorkerDeathRedispatches: mock(async () => 1),
  requeuePreemptedTurn: mock(async () => undefined),
  requireSession: mock(async () => ({
    id: "session-1",
    status: "running",
    activeTurnId: "turn-1",
  })),
  setSessionStatus: mock(async (_db: unknown, _workspaceId: string, sessionId: string, status: string, activeTurnId: string | null) => {
    statuses.push({ sessionId, status, activeTurnId });
  }),
}));

mock.module("@opengeni/events", () => ({
  appendAndPublishEvents: mock(async (_db: unknown, _bus: unknown, _workspaceId: string, _sessionId: string, events: any[]) => {
    appendedEvents.push(...events);
    return events.map((event, index) => ({ id: `event-${index + 1}`, ...event }));
  }),
}));

mock.module("../src/activities/goals", () => ({
  isSteerInterrupt: () => false,
  pauseActiveGoalOnInterrupt: mock(async () => undefined),
}));

mock.module("../src/activities/parent-wake", () => ({
  notifyParentOfChildTerminal: mock(async () => undefined),
}));

mock.module("../src/observability-metrics", () => ({
  recordTurnsQueuedGauge: mock(() => undefined),
}));

describe("session-state cancellation", () => {
  beforeEach(() => {
    appendedEvents.length = 0;
    finishedTurns.length = 0;
    statuses.length = 0;
  });

  test("emits turn.cancelled when cancelling an active turn", async () => {
    const { createSessionStateActivities } = await import("../src/activities/session-state");
    const activities = createSessionStateActivities(async () => ({
      db: {},
      bus: {},
      settings: {},
      observability: {},
      wakeSessionWorkflow: mock(async () => undefined),
    } as any));

    await activities.interruptActiveTurn({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      triggerEventId: "event-1",
      workflowId: "workflow-1",
      turnId: "turn-1",
    });

    expect(appendedEvents.map((event) => event.type)).toEqual(["turn.cancelled", "session.status.changed"]);
    expect(appendedEvents[0]).toMatchObject({
      type: "turn.cancelled",
      turnId: "turn-1",
      payload: { triggerEventId: "event-1" },
    });
    expect(finishedTurns).toEqual([{ turnId: "turn-1", status: "cancelled" }]);
    expect(statuses).toEqual([{ sessionId: "session-1", status: "queued", activeTurnId: null }]);
  });
});
