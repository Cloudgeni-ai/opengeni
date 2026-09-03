import { describe, expect, mock, spyOn, test } from "bun:test";

import * as opengeniDb from "@opengeni/db";
import { CODEX_TRANSPORT_ERROR_HEADER } from "@opengeni/codex";
import * as parentWake from "../src/activities/parent-wake";

import {
  codexCapacityWaitFailurePayload,
  codexCredentialFailoverLimit,
  codexDefinitiveFailureDisposition,
  settleTurnFailure,
} from "../src/activities/agent-turn/failure-settlement";

const base = {
  rotationEnabled: true,
  pinDisposition: "unpinned" as const,
  decisionKind: "active" as const,
  decisionCredentialId: "alternate",
  servingCredentialId: "serving",
};

describe("definitive Codex credential failure disposition", () => {
  test("rotation-on quota refusal recovers the same turn on an eligible alternate", () => {
    expect(codexDefinitiveFailureDisposition({ ...base, failureKind: "quota" })).toBe("failover");
  });

  test("rotation-on auth refusal also fails over only when an alternate is eligible", () => {
    expect(codexDefinitiveFailureDisposition({ ...base, failureKind: "auth" })).toBe("failover");
  });

  test("rotation-off quota refusal waits even when the ranker sees a healthy alternate", () => {
    expect(
      codexDefinitiveFailureDisposition({
        ...base,
        failureKind: "quota",
        rotationEnabled: false,
      }),
    ).toBe("wait");
  });

  test("manual pin quota refusal waits instead of silently walking the pool", () => {
    expect(
      codexDefinitiveFailureDisposition({
        ...base,
        failureKind: "quota",
        pinDisposition: "manual",
      }),
    ).toBe("wait");
  });

  test("manual pins and rotation-off also wait for auth health recovery", () => {
    expect(
      codexDefinitiveFailureDisposition({
        ...base,
        failureKind: "auth",
        pinDisposition: "manual",
      }),
    ).toBe("wait");
    expect(
      codexDefinitiveFailureDisposition({
        ...base,
        failureKind: "forbidden",
        rotationEnabled: false,
      }),
    ).toBe("wait");
  });

  test("all-unavailable pools enter durable capacity waiting for every definitive refusal", () => {
    for (const failureKind of ["quota", "rate_limit", "auth", "forbidden"] as const) {
      expect(
        codexDefinitiveFailureDisposition({
          ...base,
          failureKind,
          decisionKind: "allCapped",
          decisionCredentialId: null,
        }),
      ).toBe("wait");
    }
  });

  test("auth or forbidden refusal without an alternate remains terminal", () => {
    for (const failureKind of ["auth", "forbidden"] as const) {
      expect(
        codexDefinitiveFailureDisposition({
          ...base,
          failureKind,
          decisionKind: "none",
          decisionCredentialId: null,
        }),
      ).toBe("terminal");
    }
  });
});

describe("definitive Codex failure settlement helpers", () => {
  test("non-usage-limit quota codes retain quota semantics in durable waits", () => {
    expect(
      codexCapacityWaitFailurePayload({
        failureKind: "quota",
        usageLimit: null,
        cooldownSeconds: 3600,
        detail: "provider returned insufficient_quota",
        allAccounts: false,
      }),
    ).toEqual({
      error:
        "Your ChatGPT/Codex subscription usage limit has been reached. Access resets in about 1h. You can switch this session to a different model in the meantime, or wait for the limit to reset.",
      code: "codex_usage_limit_reached",
      detail: "provider returned insufficient_quota",
      retryable: false,
    });
  });

  test("allocator-disabled rows do not enlarge the same-turn failover budget", () => {
    expect(
      codexCredentialFailoverLimit(
        [
          { id: "serving", allocatorEnabled: true },
          { id: "alternate", allocatorEnabled: true },
          ...Array.from({ length: 20 }, (_, index) => ({
            id: `disabled-${index}`,
            allocatorEnabled: false,
          })),
        ],
        "serving",
      ),
    ).toBe(1);
    expect(
      codexCredentialFailoverLimit([{ id: "serving", allocatorEnabled: true }], "serving"),
    ).toBe(1);
  });

  test("an allocator-disabled serving credential preserves every enabled alternate", () => {
    expect(
      codexCredentialFailoverLimit(
        [
          { id: "serving", allocatorEnabled: false },
          { id: "alternate-b", allocatorEnabled: true },
          { id: "alternate-c", allocatorEnabled: true },
        ],
        "serving",
      ),
    ).toBe(2);
  });
});

function codexAccount(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source: "workspace",
    chatgptAccountId: `chatgpt-${id}`,
    label: id,
    accountEmail: null,
    planType: "pro",
    status: "active",
    allocatorEnabled: true,
    allocatorVersion: 1,
    allocatorUpdatedBySubjectId: null,
    allocatorUpdatedAt: null,
    resetCreditAvailableCount: null,
    resetCreditsCheckedAt: null,
    connectedBySubjectId: null,
    isActive: id === "serving",
    expiresAt: null,
    lastRefreshAt: null,
    lastError: null,
    primaryUsedPercent: 0,
    primaryResetAt: null,
    secondaryUsedPercent: 0,
    secondaryResetAt: null,
    usageCheckedAt: null,
    exhaustedUntil: null,
    exhaustedKind: null,
    ...overrides,
  };
}

