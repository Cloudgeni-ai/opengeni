import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

describe("failSessionAttempt child-terminal identity", () => {
  test("reuses the failed turn identity already persisted by settlement", async () => {
    const parentWakeCalls: unknown[][] = [];
    const activities = createSessionStateActivities(
      async () =>
        ({
          db: {},
          bus: { publish: async () => undefined },
          settings: {},
          observability: {},
          wakeSessionWorkflow: null,
        }) as any,
      {
        requireSession: mock(async () => ({ status: "running" }) as any),
        getSessionTurnForAttempt: mock(
          async () => ({ id: "turn-1", triggerEventId: "trigger-1" }) as any,
        ),
        getSessionEvent: mock(async () => ({ payload: { type: "turn.trigger" } }) as any),
        applySessionTurnSettlement: mock(async () => ({
          action: "settled" as const,
          events: [{ id: "failed-1", type: "turn.failed" }],
          recordingMutationApplied: false,
        })),
        publishDurableSessionEvents: mock(async () => undefined),
        deliverFailedChildTurnToParent: mock(async (...args: unknown[]) => {
          parentWakeCalls.push(args);
        }),
      },
    );

    await activities.failSessionAttempt({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "child-1",
      attemptId: "attempt-1",
      error: "activity transport failed",
    });

    expect(parentWakeCalls).toHaveLength(1);
    expect(parentWakeCalls[0]).toEqual(
      expect.arrayContaining(["workspace-1", "child-1", "turn-1"]),
    );
  });
});
