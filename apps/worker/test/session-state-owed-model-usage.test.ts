import { expect, mock, test } from "bun:test";
import {
  OWED_MODEL_USAGE_IDLE_WINDOW_MS,
  createSessionStateActivities,
} from "../src/activities/session-state";

// A response's ledger writes run after its usage commits. Every boundary that
// can end an attempt or a session's work finishes any still owed, and a
// failure there never blocks the boundary itself.

function activitiesWith(
  settle: (scope: Record<string, unknown>) => Promise<number>,
  services?: Record<string, unknown>,
) {
  const warnings: string[] = [];
  const activities = createSessionStateActivities(
    async () =>
      (services ?? {
        db: {},
        bus: { publish: async () => undefined },
        settings: { sessionHistorySource: "items", openaiReasoningEffort: "medium" },
        observability: { warn: (message: string) => warnings.push(message) },
        wakeSessionWorkflow: null,
      }) as any,
    {
      settleRecordedModelUsage: mock(async (_settings, _db, scope) =>
        settle(scope as Record<string, unknown>),
      ) as any,
      recoverSessionDispatch: mock(async () => ({ action: "unclaimed", events: [] }) as any),
      settleSessionIdleWithParentOutbox: mock(
        async () => ({ action: "stale", events: [], notifyParent: false }) as any,
      ),
      requireSession: mock(async () => ({ status: "failed" }) as any),
      countQueuedTurns: mock(async () => 0),
      recordTurnsQueuedGauge: mock(() => undefined),
      recordWorkerDeathRecoveryMetrics: mock(() => undefined),
    },
  );
  return { activities, warnings };
}

const ids = { accountId: "account-1", workspaceId: "workspace-1", sessionId: "session-1" };

test("worker death, attempt failure and session idle each settle owed model usage", async () => {
  const scopes: Array<Record<string, unknown>> = [];
  const { activities } = activitiesWith(async (scope) => {
    scopes.push(scope);
    return 0;
  });
  const startedAt = Date.now();
  await activities.recoverDispatch({ ...ids, attemptId: "attempt-dead", timeoutType: "HEARTBEAT" });
  await activities.failSessionAttempt({ ...ids, attemptId: "attempt-failed" });
  await activities.markSessionIdle({ workspaceId: ids.workspaceId, sessionId: ids.sessionId });
  expect(scopes.map(({ observability: _observability, ...scope }) => scope)).toEqual([
    { workspaceId: "workspace-1", sessionId: "session-1", attemptId: "attempt-dead" },
    { workspaceId: "workspace-1", sessionId: "session-1", attemptId: "attempt-failed" },
    { workspaceId: "workspace-1", sessionId: "session-1", since: expect.any(Date) },
  ]);
  // The idle boundary looks back over a bounded recent window.
  const since = (scopes[2]!.since as Date).getTime();
  expect(since).toBeGreaterThanOrEqual(startedAt - OWED_MODEL_USAGE_IDLE_WINDOW_MS);
  expect(since).toBeLessThanOrEqual(Date.now() - OWED_MODEL_USAGE_IDLE_WINDOW_MS);
});

test("a failed settlement is logged and never blocks the boundary", async () => {
  const { activities, warnings } = activitiesWith(async () => {
    throw new Error("ledger unavailable");
  });
  await expect(
    activities.recoverDispatch({ ...ids, attemptId: "attempt-dead", timeoutType: "HEARTBEAT" }),
  ).resolves.toMatchObject({ action: "unclaimed" });
  await expect(
    activities.failSessionAttempt({ ...ids, attemptId: "attempt-failed" }),
  ).resolves.toEqual({ action: "terminal" });
  await expect(
    activities.markSessionIdle({ workspaceId: ids.workspaceId, sessionId: ids.sessionId }),
  ).resolves.toBeUndefined();
  expect(warnings).toEqual([
    "recorded model usage settlement failed",
    "recorded model usage settlement failed",
    "recorded model usage settlement failed",
  ]);
});

test("a failed idle settlement resolves even when its services cannot log", async () => {
  const { activities } = activitiesWith(
    async () => {
      throw new Error("session not visible");
    },
    { db: {} },
  );
  await expect(
    activities.markSessionIdle({ workspaceId: ids.workspaceId, sessionId: ids.sessionId }),
  ).resolves.toBeUndefined();
});
