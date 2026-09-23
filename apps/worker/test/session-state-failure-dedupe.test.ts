import { describe, expect, mock, test } from "bun:test";
import { CancelledFailure } from "@temporalio/activity";
import { createSessionStateActivities } from "../src/activities/session-state";

describe("failSessionAttempt child-terminal identity", () => {
  test("optional inspection never suppresses activity cancellation", async () => {
    const cancelled = new CancelledFailure("cancelled by control");
    const peek = mock(async () => ({
      kind: "attempt-owned" as const,
      turnId: "t",
      attemptId: "a",
      executionGeneration: 1,
      activityRef: { workflowId: "w", workflowRunId: "r", activityId: "activity", quiesced: false },
    }));
    const activities = createSessionStateActivities(
      async () =>
        ({
          db: {},
          inspectSessionAttemptActivity: async () => {
            throw cancelled;
          },
        }) as any,
      { peekSessionWork: peek },
    );
    await expect(
      activities.peekSessionWork({ workspaceId: "w", sessionId: "s", observerAccountId: "a" }),
    ).rejects.toBe(cancelled);
    expect(peek).toHaveBeenCalledTimes(1);
  });

  test("an unavailable inspector returns unknown or fresh Pause, while DB failures still escape", async () => {
    const owned = {
      kind: "attempt-owned" as const,
      turnId: "t",
      attemptId: "a",
      executionGeneration: 2,
      activityRef: { workflowId: "w", workflowRunId: "r", activityId: "activity", quiesced: false },
    };
    for (const outcome of ["owned", "paused", "db_failure"] as const) {
      let reads = 0;
      const dbFailure = new Error("database unavailable");
      const peek = mock(async () => {
        reads += 1;
        if (reads === 1 || outcome === "owned") return owned;
        if (outcome === "db_failure") throw dbFailure;
        return { kind: "idle" as const };
      });
      const activities = createSessionStateActivities(
        async () =>
          ({
            db: {},
            observability: {},
            inspectSessionAttemptActivity: async () => {
              throw new Error("metadata transport unavailable");
            },
          }) as any,
        { peekSessionWork: peek },
      );
      const result = activities.peekSessionWork({
        workspaceId: "ws",
        sessionId: "s",
        observerAccountId: "account",
      });
      if (outcome === "db_failure") await expect(result).rejects.toBe(dbFailure);
      else
        expect(await result).toEqual(
          outcome === "owned" ? { ...owned, ownerActivityState: "unknown" } : { kind: "idle" },
        );
      expect(reads).toBe(2);
    }
  });

  test("safe observation inspects only the exact owner and discards an obsolete inspection", async () => {
    const owned = {
      kind: "attempt-owned" as const,
      turnId: "t",
      attemptId: "a",
      executionGeneration: 2,
      activityRef: { workflowId: "w", workflowRunId: "r", activityId: "activity", quiesced: false },
    };
    for (const state of ["pending", "settled"] as const) {
      const inspect = mock(async () => state);
      let fresh = owned;
      const peek = mock(async () => fresh);
      const activities = createSessionStateActivities(
        async () => ({ db: {}, observability: {}, inspectSessionAttemptActivity: inspect }) as any,
        { peekSessionWork: peek as any },
      );
      const input = { workspaceId: "ws", sessionId: "s", observerAccountId: "account" };
      expect(await activities.peekSessionWork(input)).toEqual({
        ...owned,
        ownerActivityState: state,
      });
      expect(inspect).toHaveBeenCalledWith(owned.activityRef);
      inspect.mockImplementation(async () => {
        fresh = { ...owned, attemptId: "successor", executionGeneration: 3 };
        return state;
      });
      expect(await activities.peekSessionWork(input)).toEqual(fresh);
    }
  });

  test("unavailable observer does not inspect an owner or refresh unscoped queue telemetry", async () => {
    const inspect = mock(async () => "settled" as const);
    const count = mock(async () => 0);
    const activities = createSessionStateActivities(
      async () => ({ db: {}, observability: {}, inspectSessionAttemptActivity: inspect }) as any,
      {
        peekSessionWork: mock(async () => ({ kind: "unavailable" as const })),
        countQueuedTurns: count,
      },
    );
    expect(
      await activities.peekSessionWork({
        workspaceId: "w",
        sessionId: "s",
        observerAccountId: "a",
      }),
    ).toEqual({ kind: "unavailable" });
    expect(inspect).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  test("parks exact rejected admission without retry wakes or terminal input settlement", async () => {
    const block = mock(async () => ({ action: "blocked" as const, events: [] }));
    const wake = mock(async () => undefined);
    const terminal = mock(async () => ({ action: "failed" as const, events: [], turnId: null }));
    const activities = createSessionStateActivities(
      async () => ({ db: {}, bus: {}, settings: {}, observability: {} }) as any,
      {
        requireSession: mock(async () => ({ status: "queued" }) as any),
        getSessionTurnForAttempt: mock(async () => null),
        getSessionAttemptActivityRef: mock(async () => null),
        blockSessionWorkBeforeAttemptClaim: block,
        enqueueSessionWorkflowWake: wake as any,
        failSessionWorkBeforeAttemptClaim: terminal,
        publishDurableSessionEvents: mock(async () => undefined),
      },
    );
    const fence = { lastSequence: 10, controlVersion: 2 };
    expect(
      await activities.failSessionAttempt({
        accountId: "a",
        workspaceId: "w",
        sessionId: "s",
        attemptId: "attempt",
        admissionFence: fence,
        preClaimFailure: {
          disposition: "blocked",
          code: "db_failure",
          sqlState: "42501",
          reason: "database_claim_rejected",
          retryPolicy: "explicit_recheck",
        },
      }),
    ).toEqual({ action: "blocked" });
    expect(block.mock.calls[0]?.[2]).toMatchObject({
      fence,
      attemptId: "attempt",
      sqlState: "42501",
    });
    expect(wake).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });
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

  test("preserves provider recovery authority after an operational database failure", async () => {
    const published: unknown[] = [];
    const recoveryCalls: unknown[] = [];
    const terminalSettlement = mock(async () => ({ action: "settled" as const, events: [] }));
    const parentWake = mock(async () => undefined);
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
          async () =>
            ({
              id: "turn-1",
              triggerEventId: "trigger-1",
              executionGeneration: 4,
              metadata: { providerRecoveryCount: 1 },
            }) as any,
        ),
        requestSessionTurnRecovery: mock(async (...args: unknown[]) => {
          recoveryCalls.push(args[2]);
          return {
            action: "recovering" as const,
            events: [{ id: "recovery-1", type: "turn.recovery.requested" }],
          } as any;
        }),
        applySessionTurnSettlement: terminalSettlement as any,
        publishDurableSessionEvents: mock(
          async (_bus, _workspaceId, _sessionId, events: unknown[]) => {
            published.push(...events);
          },
        ),
        countQueuedTurns: mock(async () => 0),
        recordTurnsQueuedGauge: mock(() => undefined),
        deliverFailedChildTurnToParent: parentWake as any,
      },
    );

    expect(
      await activities.failSessionAttempt({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        workflowId: "session-session-1",
        postClaimDatabaseRecovery: {
          turnId: "turn-1",
          triggerEventId: "trigger-1",
          executionGeneration: 4,
          code: "db_failure",
          providerFailureCode: "mcp_transport_unavailable",
          providerRecoveryCount: 2,
        },
      }),
    ).toEqual({ action: "recovering" });
    expect(recoveryCalls).toEqual([
      {
        sessionId: "session-1",
        turnId: "turn-1",
        triggerEventId: "trigger-1",
        attemptId: "attempt-1",
        reason: "mcp_transport_unavailable",
        providerRecoveryCount: 2,
        detail: {
          code: "mcp_transport_unavailable",
          retryable: true,
          databaseFailureCode: "db_failure",
          providerRecoveryCount: 2,
          recoverySource: "workflow_activity_failure",
        },
        fromStatuses: ["running"],
      },
    ]);
    expect(published).toEqual([{ id: "recovery-1", type: "turn.recovery.requested" }]);
    expect(terminalSettlement).not.toHaveBeenCalled();
    expect(parentWake).not.toHaveBeenCalled();

    recoveryCalls.length = 0;
    expect(
      await activities.failSessionAttempt({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        workflowId: "session-session-1",
        postClaimDatabaseRecovery: {
          turnId: "turn-1",
          triggerEventId: "trigger-1",
          executionGeneration: 4,
          code: "db_failure",
          providerFailureCode: "mcp_transport_unavailable",
          providerRecoveryCount: 1,
        },
      }),
    ).toEqual({ action: "stale" });
    expect(recoveryCalls).toHaveLength(0);

    for (const malformedAuthority of [
      { providerFailureCode: "mcp_transport_unavailable" },
      { providerRecoveryCount: 2 },
      { providerFailureCode: "unsafe provider code", providerRecoveryCount: 2 },
    ]) {
      expect(
        await activities.failSessionAttempt({
          accountId: "account-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          attemptId: "attempt-1",
          workflowId: "session-session-1",
          postClaimDatabaseRecovery: {
            turnId: "turn-1",
            triggerEventId: "trigger-1",
            executionGeneration: 4,
            code: "db_failure",
            ...malformedAuthority,
          },
        } as any),
      ).toEqual({ action: "stale" });
    }
    expect(recoveryCalls).toHaveLength(0);
  });

  test("recovers an ambiguously committed claim from retryable pre-claim truth", async () => {
    const recoveryCalls: unknown[] = [];
    const terminalSettlement = mock(async () => ({ action: "settled" as const, events: [] }));
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
          async () =>
            ({
              id: "turn-claim-commit",
              triggerEventId: "trigger-claim-commit",
              executionGeneration: 1,
            }) as any,
        ),
        requestSessionTurnRecovery: mock(async (...args: unknown[]) => {
          recoveryCalls.push(args[2]);
          return { action: "recovering" as const, events: [] } as any;
        }),
        applySessionTurnSettlement: terminalSettlement as any,
        publishDurableSessionEvents: mock(async () => undefined),
        countQueuedTurns: mock(async () => 0),
        recordTurnsQueuedGauge: mock(() => undefined),
      },
    );

    expect(
      await activities.failSessionAttempt({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-claim-commit",
        workflowId: "session-session-1",
        preClaimFailureDisposition: "retryable",
        preClaimFailure: { disposition: "retryable", code: "db_deadlock" },
      }),
    ).toEqual({ action: "recovering" });
    expect(recoveryCalls).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-claim-commit",
        triggerEventId: "trigger-claim-commit",
        attemptId: "attempt-claim-commit",
        reason: "claimed_attempt_database_failure",
        detail: expect.objectContaining({ code: "db_deadlock", retryable: true }),
      }),
    ]);
    expect(terminalSettlement).not.toHaveBeenCalled();
  });

  test("recovers an ambiguously committed v3 claim from disposition-only retryable truth", async () => {
    const recoveryCalls: unknown[] = [];
    const terminalSettlement = mock(async () => ({ action: "settled" as const, events: [] }));
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
          async () =>
            ({
              id: "turn-v3-claim-commit",
              triggerEventId: "trigger-v3-claim-commit",
              executionGeneration: 1,
            }) as any,
        ),
        requestSessionTurnRecovery: mock(async (...args: unknown[]) => {
          recoveryCalls.push(args[2]);
          return { action: "recovering" as const, events: [] } as any;
        }),
        applySessionTurnSettlement: terminalSettlement as any,
        publishDurableSessionEvents: mock(async () => undefined),
        countQueuedTurns: mock(async () => 0),
        recordTurnsQueuedGauge: mock(() => undefined),
      },
    );

    expect(
      await activities.failSessionAttempt({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-v3-claim-commit",
        workflowId: "session-session-1",
        preClaimFailureDisposition: "retryable",
      }),
    ).toEqual({ action: "recovering" });
    expect(recoveryCalls).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-v3-claim-commit",
        triggerEventId: "trigger-v3-claim-commit",
        attemptId: "attempt-v3-claim-commit",
        reason: "claimed_attempt_database_failure",
        detail: expect.objectContaining({
          code: "legacy_retryable_preclaim_database_failure",
          retryable: true,
        }),
      }),
    ]);
    expect(terminalSettlement).not.toHaveBeenCalled();
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
      preClaimFailureDisposition: "retryable",
      preClaimFailure: { disposition: "retryable", code: "db_failure" },
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
      preClaimFailure: { disposition: "permanent", code: "claim_invariant" },
      trigger: { kind: "next" },
      error: "Agent turn admission failed before attempt claim.",
    });

    expect(result).toEqual({ action: "failed" });
    expect(terminalSettlement).toHaveBeenCalledTimes(1);
    expect(terminalSettlement).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1",
      expect.objectContaining({
        error: "Agent turn admission failed before attempt claim.",
        admissionFailure: { disposition: "permanent", code: "claim_invariant" },
      }),
    );
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