function codexAuthFailure(): Error {
  return Object.assign(new Error("Codex credential was rejected"), {
    status: 401,
    headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
  });
}

function databaseReadFailure(label: string): opengeniDb.SessionEventPersistenceError {
  return new opengeniDb.SessionEventPersistenceError({
    code: "db_failure",
    sqlState: "08006",
    stage: `codex_failure_policy.${label}`,
    eventTypes: [],
    correlationId: `correlation-${label}`,
    attempts: 1,
    retryOutcome: "not_retryable",
    database: {},
  });
}

function codexFailureDeps(
  overrides: {
    settle?: (input: unknown) => Promise<boolean>;
    sessionId?: string;
  } = {},
) {
  const control = {
    cancellationRequestedAt: null,
    activityStatus: "unknown",
    turnMetricOutcome: null,
    activityError: null,
    acknowledgeQuiescence: false,
  };
  return {
    control,
    deps: {
      error: codexAuthFailure(),
      input: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: overrides.sessionId ?? "session-1",
        attemptId: "attempt-1",
        workflowId: "session-session-1",
      },
      settings: {},
      db: {},
      bus: {},
      observability: {
        incrementCounter: () => undefined,
        observeHistogram: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      wakeSessionWorkflow: async () => undefined,
      cancellationSignal: undefined,
      sandboxRotationController: new AbortController(),
      noteCancellationRequested: () => undefined,
      codexWorkspaceKey: "workspace-key",
      control,
      attempt: {
        turnId: "turn-1",
        triggerEventId: "trigger-1",
        executionGeneration: 1,
        providerRecoveryCount: 0,
        modelRequestStarted: true,
        redispatchesAtDispatch: 0,
        triggerType: "user",
      },
      billingState: { isCodexTurn: true },
      eventing: {
        publish: async () => [],
        turnStartedPublished: true,
        settle: overrides.settle ?? (async () => true),
      },
      providerTurn: {
        effectiveCodexCredentialId: "serving",
        latestCodexUsage: null,
      },
      leases: {
        codex: {
          lost: false,
          held: true,
          holderId: "holder-1",
          generation: 1,
        },
        xai: { lost: false },
      },
      historySink: { reconcileConversationTruth: async () => undefined },
      claimedResult: (value: Record<string, unknown>) => ({
        ...value,
        turnId: "turn-1",
        attemptId: "attempt-1",
      }),
      flushRuntimeBatcher: async () => undefined,
      acknowledgeLostAttemptOwnership: () => undefined,
      acknowledgeRecoveryQuiescence: () => undefined,
    },
  };
}

