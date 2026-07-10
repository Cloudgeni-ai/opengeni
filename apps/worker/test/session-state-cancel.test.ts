import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const appendedEvents: Array<{ type: string; turnId?: string | null; payload: any }> = [];
const finishedTurns: Array<{ turnId: string; status: string }> = [];
const statuses: Array<{ sessionId: string; status: string; activeTurnId: string | null }> = [];
const fakeDb = {};
const fakeBus = {};
// Controllable per-test: the trigger event interruptActiveTurn reads (stop vs
// steer) and the ids cancelQueuedSessionTurns reports draining.
let triggerEvent: any = { id: "event-1", type: "user.message", payload: { text: "stop" } };
let drainResult: string[] = [];
let drainCalls = 0;
const resilienceSentinelWorkspaceId = "00000000-0000-4000-8000-0000000000ff";

const realDb = await import("@opengeni/db");
const realEvents = await import("@opengeni/events");
const realGoals = await import("../src/activities/goals");
const realParentWake = await import("../src/activities/parent-wake");
const realObservabilityMetrics = await import("../src/observability-metrics");
const realDbFns = {
  appendSessionEvents: realDb.appendSessionEvents,
  cancelQueuedSessionTurns: realDb.cancelQueuedSessionTurns,
  claimNextQueuedTurn: realDb.claimNextQueuedTurn,
  countQueuedTurns: realDb.countQueuedTurns,
  countTurnSessionHistoryItems: realDb.countTurnSessionHistoryItems,
  finishTurn: realDb.finishTurn,
  getSessionEvent: realDb.getSessionEvent,
  getSessionTurn: realDb.getSessionTurn,
  incrementTurnWorkerDeathRedispatches: realDb.incrementTurnWorkerDeathRedispatches,
  requeuePreemptedTurn: realDb.requeuePreemptedTurn,
  requireSession: realDb.requireSession,
  setSessionStatus: realDb.setSessionStatus,
};

mock.module("@opengeni/db", () => ({
  ...realDb,
  claimNextQueuedTurn: mock(
    async (db: unknown, workspaceId: string, sessionId: string, workflowId: string) => {
      if (db !== fakeDb) {
        return realDbFns.claimNextQueuedTurn(db as never, workspaceId, sessionId, workflowId);
      }
      return null;
    },
  ),
  countQueuedTurns: mock(async (db: unknown) => {
    if (db !== fakeDb) {
      return realDbFns.countQueuedTurns(db as never);
    }
    return 0;
  }),
  countTurnSessionHistoryItems: mock(async (db: unknown, workspaceId: string, turnId: string) => {
    if (db !== fakeDb) {
      return realDbFns.countTurnSessionHistoryItems(db as never, workspaceId, turnId);
    }
    return 0;
  }),
  finishTurn: mock(async (db: unknown, workspaceId: string, turnId: string, status: string) => {
    if (db !== fakeDb) {
      return realDbFns.finishTurn(db as never, workspaceId, turnId, status as never);
    }
    finishedTurns.push({ turnId, status });
  }),
  getSessionEvent: mock(async (db: unknown, workspaceId: string, eventId: string) => {
    if (db !== fakeDb) {
      return realDbFns.getSessionEvent(db as never, workspaceId, eventId);
    }
    return triggerEvent;
  }),
  cancelQueuedSessionTurns: mock(async (db: unknown, workspaceId: string, sessionId: string) => {
    if (db !== fakeDb) {
      return realDbFns.cancelQueuedSessionTurns(db as never, workspaceId, sessionId);
    }
    drainCalls += 1;
    return drainResult;
  }),
  getSessionTurn: mock(async (db: unknown, workspaceId: string, turnId: string) => {
    if (db !== fakeDb) {
      return realDbFns.getSessionTurn(db as never, workspaceId, turnId);
    }
    return null;
  }),
  incrementTurnWorkerDeathRedispatches: mock(
    async (db: unknown, workspaceId: string, turnId: string) => {
      if (db !== fakeDb) {
        return realDbFns.incrementTurnWorkerDeathRedispatches(db as never, workspaceId, turnId);
      }
      return 1;
    },
  ),
  requeuePreemptedTurn: mock(
    async (db: unknown, workspaceId: string, turnId: string, triggerEventId: string) => {
      if (db !== fakeDb) {
        return realDbFns.requeuePreemptedTurn(db as never, workspaceId, turnId, triggerEventId);
      }
    },
  ),
  requireSession: mock(async (db: unknown, workspaceId: string, sessionId: string) => {
    if (db !== fakeDb) {
      return realDbFns.requireSession(db as never, workspaceId, sessionId);
    }
    return {
      id: "session-1",
      status: "running",
      activeTurnId: "turn-1",
    };
  }),
  setSessionStatus: mock(
    async (
      db: unknown,
      workspaceId: string,
      sessionId: string,
      status: string,
      activeTurnId: string | null,
    ) => {
      if (db !== fakeDb) {
        return realDbFns.setSessionStatus(
          db as never,
          workspaceId,
          sessionId,
          status as never,
          activeTurnId,
        );
      }
      statuses.push({ sessionId, status, activeTurnId });
    },
  ),
}));

