import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

const fakeDb = {};
const publishedEvents: unknown[] = [];
const recoveryCalls: unknown[] = [];
const parentWakeCalls: unknown[] = [];
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
      getSessionTurnPersistenceReceipt: mock(async () => null),
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
  });

  test("preserves schedule-to-start as the sole typed unclaimed recovery", async () => {
    recoveryCalls.length = 0;
    publishedEvents.length = 0;
    recoveryResult = { action: "unclaimed", events: [] };
    expect(await runRecovery("SCHEDULE_TO_START")).toEqual({ action: "unclaimed" });
    expect(recoveryCalls).toEqual([expect.objectContaining({ timeoutType: "SCHEDULE_TO_START" })]);
    expect(publishedEvents).toHaveLength(0);
  });

  test("delegates terminal, missing, or successor ownership classification atomically", async () => {
    recoveryCalls.length = 0;
    publishedEvents.length = 0;
    recoveryResult = {
      action: "stale",
      events: [],
      turnStatus: "completed",
      activeTurnId: null,
    };
    expect(await runRecovery()).toEqual({ action: "stale" });
    expect(recoveryCalls).toHaveLength(1);
    expect(publishedEvents).toHaveLength(0);
  });

  test("exhaustion is already terminal and wakes the parent once", async () => {
    recoveryCalls.length = 0;
    publishedEvents.length = 0;
    parentWakeCalls.length = 0;
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
  });
});