describe("definitive Codex failure settlement", () => {
  for (const failedRead of ["rotation", "accounts", "session", "goal"] as const) {
    test(`recovers without choosing policy when the ${failedRead} metadata read fails`, async () => {
      const readFailure = databaseReadFailure(failedRead);
      let accountReads = 0;
      const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockImplementation(
        async () => {
          accountReads += 1;
          if (failedRead === "accounts" && accountReads === 2) throw readFailure;
          return [codexAccount("serving"), codexAccount("alternate")] as never;
        },
      );
      const getRotation = spyOn(opengeniDb, "getCodexRotationSettings").mockImplementation(
        async () => {
          if (failedRead === "rotation") throw readFailure;
          return {
            activeCredentialId: "serving",
            rotationEnabled: failedRead !== "goal",
            rotationStrategy: "most_remaining",
          } as never;
        },
      );
      const getSession = spyOn(opengeniDb, "getSessionCodexState").mockImplementation(async () => {
        if (failedRead === "session") throw readFailure;
        return { pinnedCredentialId: null, lastCredentialId: "serving", pinSource: null };
      });
      const getGoal = spyOn(opengeniDb, "getSessionGoal").mockImplementation(async () => {
        if (failedRead === "goal") throw readFailure;
        return null;
      });
      const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue(
        true,
      );
      const failover = spyOn(opengeniDb, "settleCodexCredentialFailover");
      const armWait = spyOn(opengeniDb, "armCodexCapacityWait");
      const { deps, control } = codexFailureDeps();

      try {
        const caught = await settleTurnFailure(deps as never).catch((error: unknown) => error);

        expect(caught).toMatchObject({
          type: "OpenGeniPostClaimDatabaseRecovery",
          nonRetryable: true,
          details: [
            {
              turnId: "turn-1",
              triggerEventId: "trigger-1",
              executionGeneration: 1,
              code: "db_failure",
            },
          ],
        });
        expect(quarantine).toHaveBeenCalledTimes(1);
        expect(failover).not.toHaveBeenCalled();
        expect(armWait).not.toHaveBeenCalled();
        expect(control.activityStatus).toBe("recovering");
        expect(control.turnMetricOutcome).toBe("recovering");
        expect(control.activityError).toBe(readFailure);
      } finally {
        listAccounts.mockRestore();
        getRotation.mockRestore();
        getSession.mockRestore();
        getGoal.mockRestore();
        quarantine.mockRestore();
        failover.mockRestore();
        armWait.mockRestore();
      }
    });
  }

  test("immediately re-evaluates a newly armed wait and recovers when capacity won the race", async () => {
    const callOrder: string[] = [];
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue([
      codexAccount("serving"),
      codexAccount("alternate"),
    ] as never);
    const getRotation = spyOn(opengeniDb, "getCodexRotationSettings").mockResolvedValue({
      activeCredentialId: "serving",
      rotationEnabled: false,
      rotationStrategy: "most_remaining",
    } as never);
    const getSession = spyOn(opengeniDb, "getSessionCodexState").mockResolvedValue({
      pinnedCredentialId: null,
      lastCredentialId: "serving",
      pinSource: null,
    });
    const getGoal = spyOn(opengeniDb, "getSessionGoal").mockResolvedValue({
      id: "goal-1",
      status: "active",
      version: 3,
    } as never);
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue(
      true,
    );
    const armWait = spyOn(opengeniDb, "armCodexCapacityWait").mockImplementation(async () => {
      callOrder.push("arm");
      return {
        action: "waiting",
        waiter: {
          id: "waiter-1",
          generation: 4,
          nextCheckAt: new Date("2026-09-03T12:00:00.000Z"),
          wakeRevision: 7,
        },
        events: [],
      } as never;
    });
    const reconcileWait = spyOn(opengeniDb, "reconcileCodexCapacityWait").mockImplementation(
      async () => {
        callOrder.push("reconcile");
        return {
          action: "resumed",
          waiter: { id: "waiter-1", generation: 4 },
          events: [],
        } as never;
      },
    );
    const { deps, control } = codexFailureDeps();

    try {
      const result = await settleTurnFailure(deps as never);

      expect(result).toEqual({ status: "recovering", turnId: "turn-1", attemptId: "attempt-1" });
      expect(callOrder).toEqual(["arm", "reconcile"]);
      expect(armWait).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ goalId: "goal-1", goalVersion: 3 }),
      );
      expect(deps.leases.codex.held).toBe(false);
      expect(control.activityStatus).toBe("recovering");
      expect(control.turnMetricOutcome).toBe("recovering");
    } finally {
      listAccounts.mockRestore();
      getRotation.mockRestore();
      getSession.mockRestore();
      getGoal.mockRestore();
      quarantine.mockRestore();
      armWait.mockRestore();
      reconcileWait.mockRestore();
    }
  });

  test("delivers a failover-exhausted child failure to its parent after settlement", async () => {
    const callOrder: string[] = [];
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue([
      codexAccount("serving", { status: "needs_relogin" }),
      codexAccount("alternate"),
    ] as never);
    const getRotation = spyOn(opengeniDb, "getCodexRotationSettings").mockResolvedValue({
      activeCredentialId: "serving",
      rotationEnabled: true,
      rotationStrategy: "most_remaining",
    } as never);
    const getSession = spyOn(opengeniDb, "getSessionCodexState").mockResolvedValue({
      pinnedCredentialId: null,
      lastCredentialId: "serving",
      pinSource: null,
    });
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue(
      true,
    );
    const failover = spyOn(opengeniDb, "settleCodexCredentialFailover").mockResolvedValue({
      action: "limit_exceeded",
      failoverCount: 1,
      events: [],
    });
    const parentDelivery = spyOn(parentWake, "deliverFailedChildTurnToParent").mockImplementation(
      async () => {
        callOrder.push("parent");
      },
    );
    const settle = mock(async () => {
      callOrder.push("settle");
      return true;
    });
    const { deps, control } = codexFailureDeps({ settle, sessionId: "child-1" });

    try {
      const result = await settleTurnFailure(deps as never);

      expect(result).toEqual({ status: "idle", turnId: "turn-1", attemptId: "attempt-1" });
      expect(settle).toHaveBeenCalledWith({
        events: [
          {
            type: "turn.failed",
            payload: {
              error:
                "Automatic Codex credential failover stopped after every bounded account attempt was consumed. Send a new message after checking account health or capacity.",
              code: "codex_credential_failover_exhausted",
              retryable: false,
              recovery: "user_message",
              failoverCount: 1,
              maxFailovers: 1,
            },
          },
          { type: "session.status.changed", payload: { status: "idle" } },
        ],
        turnStatus: "failed",
        sessionStatus: "idle",
        activeTurnId: null,
        suppressGoalContinuation: true,
      });
      expect(parentDelivery).toHaveBeenCalledWith(
        expect.any(Object),
        "workspace-1",
        "child-1",
        "turn-1",
      );
      expect(callOrder).toEqual(["settle", "parent"]);
      expect(control.activityStatus).toBe("idle");
      expect(control.turnMetricOutcome).toBe("failed");
    } finally {
      listAccounts.mockRestore();
      getRotation.mockRestore();
      getSession.mockRestore();
      quarantine.mockRestore();
      failover.mockRestore();
      parentDelivery.mockRestore();
    }
  });
});