mock.module("@opengeni/events", () => ({
  ...realEvents,
  appendAndPublishEvents: mock(
    async (db: unknown, bus: any, workspaceId: string, sessionId: string, events: any[]) => {
      let appended: any[];
      if (db === fakeDb) {
        appendedEvents.push(...events);
        appended = events.map((event, index) => ({
          id: `event-${index + 1}`,
          sequence: index + 1,
          ...event,
        }));
      } else if (workspaceId === resilienceSentinelWorkspaceId) {
        appended = events.map((event, index) => ({
          id: `00000000-0000-4000-8000-00000000000${index}`,
          sessionId,
          sequence: index + 1,
          type: event.type,
          payload: event.payload ?? {},
          occurredAt: "2026-06-27T00:00:00.000Z",
          clientEventId: null,
          turnId: event.turnId ?? null,
        }));
      } else {
        appended = await realDbFns.appendSessionEvents(
          db as never,
          workspaceId,
          sessionId,
          events as never,
        );
      }
      try {
        await bus.publish(workspaceId, sessionId, appended);
      } catch {
        // Publish is best effort; callers reconcile from durable events.
      }
      return appended;
    },
  ),
}));

mock.module("../src/activities/goals", () => ({
  ...realGoals,
  pauseActiveGoalOnInterrupt: mock(async () => undefined),
}));

mock.module("../src/activities/parent-wake", () => ({
  ...realParentWake,
  notifyParentOfChildTerminal: mock(async () => undefined),
}));

mock.module("../src/observability-metrics", () => ({
  ...realObservabilityMetrics,
  recordTurnsQueuedGauge: mock(() => undefined),
}));

afterAll(() => {
  mock.restore();
});

describe("session-state cancellation", () => {
  beforeEach(() => {
    appendedEvents.length = 0;
    finishedTurns.length = 0;
    statuses.length = 0;
    triggerEvent = { id: "event-1", type: "user.message", payload: { text: "stop" } };
    drainResult = [];
    drainCalls = 0;
  });

  async function makeActivities() {
    const { createSessionStateActivities } = await import("../src/activities/session-state");
    return createSessionStateActivities(
      async () =>
        ({
          db: fakeDb,
          bus: fakeBus,
          settings: {},
          observability: {},
          wakeSessionWorkflow: mock(async () => undefined),
        }) as any,
    );
  }

  test("emits turn.cancelled when cancelling an active turn", async () => {
    const { createSessionStateActivities } = await import("../src/activities/session-state");
    const activities = createSessionStateActivities(
      async () =>
        ({
          db: fakeDb,
          bus: fakeBus,
          settings: {},
          observability: {},
          wakeSessionWorkflow: mock(async () => undefined),
        }) as any,
    );

    await activities.interruptActiveTurn({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      triggerEventId: "event-1",
      workflowId: "workflow-1",
      turnId: "turn-1",
    });

    expect(appendedEvents.map((event) => event.type)).toEqual([
      "turn.cancelled",
      "session.status.changed",
    ]);
    expect(appendedEvents[0]).toMatchObject({
      type: "turn.cancelled",
      turnId: "turn-1",
      payload: { triggerEventId: "event-1" },
    });
    expect(finishedTurns).toEqual([{ turnId: "turn-1", status: "cancelled" }]);
    expect(statuses).toEqual([{ sessionId: "session-1", status: "queued", activeTurnId: null }]);
  });

  test("stop drains the whole queue and emits one summary event", async () => {
    triggerEvent = { id: "event-1", type: "user.interrupt", payload: {} };
    drainResult = ["queued-a", "queued-b", "queued-c"];
    const activities = await makeActivities();

    await activities.interruptActiveTurn({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      triggerEventId: "event-1",
      workflowId: "workflow-1",
      turnId: "turn-1",
    });

    // The drain ran, and the summary event precedes the active-turn cancel.
    expect(drainCalls).toBe(1);
    expect(appendedEvents.map((event) => event.type)).toEqual([
      "turn.queue_drained",
      "turn.cancelled",
      "session.status.changed",
    ]);
    expect(appendedEvents[0]).toMatchObject({
      type: "turn.queue_drained",
      payload: { drainedCount: 3, drainedTurnIds: ["queued-a", "queued-b", "queued-c"] },
    });
  });

  test("stop with an empty queue drains nothing and emits no summary event", async () => {
    triggerEvent = { id: "event-1", type: "user.interrupt", payload: {} };
    drainResult = [];
    const activities = await makeActivities();

    await activities.interruptActiveTurn({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      triggerEventId: "event-1",
      workflowId: "workflow-1",
      turnId: "turn-1",
    });

    expect(drainCalls).toBe(1);
    expect(appendedEvents.map((event) => event.type)).toEqual([
      "turn.cancelled",
      "session.status.changed",
    ]);
  });

  test("steer cancels only the active turn — it never drains the queue", async () => {
    triggerEvent = { id: "event-1", type: "user.interrupt", payload: { reason: "steer" } };
    drainResult = ["queued-a", "queued-b"];
    const activities = await makeActivities();

    await activities.interruptActiveTurn({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      triggerEventId: "event-1",
      workflowId: "workflow-1",
      turnId: "turn-1",
    });

    // Steer must promote exactly one message: the queue is untouched (no drain
    // call, no summary event), only the active turn is cancelled.
    expect(drainCalls).toBe(0);
    expect(appendedEvents.map((event) => event.type)).toEqual([
      "turn.cancelled",
      "session.status.changed",
    ]);
  });
});
