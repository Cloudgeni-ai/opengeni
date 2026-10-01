import { describe, expect, mock, spyOn, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import * as opengeniDb from "@opengeni/db";
import { TurnExecutionPolicyDefinitionMismatchError } from "@opengeni/config";
import { CODEX_TRANSPORT_ERROR_HEADER } from "@opengeni/codex";
import { ModalCommandStartPreDispatchUnavailableError } from "../../../packages/runtime/src/sandbox/providers/modal-command-router-wire";
import {
  CompactionProviderResponseError,
  compactionProviderFailureDiagnostics,
} from "@opengeni/runtime";
import * as parentWake from "../src/activities/parent-wake";

import {
  codexCapacityWaitFailurePayload,
  codexCredentialFailoverLimit,
  codexDefinitiveFailureDisposition,
  settleTurnFailure,
} from "../src/activities/agent-turn/failure-settlement";
import { CodexCredentialLeaseLostError } from "../src/activities/agent-turn/credential-leases";
import {
  providerRecoveryResult,
  shouldRecoverCompactionProviderFailure,
} from "../src/activities/agent-turn/errors";

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

  test("a proven plan entitlement loss fails over, waits only on capped alternates, else fails", () => {
    expect(codexDefinitiveFailureDisposition({ ...base, failureKind: "plan_entitlement" })).toBe(
      "failover",
    );
    expect(
      codexDefinitiveFailureDisposition({
        ...base,
        failureKind: "plan_entitlement",
        decisionKind: "allCapped",
        decisionCredentialId: null,
      }),
    ).toBe("wait");
    for (const override of [
      { pinDisposition: "manual" as const },
      { rotationEnabled: false },
      { decisionKind: "none" as const, decisionCredentialId: null },
      {
        decisionKind: "allCapped" as const,
        decisionCredentialId: null,
        pinDisposition: "manual" as const,
      },
    ]) {
      expect(
        codexDefinitiveFailureDisposition({
          ...base,
          failureKind: "plan_entitlement",
          ...override,
        }),
      ).toBe("terminal");
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
    error?: unknown;
    settle?: (input: unknown) => Promise<boolean>;
    sessionId?: string;
    codexPolicySnapshot?: {
      schemaVersion: 1;
      activeCredentialId: string | null;
      rotationEnabled: boolean;
      rotationStrategy: string;
      pinnedCredentialId: string | null;
      pinSource: "manual" | "policy" | null;
      lastCredentialId: string | null;
    };
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
      error: overrides.error ?? codexAuthFailure(),
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
        dispatchId: "dispatch-1",
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
        effectiveCodexCredentialVersion: 1,
        codexCredentialFailoverLimit: 1,
        codexProductModelId: "codex/gpt-6-sol",
        codexPolicySnapshot: overrides.codexPolicySnapshot ?? {
          schemaVersion: 1,
          activeCredentialId: "serving",
          rotationEnabled: false,
          rotationStrategy: "sharded",
          pinnedCredentialId: null,
          pinSource: null,
          lastCredentialId: "serving",
        },
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

describe("raw database rollback settlement", () => {
  const rawFailure = (sqlState: string) =>
    new DrizzleQueryError(
      "INSERT INTO runtime_records (payload) VALUES ($1)",
      ["fixture-value"],
      Object.assign(new Error("transaction aborted"), { name: "PostgresError", code: sqlState }),
    );

  test("startup exports the exact recovery identity and retains its diagnostic cause", async () => {
    for (const [sqlState, code] of [
      ["40P01", "db_deadlock"],
      ["40001", "db_serialization_failure"],
    ] as const) {
      const error = rawFailure(sqlState);
      const { deps } = codexFailureDeps({ error });
      deps.billingState.isCodexTurn = false;
      deps.attempt.modelRequestStarted = false;
      deps.eventing.turnStartedPublished = false;
      Object.assign(deps.eventing, { publish: undefined });
      await expect(settleTurnFailure(deps as any)).rejects.toMatchObject({
        type: "OpenGeniPostClaimDatabaseRecovery",
        nonRetryable: true,
        details: [{ turnId: "turn-1", triggerEventId: "trigger-1", executionGeneration: 1, code }],
      });
      expect(deps.control.activityStatus).toBe("recovering");
      expect(deps.control.activityError).toBe(error);
    }
  });

  test("a model that already started cannot acquire database startup replay authority", async () => {
    const settle = mock(async () => true);
    const error = rawFailure("40P01");
    const { deps } = codexFailureDeps({ error, settle });
    deps.billingState.isCodexTurn = false;
    expect(await settleTurnFailure(deps as any)).toMatchObject({ status: "failed" });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          {
            type: "turn.failed",
            payload: expect.objectContaining({
              error: "OpenGeni encountered a database error.",
              code: "db_deadlock",
              sqlState: "40P01",
            }),
          },
        ]),
        turnStatus: "failed",
        sessionStatus: "failed",
        activeTurnId: null,
      }),
    );
    expect(JSON.stringify(settle.mock.calls)).not.toContain("fixture-value");
    expect(deps.control.activityError).toBe(error);
  });
});

