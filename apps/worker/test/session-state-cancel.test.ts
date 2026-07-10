import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const publishedEvents: Array<{ type: string; turnId?: string | null; payload: any }> = [];
const appliedControls: Array<{
  workspaceId: string;
  sessionId: string;
  controlEventId: string;
}> = [];
const finishedTurns: Array<{ turnId: string; status: string }> = [];
const statuses: Array<{ sessionId: string; status: string; activeTurnId: string | null }> = [];
const fakeDb = {};
const fakeBus = {
  publish: mock(async (_workspaceId: string, _sessionId: string, events: any[]) => {
    publishedEvents.push(...events);
  }),
};
const resilienceSentinelWorkspaceId = "00000000-0000-4000-8000-0000000000ff";

const realDb = await import("@opengeni/db");
const realEvents = await import("@opengeni/events");
const realGoals = await import("../src/activities/goals");
const realParentWake = await import("../src/activities/parent-wake");
const realObservabilityMetrics = await import("../src/observability-metrics");
const realDbFns = {
  applySessionControlInterrupt: realDb.applySessionControlInterrupt,
  appendSessionEvents: realDb.appendSessionEvents,
  claimNextQueuedTurn: realDb.claimNextQueuedTurn,
  countQueuedTurns: realDb.countQueuedTurns,
  countTurnSessionHistoryItems: realDb.countTurnSessionHistoryItems,
  finishTurn: realDb.finishTurn,
  getSessionEvent: realDb.getSessionEvent,
  getSessionTurn: realDb.getSessionTurn,
  requireSession: realDb.requireSession,
  setSessionStatus: realDb.setSessionStatus,
};

mock.module("@opengeni/db", () => ({
  ...realDb,
  applySessionControlInterrupt: mock(
    async (db: unknown, workspaceId: string, sessionId: string, controlEventId: string) => {
      if (db !== fakeDb) {
        return realDbFns.applySessionControlInterrupt(
          db as never,
          workspaceId,
          sessionId,
          controlEventId,
        );
      }
      appliedControls.push({ workspaceId, sessionId, controlEventId });
      return {
        cancelledTurnId: "turn-1",
        events: [
          {
            id: "event-2",
            sessionId,
            sequence: 2,
            type: "turn.cancelled",
            payload: { triggerEventId: controlEventId },
            occurredAt: "2026-07-10T00:00:00.000Z",
            clientEventId: null,
            turnId: "turn-1",
          },
          {
            id: "event-3",
            sessionId,
            sequence: 3,
            type: "session.status.changed",
            payload: { status: "queued" },
            occurredAt: "2026-07-10T00:00:00.000Z",
            clientEventId: null,
            turnId: "turn-1",
          },
        ],
      };
    },
  ),
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
    return { id: "event-1", type: "user.message", payload: { text: "stop" } };
  }),
  getSessionTurn: mock(async (db: unknown, workspaceId: string, turnId: string) => {
    if (db !== fakeDb) {
      return realDbFns.getSessionTurn(db as never, workspaceId, turnId);
    }
    return null;
  }),
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
    publishedEvents.length = 0;
    appliedControls.length = 0;
    finishedTurns.length = 0;
    statuses.length = 0;
  });

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

    expect(appliedControls).toEqual([
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        controlEventId: "event-1",
      },
    ]);
    expect(publishedEvents.map((event) => event.type)).toEqual([
      "turn.cancelled",
      "session.status.changed",
    ]);
    expect(publishedEvents[0]).toMatchObject({
      type: "turn.cancelled",
      turnId: "turn-1",
      payload: { triggerEventId: "event-1" },
    });
    expect(finishedTurns).toEqual([]);
    expect(statuses).toEqual([]);
  });

});
