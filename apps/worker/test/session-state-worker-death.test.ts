import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Regression: a worker that dies mid-turn (heartbeat timeout) can have its
// dying attempt stamp the turn `cancelled` in the generic CancelledFailure
// cleanup. requeueTurnAfterWorkerDeath must treat that `cancelled` as a DEATH
// ARTIFACT and re-dispatch — not honor it as a deliberate settle and drop it
// (the 76e2f2ee/Vern 16h stall). A genuinely settled `completed`/`failed`
// turn still stays `stale`. A deliberate user interrupt never reaches this
// activity (it takes the workflow's interrupt branch), so `cancelled` here is
// unambiguously the death.

const fakeDb = {};
const fakeBus = { publish: async () => undefined };

let currentTurn: { id: string; status: string } | null = null;
let requeueOverride: (() => void) | null = null;
const appendedEvents: Array<{ type: string; turnId?: string | null; payload: any }> = [];
const requeueCalls: Array<{ turnId: string; triggerEventId: string; fromStatuses?: string[] }> = [];
const statuses: string[] = [];

const realDb = await import("@opengeni/db");
const realEvents = await import("@opengeni/events");
const realParentWake = await import("../src/activities/parent-wake");
const realObservability = await import("../src/observability-metrics");

mock.module("@opengeni/db", () => ({
  ...realDb,
  getSessionTurn: mock(async () => currentTurn),
  incrementTurnWorkerDeathRedispatches: mock(async () => 1),
  getSessionEvent: mock(async () => ({ id: "trigger-1", type: "goal.continuation", payload: {} })),
  countTurnSessionHistoryItems: mock(async () => 0),
  countQueuedTurns: mock(async () => 0),
  requeuePreemptedTurn: mock(async (_db: unknown, _ws: string, turnId: string, triggerEventId: string, fromStatuses?: string[]) => {
    if (requeueOverride) {
      requeueOverride();
      return;
    }
    // Mirror the DB guard: the reset only matches a turn whose status is in
    // fromStatuses (defaults to the live-turn set). If a caller tries to
    // requeue a `cancelled` turn without opting it in, that is the bug.
    const allowed = fromStatuses ?? ["running", "requires_action"];
    if (!currentTurn || !allowed.includes(currentTurn.status)) {
      throw new Error(`Preemptible session turn not found: ${turnId}`);
    }
    requeueCalls.push({ turnId, triggerEventId, fromStatuses });
    currentTurn = { ...currentTurn, status: "queued" };
  }),
  setSessionStatus: mock(async (_db: unknown, _ws: string, _sid: string, status: string) => {
    statuses.push(status);
  }),
}));

mock.module("@opengeni/events", () => ({
  ...realEvents,
  appendAndPublishEvents: mock(async (_db: unknown, _bus: any, _ws: string, _sid: string, events: any[]) => {
    appendedEvents.push(...events);
    return events.map((event, index) => ({ id: `event-${index + 1}`, sequence: index + 1, ...event }));
  }),
}));

mock.module("../src/activities/parent-wake", () => ({
  ...realParentWake,
  notifyParentOfChildTerminal: mock(async () => undefined),
}));

mock.module("../src/observability-metrics", () => ({
  ...realObservability,
  recordTurnsQueuedGauge: mock(() => undefined),
}));

afterAll(() => {
  mock.restore();
});

async function runRequeue() {
  const { createSessionStateActivities } = await import("../src/activities/session-state");
  const activities = createSessionStateActivities(async () => ({
    db: fakeDb,
    bus: fakeBus,
    settings: { sessionHistorySource: "items", openaiReasoningEffort: "medium" },
    observability: {},
    wakeSessionWorkflow: mock(async () => undefined),
  } as any));
  return activities.requeueTurnAfterWorkerDeath({
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    triggerEventId: "trigger-1",
    workflowId: "workflow-1",
    turnId: "turn-1",
  } as any);
}

describe("requeueTurnAfterWorkerDeath: death-artifact cancel", () => {
  beforeEach(() => {
    appendedEvents.length = 0;
    requeueCalls.length = 0;
    statuses.length = 0;
    currentTurn = null;
    requeueOverride = null;
  });

  test("re-dispatches a turn the dying attempt stamped `cancelled`", async () => {
    currentTurn = { id: "turn-1", status: "cancelled" };

    const result = await runRequeue();

    expect(result).toMatchObject({ action: "requeued" });
    // It must opt `cancelled` into the requeue reset, else the DB guard drops it.
    expect(requeueCalls).toHaveLength(1);
    expect(requeueCalls[0].fromStatuses).toEqual(["running", "requires_action", "cancelled"]);
    // Emits the worker-death preemption so the loop re-claims it.
    const preempted = appendedEvents.find((event) => event.type === "turn.preempted");
    expect(preempted?.payload).toMatchObject({ reason: "worker_death" });
    expect(statuses).toContain("queued");
  });

  test("still re-dispatches a normal running turn (unchanged happy path)", async () => {
    currentTurn = { id: "turn-1", status: "running" };

    const result = await runRequeue();

    expect(result).toMatchObject({ action: "requeued" });
    expect(requeueCalls).toHaveLength(1);
    expect(requeueCalls[0].fromStatuses).toEqual(["running", "requires_action", "cancelled"]);
  });

  test("leaves a genuinely COMPLETED turn as stale (respects the real outcome)", async () => {
    currentTurn = { id: "turn-1", status: "completed" };

    const result = await runRequeue();

    expect(result).toEqual({ action: "stale" });
    expect(requeueCalls).toHaveLength(0);
    expect(appendedEvents).toHaveLength(0);
  });

  test("leaves a genuinely FAILED turn as stale", async () => {
    currentTurn = { id: "turn-1", status: "failed" };

    const result = await runRequeue();

    expect(result).toEqual({ action: "stale" });
    expect(requeueCalls).toHaveLength(0);
  });

  test("a missing turn is stale", async () => {
    currentTurn = null;

    const result = await runRequeue();

    expect(result).toEqual({ action: "stale" });
    expect(requeueCalls).toHaveLength(0);
  });

  test("rethrows (does NOT go stale) on a real persistence error while the turn is still cancelled", async () => {
    // The turn stays `cancelled` (still re-dispatchable), and the reset fails
    // for a real reason — this must retry, not silently drop the turn.
    currentTurn = { id: "turn-1", status: "cancelled" };
    requeueOverride = () => { throw new Error("db connection reset"); };

    await expect(runRequeue()).rejects.toThrow("db connection reset");
  });

  test("reports stale when a racing actor genuinely settled the turn during requeue", async () => {
    // Turn was re-dispatchable at the guard, but a racing zombie completed it
    // before the reset landed → its recorded outcome is the truth.
    currentTurn = { id: "turn-1", status: "cancelled" };
    requeueOverride = () => {
      currentTurn = { id: "turn-1", status: "completed" };
      throw new Error("Preemptible session turn not found: turn-1");
    };

    const result = await runRequeue();

    expect(result).toEqual({ action: "stale" });
  });
});