describe("early accepted-definition mismatch", () => {
  function earlyDeps(error: unknown = new TurnExecutionPolicyDefinitionMismatchError()) {
    const { deps } = codexFailureDeps({ error });
    deps.billingState.isCodexTurn = false;
    deps.attempt.modelRequestStarted = false;
    deps.eventing.turnStartedPublished = false;
    Object.assign(deps.eventing, { publish: undefined });
    return deps;
  }

  test("pre-dispatch command-start setup recovery checkpoints before eventing with the same finite budget", async () => {
    const error = await ModalCommandStartPreDispatchUnavailableError.ensureReady({
      waitForReady: (_deadline: number, callback: (error: Error) => void) =>
        callback(new Error("router not ready")),
    } as never).catch((failure) => failure);
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    try {
      for (const [count, continueDelayMs] of [2000, 5000, 15000, 30000, 60000].entries()) {
        const deps = earlyDeps(error);
        deps.attempt.providerRecoveryCount = count;
        deps.historySink.reconcileConversationTruth = mock(async () => {
          throw new Error("no model history before eventing");
        });
        expect(await settleTurnFailure(deps as any)).toMatchObject({
          status: "recovering",
          turnId: "turn-1",
          continueDelayMs,
        });
        expect(recovery).toHaveBeenLastCalledWith(
          {},
          "workspace-1",
          expect.objectContaining({
            turnId: "turn-1",
            attemptId: "attempt-1",
            triggerEventId: "trigger-1",
            reason: "sandbox_command_start_unavailable",
            providerRecoveryCount: count + 1,
          }),
        );
        expect(deps.historySink.reconcileConversationTruth).not.toHaveBeenCalled();
      }
      const exhausted = earlyDeps(error);
      exhausted.attempt.providerRecoveryCount = 5;
      await expect(settleTurnFailure(exhausted as any)).rejects.toMatchObject({
        type: "SandboxCommandStartUnavailableError",
        nonRetryable: true,
        message: expect.stringContaining("stopped after 5 retries"),
      });
      expect(recovery).toHaveBeenCalledTimes(5);
    } finally {
      recovery.mockRestore();
    }
  });

  test("raw gRPC lookalikes never gain early command-start recovery authority", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery");
    try {
      for (const error of [
        Object.assign(new Error("Name resolution failed"), { code: 14 }),
        Object.assign(new Error("lookalike"), { name: "CommandStartPreDispatchUnavailableError" }),
      ]) {
        await expect(settleTurnFailure(earlyDeps(error) as any)).rejects.toBe(error);
      }
      expect(recovery).not.toHaveBeenCalled();
    } finally {
      recovery.mockRestore();
    }
  });

  test("checkpoints the exact turn before eventing without reconciling model history", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "stale",
    } as never);
    const deps = earlyDeps();
    const reconcile = mock(async () => {
      throw new Error("must not reconcile before inference");
    });
    deps.historySink.reconcileConversationTruth = reconcile;
    const lost = mock(() => undefined);
    deps.acknowledgeLostAttemptOwnership = lost;
    try {
      expect(await settleTurnFailure(deps as any)).toMatchObject({ status: "cancelled" });
      expect(recovery).toHaveBeenCalledWith(
        {},
        "workspace-1",
        expect.objectContaining({
          turnId: "turn-1",
          triggerEventId: "trigger-1",
          attemptId: "attempt-1",
          reason: "turn_execution_policy_definition_mismatch",
          providerRecoveryCount: 1,
          detail: expect.objectContaining({ continueDelayMs: 2000 }),
        }),
      );
      expect(lost).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      recovery.mockRestore();
    }
  });

  test("exhaustion preserves the typed configuration cause without another checkpoint", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery");
    const deps = earlyDeps();
    deps.attempt.providerRecoveryCount = 5;
    try {
      await expect(settleTurnFailure(deps as any)).rejects.toMatchObject({
        type: "TurnExecutionPolicyDefinitionMismatchError",
        nonRetryable: true,
        message: expect.stringContaining("configuration recovery exhausted after 5 retries"),
      });
      expect(recovery).not.toHaveBeenCalled();
    } finally {
      recovery.mockRestore();
    }
  });

  test("successful checkpoint acknowledges drain and returns bounded backoff", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    try {
      for (const [index, delay] of [2000, 5000, 15000, 30000, 60000].entries()) {
        const deps = earlyDeps();
        deps.attempt.providerRecoveryCount = index;
        const drain = mock(() => undefined);
        deps.acknowledgeRecoveryQuiescence = drain;
        expect(await settleTurnFailure(deps as any)).toMatchObject({
          status: "recovering",
          continueDelayMs: delay,
          turnId: "turn-1",
        });
        expect(drain).toHaveBeenCalledTimes(1);
        expect(deps.control.activityStatus).toBe("recovering");
      }
      expect(
        providerRecoveryResult({
          failureCode: "turn_execution_policy_definition_mismatch",
          attemptNumber: 6,
        }).status,
      ).toBe("exhausted");
    } finally {
      recovery.mockRestore();
    }
  });

  test("untyped errors and mismatches after startup never enter setup recovery", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery");
    try {
      for (const [error, modelStarted, turnStarted] of [
        [
          new Error("Turn execution policy does not match the current provider definition"),
          false,
          false,
        ],
        [
          Object.assign(new Error("lookalike"), {
            code: "turn_execution_policy_definition_mismatch",
          }),
          false,
          false,
        ],
        [new TurnExecutionPolicyDefinitionMismatchError(), true, false],
        [new TurnExecutionPolicyDefinitionMismatchError(), false, true],
      ] as const) {
        const deps = earlyDeps(error);
        deps.attempt.modelRequestStarted = modelStarted;
        deps.eventing.turnStartedPublished = turnStarted;
        await expect(settleTurnFailure(deps as any)).rejects.toBe(error);
      }
      expect(recovery).not.toHaveBeenCalled();
    } finally {
      recovery.mockRestore();
    }
  });

  test("checkpoint database outage carries the exact next count to control recovery", async () => {
    const outage = Object.assign(new Error("database disconnected"), { code: "CONNECTION_CLOSED" });
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockRejectedValue(outage);
    const deps = earlyDeps();
    deps.attempt.providerRecoveryCount = 2;
    try {
      await expect(settleTurnFailure(deps as any)).rejects.toMatchObject({
        type: "OpenGeniPostClaimDatabaseRecovery",
        nonRetryable: true,
        details: [
          expect.objectContaining({
            turnId: "turn-1",
            triggerEventId: "trigger-1",
            executionGeneration: 1,
            providerFailureCode: "turn_execution_policy_definition_mismatch",
            providerRecoveryCount: 3,
          }),
        ],
      });
    } finally {
      recovery.mockRestore();
    }
  });
});

