import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

describe("failSessionAttempt child-terminal identity", () => {
  test("reports existing failed and cancelled session truth as terminal", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const getTurn = mock(async () => null);
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
          requireSession: mock(async () => ({ status }) as any),
          getSessionTurnForAttempt: getTurn as any,
        },
      );

      expect(
        await activities.failSessionAttempt({
          accountId: "account-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          attemptId: "attempt-1",
        }),
      ).toEqual({ action: "terminal" });
      expect(getTurn).not.toHaveBeenCalled();
    }
  });

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

    const result = await activities.failSessionAttempt({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "child-1",
      attemptId: "attempt-1",
      workflowId: "session-child-1",
      retryDelayMs: 1_000,
      error: "activity transport failed",
    });

    expect(result).toEqual({ action: "failed" });
    expect(parentWakeCalls).toHaveLength(1);
    expect(parentWakeCalls[0]).toEqual(
      expect.arrayContaining(["workspace-1", "child-1", "turn-1"]),
    );
  });

  test("durably re-wakes a recovering turn when the activity failed before claim", async () => {
    const wakeCalls: unknown[][] = [];
    const settle = mock(async () => ({ action: "settled" as const, events: [] }));
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
        requireSession: mock(
          async () => ({ status: "recovering", temporalWorkflowId: "session-child-1" }) as any,
        ),
        getSessionTurnForAttempt: mock(async () => null),
        getSessionAttemptActivityRef: mock(async () => null),
        applySessionTurnSettlement: settle as any,
        enqueueSessionWorkflowWake: mock(async (...args: unknown[]) => {
          wakeCalls.push(args);
          return 7;
        }) as any,
      },
    );

    const before = Date.now();
    const result = await activities.failSessionAttempt({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "child-1",
      attemptId: "attempt-never-created",
      workflowId: "session-child-1",
      retryDelayMs: 4_000,
      error: "Database deadlock while persisting session.turn.attempt_claimed",
    });

    expect(result).toEqual({ action: "unclaimed" });
    expect(settle).not.toHaveBeenCalled();
    expect(wakeCalls).toHaveLength(1);
    const wakeCall = wakeCalls[0];
    if (!wakeCall) throw new Error("Expected one durable workflow wake");
    expect(wakeCall[1]).toMatchObject({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "child-1",
      temporalWorkflowId: "session-child-1",
      reason: "turn_activity_failed_before_attempt_claim",
    });
    const notBefore = (wakeCall[1] as { notBefore: Date }).notBefore;
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(before + 4_000);
  });

  test("terminally settles an explicitly permanent pre-claim failure", async () => {
    const enqueue = mock(async () => 1);
    const publishCalls: unknown[][] = [];
    const parentWakeCalls: unknown[][] = [];
    const terminalSettlement = mock(async () => ({
      action: "failed" as const,
      turnId: "turn-1",
      events: [
        { id: "failed-1", type: "turn.failed" },
        { id: "status-1", type: "session.status.changed" },
      ],
    }));
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
        requireSession: mock(
          async () => ({ status: "queued", temporalWorkflowId: "session-child-1" }) as any,
        ),
        getSessionTurnForAttempt: mock(async () => null),
        getSessionAttemptActivityRef: mock(async () => null),
        failSessionWorkBeforeAttemptClaim: terminalSettlement as any,
        enqueueSessionWorkflowWake: enqueue as any,
        publishDurableSessionEvents: mock(async (...args: unknown[]) => {
          publishCalls.push(args);
        }),
        deliverFailedChildTurnToParent: mock(async (...args: unknown[]) => {
          parentWakeCalls.push(args);
        }),
      },
    );

    const result = await activities.failSessionAttempt({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "child-1",
      attemptId: "attempt-never-created",
      workflowId: "session-child-1",
      preClaimFailureDisposition: "permanent",
      trigger: { kind: "next" },
      error: "Agent turn admission failed before attempt claim.",
    });

    expect(result).toEqual({ action: "failed" });
    expect(terminalSettlement).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(publishCalls).toHaveLength(1);
    expect(parentWakeCalls).toHaveLength(1);
  });

  test("does not manufacture a wake when the exact attempt already settled", async () => {
    const enqueue = mock(async () => 1);
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
        requireSession: mock(async () => ({ status: "recovering" }) as any),
        getSessionTurnForAttempt: mock(async () => null),
        getSessionAttemptActivityRef: mock(
          async () =>
            ({
              workflowId: "session-child-1",
              workflowRunId: "run-1",
              activityId: "activity-1",
              quiesced: true,
            }) as any,
        ),
        enqueueSessionWorkflowWake: enqueue as any,
      },
    );

    const result = await activities.failSessionAttempt({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "child-1",
      attemptId: "attempt-1",
      workflowId: "session-child-1",
      retryDelayMs: 1_000,
    });

    expect(result).toEqual({ action: "stale" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