test("persistence failure diagnostic is captured before a failing settlement dependency", async () => {
  const source = databaseReadFailure("accounts");
  const { deps } = codexFailureDeps({ error: source });
  const calls: unknown[] = [];
  Object.assign(deps.observability, {
    recordFailureDiagnostic: (input: unknown) => {
      calls.push(input);
      return "diagnostic-1";
    },
  });
  const blocked = new Error("later dependency unavailable");
  // A failure after capture cannot prevent enqueue; no real database is needed.
  Object.defineProperty(deps.attempt, "turnId", {
    get: () => {
      if (calls.length) throw blocked;
      return "turn-1";
    },
  });
  await expect(settleTurnFailure(deps as any)).rejects.toBe(blocked);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    error: source,
    code: "db_failure",
    sqlState: "08006",
    stage: "failure_settlement",
    attempts: 1,
    retryDecision: "not_retryable",
  });
});

describe("definitive Codex failure settlement", () => {
  test("both failure reads retain the accepted pool after live source is disabled", async () => {
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockImplementation(
      async (_db, _workspaceId, turnId) =>
        turnId === "turn-1"
          ? ([
              codexAccount("serving", { status: "needs_relogin" }),
              codexAccount("alternate"),
            ] as never)
          : [],
    );
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "recorded",
      failoverCount: 1,
      maxFailovers: 2,
      exhausted: false,
    });
    const failover = spyOn(opengeniDb, "settleCodexCredentialFailover").mockResolvedValue({
      action: "recovering",
      failoverCount: 1,
      maxFailovers: 2,
      events: [],
    });
    const { deps } = codexFailureDeps({
      codexPolicySnapshot: {
        schemaVersion: 1,
        source: "workspace",
        activeCredentialId: "serving",
        rotationEnabled: true,
        rotationStrategy: "sharded",
        pinnedCredentialId: null,
        pinSource: null,
        lastCredentialId: "serving",
      },
    });
    try {
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
      expect(listAccounts).toHaveBeenCalledTimes(2);
      for (const args of listAccounts.mock.calls) expect(args[2]).toBe("turn-1");
      expect(failover).toHaveBeenCalledTimes(1);
    } finally {
      listAccounts.mockRestore();
      quarantine.mockRestore();
      failover.mockRestore();
    }
  });
  test("routes a typed pre-dispatch deadline loss through lease-loss recovery", async () => {
    const leaseLoss = spyOn(opengeniDb, "settleCodexCredentialLeaseLoss").mockResolvedValue({
      action: "recovering",
      events: [],
    });
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease");
    const { deps, control } = codexFailureDeps({
      error: new CodexCredentialLeaseLostError("deadline"),
    });

    try {
      const result = await settleTurnFailure(deps as never);

      expect(result).toEqual({ status: "recovering", turnId: "turn-1", attemptId: "attempt-1" });
      expect(leaseLoss).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          checkpointDurable: true,
          recoveryPayload: expect.objectContaining({ reason: "codex_lease_lost" }),
        }),
      );
      expect(quarantine).not.toHaveBeenCalled();
      expect(deps.leases.codex.held).toBe(false);
      expect(control.activityStatus).toBe("recovering");
    } finally {
      leaseLoss.mockRestore();
      quarantine.mockRestore();
    }
  });

  test("keeps the accepted rotation-off policy when pin and rotation mutate after quarantine", async () => {
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses");
    listAccounts
      .mockResolvedValueOnce([codexAccount("serving")] as never)
      .mockResolvedValueOnce([
        codexAccount("serving", { status: "needs_relogin" }),
        codexAccount("alternate"),
      ] as never);
    const getRotation = spyOn(opengeniDb, "getCodexRotationSettings").mockResolvedValue({
      activeCredentialId: "alternate",
      rotationEnabled: true,
      rotationStrategy: "sharded",
    } as never);
    const getSession = spyOn(opengeniDb, "getSessionCodexState").mockResolvedValue({
      pinnedCredentialId: "alternate",
      lastCredentialId: "alternate",
      pinSource: "policy",
    });
    const getGoal = spyOn(opengeniDb, "getSessionGoal").mockResolvedValue(null);
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "recorded",
      failoverCount: 1,
      maxFailovers: 1,
      exhausted: false,
    });
    const failover = spyOn(opengeniDb, "settleCodexCredentialFailover");
    const armWait = spyOn(opengeniDb, "armCodexCapacityWait").mockResolvedValue({
      action: "waiting",
      waiter: {
        id: "waiter-1",
        generation: 1,
        nextCheckAt: new Date("2026-09-03T12:00:00.000Z"),
        wakeRevision: 1,
      },
      events: [],
    } as never);
    const reconcileWait = spyOn(opengeniDb, "reconcileCodexCapacityWait").mockResolvedValue({
      action: "resumed",
      waiter: { id: "waiter-1", generation: 1 },
      events: [],
    } as never);
    const { deps } = codexFailureDeps({
      codexPolicySnapshot: {
        schemaVersion: 1,
        activeCredentialId: "serving",
        rotationEnabled: false,
        rotationStrategy: "sharded",
        pinnedCredentialId: null,
        pinSource: null,
        lastCredentialId: "serving",
      },
    });

    try {
      const result = await settleTurnFailure(deps as never);

      expect(result).toEqual({ status: "recovering", turnId: "turn-1", attemptId: "attempt-1" });
      expect(listAccounts).toHaveBeenCalledTimes(2);
      expect(getRotation).not.toHaveBeenCalled();
      expect(getSession).not.toHaveBeenCalled();
      expect(failover).not.toHaveBeenCalled();
      expect(armWait).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ resetKind: "mutation_only" }),
      );
      expect(reconcileWait).toHaveBeenCalledTimes(1);
    } finally {
      listAccounts.mockRestore();
      getRotation.mockRestore();
      getSession.mockRestore();
      getGoal.mockRestore();
      quarantine.mockRestore();
      failover.mockRestore();
      armWait.mockRestore();
      reconcileWait.mockRestore();
    }
  });

  for (const failedRead of ["accounts", "goal"] as const) {
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
      const getGoal = spyOn(opengeniDb, "getSessionGoal").mockImplementation(async () => {
        if (failedRead === "goal") throw readFailure;
        return null;
      });
      const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
        action: "recorded",
        failoverCount: 1,
        maxFailovers: 1,
        exhausted: false,
      });
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
        expect(quarantine).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            credentialId: "serving",
            credentialVersion: 1,
            maxFailovers: 1,
            dispatchId: "dispatch-1",
          }),
        );
        expect(failover).not.toHaveBeenCalled();
        expect(armWait).not.toHaveBeenCalled();
        expect(control.activityStatus).toBe("recovering");
        expect(control.turnMetricOutcome).toBe("recovering");
        expect(control.activityError).toBe(readFailure);
      } finally {
        listAccounts.mockRestore();
        getGoal.mockRestore();
        quarantine.mockRestore();
        failover.mockRestore();
        armWait.mockRestore();
      }
    });
  }

  for (const armedAction of ["waiting", "stopped"] as const) {
    test(`capacity settlement ${armedAction === "waiting" ? "immediately reconciles a new wait" : "publishes the breaker and exits failed without reconciling"}`, async () => {
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
      const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
        action: "recorded",
        failoverCount: 1,
        maxFailovers: 1,
        exhausted: false,
      });
      const armWait = spyOn(opengeniDb, "armCodexCapacityWait").mockImplementation(async () => {
        callOrder.push("arm");
        return {
          action: armedAction,
          sessionStatus: "failed",
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

        expect(result).toEqual({
          status: armedAction === "stopped" ? "failed" : "recovering",
          turnId: "turn-1",
          attemptId: "attempt-1",
        });
        expect(callOrder).toEqual(armedAction === "stopped" ? ["arm"] : ["arm", "reconcile"]);
        expect(armWait).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            goalId: "goal-1",
            goalVersion: 3,
            resetKind: "mutation_only",
          }),
        );
        expect(deps.leases.codex.held).toBe(false);
        expect(control.activityStatus).toBe(armedAction === "stopped" ? "failed" : "recovering");
        expect(control.turnMetricOutcome).toBe(armedAction === "stopped" ? "failed" : "recovering");
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
  }

  test("recovers without poisoning a credential reconnected after the failing request", async () => {
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "credential_changed",
      failoverCount: 0,
      maxFailovers: 1,
      currentCredentialVersion: 2,
    });
    const leaseLoss = spyOn(opengeniDb, "settleCodexCredentialLeaseLoss").mockResolvedValue({
      action: "recovering",
      events: [],
    });
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses");
    const { deps, control } = codexFailureDeps();

    try {
      const result = await settleTurnFailure(deps as never);

      expect(result).toEqual({ status: "recovering", turnId: "turn-1", attemptId: "attempt-1" });
      expect(leaseLoss).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          checkpointDurable: true,
          recoveryPayload: expect.objectContaining({
            reason: "codex_credential_version_changed",
          }),
        }),
      );
      expect(listAccounts).toHaveBeenCalledTimes(1);
      expect(deps.leases.codex.held).toBe(false);
      expect(control.activityStatus).toBe("recovering");
    } finally {
      quarantine.mockRestore();
      leaseLoss.mockRestore();
      listAccounts.mockRestore();
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
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "recorded",
      failoverCount: 1,
      maxFailovers: 1,
      exhausted: false,
    });
    const failover = spyOn(opengeniDb, "settleCodexCredentialFailover").mockResolvedValue({
      action: "limit_exceeded",
      failoverCount: 1,
      maxFailovers: 2,
      events: [],
    });
    const parentDelivery = spyOn(parentWake, "deliverFailedChildTurnToParent").mockImplementation(
      async () => {
        callOrder.push("parent");
      },
    );
    const settle = mock(async () => true);
    const { deps, control } = codexFailureDeps({
      settle,
      sessionId: "child-1",
      codexPolicySnapshot: {
        schemaVersion: 1,
        activeCredentialId: "serving",
        rotationEnabled: true,
        rotationStrategy: "sharded",
        pinnedCredentialId: null,
        pinSource: null,
        lastCredentialId: "serving",
      },
    });

    try {
      const result = await settleTurnFailure(deps as never);

      expect(result).toEqual({ status: "idle", turnId: "turn-1", attemptId: "attempt-1" });
      expect(settle).not.toHaveBeenCalled();
      expect(parentDelivery).toHaveBeenCalledWith(
        expect.any(Object),
        "workspace-1",
        "child-1",
        "turn-1",
      );
      expect(callOrder).toEqual(["parent"]);
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

function codexEmptyBadRequest(): Error {
  return Object.assign(new Error("400 status code (no body)"), {
    status: 400,
    error: undefined,
    headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
  });
}

function planRecheck(
  overrides: Partial<opengeniDb.CodexCredentialPlanRecheck> = {},
): opengeniDb.CodexCredentialPlanRecheck {
  return {
    previousPlanType: "pro",
    planType: "pro",
    source: "usage",
    credentialVersion: 1,
    planChangedFrom: null,
    planChangedAt: overrides.planChangedFrom ? new Date() : null,
    exclusion: null,
    ...overrides,
  };
}

describe("Codex plan entitlement settlement", () => {
  const rotationOn = {
    schemaVersion: 1 as const,
    activeCredentialId: "serving",
    rotationEnabled: true,
    rotationStrategy: "sharded",
    pinnedCredentialId: null,
    pinSource: null,
    lastCredentialId: "serving",
  };

  test("an empty 400 on a downgraded account re-checks the plan and fails over the same turn", async () => {
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockImplementation(
      async () =>
        [
          codexAccount("serving", {
            label: "Work Pro",
            planType: "free",
            planEntitlementExclusion: {
              planType: "free",
              models: [{ modelId: "codex/gpt-6-sol", excludedAt: new Date() }],
            },
          }),
          codexAccount("alternate"),
        ] as never,
    );
    const recheck = spyOn(opengeniDb, "recheckCodexCredentialPlan").mockResolvedValue(
      planRecheck({ planType: "free", credentialVersion: 3, planChangedFrom: "pro" }),
    );
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "recorded",
      failoverCount: 1,
      maxFailovers: 1,
      exhausted: false,
    });
    const failover = spyOn(opengeniDb, "settleCodexCredentialFailover").mockResolvedValue({
      action: "recovering",
      failoverCount: 1,
      maxFailovers: 1,
      events: [],
    });
    const settle = mock(async () => true);
    const { deps, control } = codexFailureDeps({
      error: codexEmptyBadRequest(),
      settle,
      codexPolicySnapshot: rotationOn,
    });
    try {
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
      expect(recheck).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "workspace-1",
        "serving",
        {
          turnId: "turn-1",
          holderId: "holder-1",
          generation: 1,
        },
      );
      expect(quarantine).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          credentialId: "serving",
          credentialVersion: 3,
          quarantine: {
            kind: "plan_entitlement",
            modelId: "codex/gpt-6-sol",
            planType: "free",
            planObserved: true,
          },
        }),
      );
      expect(failover).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recoveryPayload: expect.objectContaining({
            reason: "codex_credential_failover",
            credentialId: "serving",
            failureKind: "plan_entitlement",
          }),
        }),
      );
      expect(settle).not.toHaveBeenCalled();
      expect(control.activityStatus).toBe("recovering");
    } finally {
      listAccounts.mockRestore();
      recheck.mockRestore();
      quarantine.mockRestore();
      failover.mockRestore();
    }
  });

  test("a downgrade a usage read recorded first still fails over the same turn", async () => {
    // Pro -> Plus was observed before the turn (accounts page usage read), so
    // the failing turn's re-check reads Plus again. The recorded change from
    // Pro is the evidence; the empty 400 must not become "unexplained".
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue([
      codexAccount("serving", { label: "Work", planType: "plus" }),
      codexAccount("alternate"),
    ] as never);
    const recheck = spyOn(opengeniDb, "recheckCodexCredentialPlan").mockResolvedValue(
      planRecheck({ previousPlanType: "plus", planType: "plus", planChangedFrom: "pro" }),
    );
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "recorded",
      failoverCount: 1,
      maxFailovers: 1,
      exhausted: false,
    });
    const failover = spyOn(opengeniDb, "settleCodexCredentialFailover").mockResolvedValue({
      action: "recovering",
      failoverCount: 1,
      maxFailovers: 1,
      events: [],
    });
    const { deps } = codexFailureDeps({
      error: codexEmptyBadRequest(),
      settle: mock(async () => true),
      codexPolicySnapshot: rotationOn,
    });
    try {
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
      expect(quarantine).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          quarantine: {
            kind: "plan_entitlement",
            modelId: "codex/gpt-6-sol",
            planType: "plus",
            planObserved: true,
          },
        }),
      );
      expect(failover).toHaveBeenCalledTimes(1);
    } finally {
      listAccounts.mockRestore();
      recheck.mockRestore();
      quarantine.mockRestore();
      failover.mockRestore();
    }
  });

  test("an empty 400 on the remote compaction request takes the same re-check and failover", async () => {
    const compaction = new CompactionProviderResponseError(
      compactionProviderFailureDiagnostics(codexEmptyBadRequest()),
      codexEmptyBadRequest(),
    );
    expect(compaction.status).toBe(400);
    expect(shouldRecoverCompactionProviderFailure(compaction)).toBe(true);
    // Another definitive compaction rejection stays terminal.
    const invalid = Object.assign(new Error("Invalid value"), {
      status: 400,
      headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
      error: { type: "invalid_request_error", code: "invalid_value", message: "Invalid value" },
    });
    expect(
      shouldRecoverCompactionProviderFailure(
        new CompactionProviderResponseError(compactionProviderFailureDiagnostics(invalid), invalid),
      ),
    ).toBe(false);

    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue([
      codexAccount("serving", { planType: "free" }),
      codexAccount("alternate"),
    ] as never);
    const recheck = spyOn(opengeniDb, "recheckCodexCredentialPlan").mockResolvedValue(
      planRecheck({ planType: "free", planChangedFrom: "pro" }),
    );
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "recorded",
      failoverCount: 1,
      maxFailovers: 1,
      exhausted: false,
    });
    const failover = spyOn(opengeniDb, "settleCodexCredentialFailover").mockResolvedValue({
      action: "recovering",
      failoverCount: 1,
      maxFailovers: 1,
      events: [],
    });
    const { deps } = codexFailureDeps({
      error: compaction,
      settle: mock(async () => true),
      codexPolicySnapshot: rotationOn,
    });
    try {
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
      expect(recheck).toHaveBeenCalledTimes(1);
      expect(quarantine).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          quarantine: expect.objectContaining({ kind: "plan_entitlement", planType: "free" }),
        }),
      );
      expect(failover).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recoveryPayload: expect.objectContaining({ failureKind: "plan_entitlement" }),
        }),
      );
    } finally {
      listAccounts.mockRestore();
      recheck.mockRestore();
      quarantine.mockRestore();
      failover.mockRestore();
    }
  });

  test("explicit plan evidence with an unreadable plan names no plan and binds the turn receipt to none", async () => {
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue([
      codexAccount("serving", { label: "Work Pro", planType: "pro" }),
    ] as never);
    const recheck = spyOn(opengeniDb, "recheckCodexCredentialPlan").mockResolvedValue(
      planRecheck({ planType: null, source: null }),
    );
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "recorded",
      failoverCount: 1,
      maxFailovers: 1,
      exhausted: false,
    });
    const parentDelivery = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined,
    );
    const settle = mock(async (_input: unknown) => true);
    const explicit = Object.assign(new Error("403 model not available on plan"), {
      status: 403,
      error: {
        code: "model_not_available_on_plan",
        message: "This model is not available on your current plan.",
      },
      headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
    });
    const { deps } = codexFailureDeps({ error: explicit, settle, codexPolicySnapshot: rotationOn });
    try {
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
      expect(quarantine).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          quarantine: {
            kind: "plan_entitlement",
            modelId: "codex/gpt-6-sol",
            planType: "pro",
            planObserved: false,
          },
        }),
      );
      const settled = settle.mock.calls[0]![0] as {
        events: Array<{ type: string; payload: Record<string, unknown> }>;
      };
      expect(settled.events[0]?.payload).toMatchObject({
        code: "codex_plan_entitlement",
        planType: null,
        error:
          'The ChatGPT account "Work Pro" no longer has access to GPT-6 Sol on its current plan. ' +
          "Upgrade it, use another connected account, or choose another model.",
      });
    } finally {
      listAccounts.mockRestore();
      recheck.mockRestore();
      quarantine.mockRestore();
      parentDelivery.mockRestore();
    }
  });

  test("without an alternate the turn fails with typed copy naming the account and plan", async () => {
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue([
      codexAccount("serving", { label: "Work Pro", planType: "free" }),
    ] as never);
    const recheck = spyOn(opengeniDb, "recheckCodexCredentialPlan").mockResolvedValue(
      planRecheck({
        planType: "free",
        source: "token_refresh",
        credentialVersion: 2,
        planChangedFrom: "pro",
      }),
    );
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "recorded",
      failoverCount: 1,
      maxFailovers: 1,
      exhausted: false,
    });
    const failover = spyOn(opengeniDb, "settleCodexCredentialFailover");
    const armWait = spyOn(opengeniDb, "armCodexCapacityWait");
    const parentDelivery = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined,
    );
    const settle = mock(async (_input: unknown) => true);
    const { deps } = codexFailureDeps({
      error: codexEmptyBadRequest(),
      settle,
      codexPolicySnapshot: rotationOn,
    });
    try {
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
      expect(quarantine).toHaveBeenCalledTimes(1);
      expect(failover).not.toHaveBeenCalled();
      expect(armWait).not.toHaveBeenCalled();
      expect(settle).toHaveBeenCalledTimes(1);
      const settled = settle.mock.calls[0]![0] as {
        events: Array<{ type: string; payload: unknown }>;
      };
      expect(settled.events[0]).toEqual({
        type: "turn.failed",
        payload: {
          error:
            'The ChatGPT account "Work Pro" is now on the Free plan, which doesn\'t include GPT-6 Sol. ' +
            "Upgrade it, use another connected account, or choose another model.",
          code: "codex_plan_entitlement",
          retryable: false,
          planType: "free",
          model: "codex/gpt-6-sol",
          detail: "The Codex backend answered HTTP 400 with no error body.",
        },
      });
    } finally {
      listAccounts.mockRestore();
      recheck.mockRestore();
      quarantine.mockRestore();
      failover.mockRestore();
      armWait.mockRestore();
      parentDelivery.mockRestore();
    }
  });

  test("an unchanged paid plan keeps the account and fails with typed copy, without looping", async () => {
    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue([
      codexAccount("serving", { label: "Work Pro" }),
      codexAccount("alternate"),
    ] as never);
    const recheck = spyOn(opengeniDb, "recheckCodexCredentialPlan").mockResolvedValue(
      planRecheck(),
    );
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease");
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery");
    const parentDelivery = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined,
    );
    const settle = mock(async (_input: unknown) => true);
    const { deps } = codexFailureDeps({
      error: codexEmptyBadRequest(),
      settle,
      codexPolicySnapshot: rotationOn,
    });
    try {
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
      expect(quarantine).not.toHaveBeenCalled();
      expect(recovery).not.toHaveBeenCalled();
      const settled = settle.mock.calls[0]![0] as {
        events: Array<{ type: string; payload: unknown }>;
      };
      expect(settled.events[0]?.payload).toMatchObject({
        code: "codex_request_rejected",
        retryable: false,
        planType: "pro",
      });
      expect(String((settled.events[0]!.payload as { error: string }).error)).toContain(
        'The ChatGPT account "Work Pro" still reports the Pro plan',
      );
    } finally {
      listAccounts.mockRestore();
      recheck.mockRestore();
      quarantine.mockRestore();
      recovery.mockRestore();
      parentDelivery.mockRestore();
    }
  });

  test("the encrypted-content 400 and quota 429 paths never re-check the plan", async () => {
    const recheck = spyOn(opengeniDb, "recheckCodexCredentialPlan");
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "stale",
    } as never);
    const history = spyOn(opengeniDb, "getActiveSessionHistoryItemsPaged").mockResolvedValue(
      [] as never,
    );
    const encrypted = Object.assign(new Error("400 invalid_encrypted_content"), {
      status: 400,
      error: {
        code: "invalid_encrypted_content",
        message: "The encrypted content could not be decrypted or parsed.",
      },
      headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
    });
    const { deps: encryptedDeps } = codexFailureDeps({ error: encrypted });
    try {
      await settleTurnFailure({
        ...encryptedDeps,
        historySink: {
          ...encryptedDeps.historySink,
          providerArtifactCandidates: { historyItemIds: [], runStateId: null },
        },
        providerTurn: { ...encryptedDeps.providerTurn, lastCodexRequestOpaqueArtifacts: [] },
      } as never);
      expect(recovery).toHaveBeenCalledWith(
        expect.anything(),
        "workspace-1",
        expect.objectContaining({ reason: "encrypted_content_rejected" }),
      );
      expect(recheck).not.toHaveBeenCalled();
    } finally {
      recovery.mockRestore();
      history.mockRestore();
    }

    const listAccounts = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue([
      codexAccount("serving"),
      codexAccount("alternate"),
    ] as never);
    const quarantine = spyOn(opengeniDb, "quarantineCodexCredentialForLease").mockResolvedValue({
      action: "recorded",
      failoverCount: 1,
      maxFailovers: 1,
      exhausted: false,
    });
    const failover = spyOn(opengeniDb, "settleCodexCredentialFailover").mockResolvedValue({
      action: "recovering",
      failoverCount: 1,
      maxFailovers: 1,
      events: [],
    });
    const quota = Object.assign(new Error("429 usage limit reached"), {
      status: 429,
      error: { type: "usage_limit_reached", resets_in_seconds: 3600 },
      headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
    });
    const { deps: quotaDeps } = codexFailureDeps({ error: quota, codexPolicySnapshot: rotationOn });
    try {
      expect(await settleTurnFailure(quotaDeps as never)).toMatchObject({ status: "recovering" });
      expect(recheck).not.toHaveBeenCalled();
      expect(quarantine).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          quarantine: expect.objectContaining({ kind: "cooldown", cooldownKind: "quota" }),
        }),
      );
      expect(failover).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recoveryPayload: expect.objectContaining({ failureKind: "quota" }),
        }),
      );
    } finally {
      recheck.mockRestore();
      listAccounts.mockRestore();
      quarantine.mockRestore();
      failover.mockRestore();
    }
  });
});
