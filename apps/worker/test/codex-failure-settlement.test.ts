import { describe, expect, mock, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { DrizzleQueryError } from "drizzle-orm";
import { ToolCallError } from "@openai/agents";

import * as opengeniDb from "@opengeni/db";
import { TurnExecutionPolicyDefinitionMismatchError } from "@opengeni/config";
import { CODEX_TRANSPORT_ERROR_HEADER, CodexResponseTimeoutError } from "@opengeni/codex";
import { ModalCommandStartPreDispatchUnavailableError } from "../../../packages/runtime/src/sandbox/providers/modal-command-router-wire";
import {
  CompactionProviderResponseError,
  AnthropicRequestError,
  ProviderCommandObservationUnavailableError,
  RoutingMutationOutcomeUnknownError,
  compactionProviderFailureDiagnostics,
} from "@opengeni/runtime";
import * as parentWake from "../src/activities/parent-wake";

import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import {
  MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  providerRecoveryResult,
} from "../src/activities/agent-turn/errors";

const { CommandStartOutcomeUnknownError } = createRequire(import.meta.resolve("@opengeni/runtime"))(
  "modal",
);

function genuineSetupUnknown() {
  return new Error("SDK setup unwound", {
    cause: new CommandStartOutcomeUnknownError(
      "task-owning-turn-original",
      crypto.randomUUID(),
      Object.assign(new Error("lost original Start acknowledgement"), { code: 14 }),
    ),
  });
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

describe("confirmed Claude overload settlement", () => {
  const overload = () =>
    new AnthropicRequestError(
      "Claude request failed (HTTP 529)",
      529,
      "anthropic_http_error",
      { type: "overloaded_error", message: "Synthetic overload" },
      new Headers({ "retry-after": "85", "request-id": "req_synthetic" }),
    );

  test("checkpoints the same turn after five retries with the selected finite budget", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    try {
      for (const count of [0, 5, 14]) {
        const { deps } = codexFailureDeps({ error: overload() });
        deps.billingState.isCodexTurn = false;
        Object.assign(deps.attempt, {
          providerRecoveryCount: count,
          providerRecoveryStartedAt: Date.now() - 60_000,
        });
        const history = mock(async () => undefined);
        deps.historySink.reconcileConversationTruth = history;
        const result = await settleTurnFailure(deps as never);
        expect(result).toMatchObject({ status: "recovering" });
        expect(result.continueDelayMs).toBeGreaterThanOrEqual(85_000);
        expect(history).toHaveBeenCalledWith({ requireDurable: true });
        expect(recovery).toHaveBeenLastCalledWith(
          {},
          "workspace-1",
          expect.objectContaining({
            turnId: "turn-1",
            triggerEventId: "trigger-1",
            attemptId: "attempt-1",
            reason: "provider_overloaded",
            providerRecoveryCount: count + 1,
            detail: expect.objectContaining({
              code: "provider_unavailable",
              providerCondition: "overloaded",
              maxProviderRecoveryCount: 15,
              requestId: "req_synthetic",
            }),
          }),
        );
        expect((recovery.mock.calls.at(-1)![2] as any).detail).not.toHaveProperty("detail");
      }
    } finally {
      recovery.mockRestore();
    }
  });

  test("checkpoint outages retain overload count and Retry-After instead of the generic five-retry cap", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockRejectedValue(
      Object.assign(new Error("database connection reset"), { code: "ECONNRESET" }),
    );
    const { deps } = codexFailureDeps({ error: overload() });
    deps.billingState.isCodexTurn = false;
    Object.assign(deps.attempt, {
      providerRecoveryCount: 5,
      providerRecoveryStartedAt: Date.now() - 60_000,
    });
    try {
      await expect(settleTurnFailure(deps as never)).rejects.toMatchObject({
        type: "OpenGeniPostClaimDatabaseRecovery",
        details: [
          {
            turnId: "turn-1",
            triggerEventId: "trigger-1",
            executionGeneration: 1,
            providerFailureCode: "provider_overloaded",
            providerRecoveryCount: 6,
            providerRecoveryContinueDelayMs: expect.any(Number),
          },
        ],
      });
    } finally {
      recovery.mockRestore();
    }
  });

  test("exhaustion retains the typed cause; stale control commits never authorize another attempt", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "stale",
    } as never);
    const parent = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined);
    const settle = mock(async (_input: unknown) => true);
    try {
      const { deps } = codexFailureDeps({ error: overload(), settle });
      deps.billingState.isCodexTurn = false;
      Object.assign(deps.attempt, {
        providerRecoveryCount: 15,
        providerRecoveryStartedAt: Date.now() - 60_000,
      });
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
      expect(recovery).not.toHaveBeenCalled();
      expect((settle.mock.calls[0]![0] as any).events[0].payload).toMatchObject({
        code: "provider_unavailable",
        retryable: false,
        recoveryExhausted: true,
        providerRecoveryCount: 15,
        maxProviderRecoveryCount: 15,
        providerRecoveryExhaustedReason: "retry_limit",
        detail: "overloaded_error: Synthetic overload",
        requestId: "req_synthetic",
      });
      const { deps: interrupted } = codexFailureDeps({ error: overload(), settle });
      interrupted.billingState.isCodexTurn = false;
      expect(await settleTurnFailure(interrupted as never)).toMatchObject({ status: "cancelled" });
      expect(settle).toHaveBeenCalledTimes(1);
    } finally {
      recovery.mockRestore();
      parent.mockRestore();
    }
  });
});

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

  test("a running turn's rolled-back deadlock victim recovers the exact attempt without turn.failed", async () => {
    // PostgreSQL aborted the victim transaction, so nothing it wrote committed.
    // Like an outage, it enters exact-attempt DB-only recovery; recovery never
    // replays a tool and no logical failure is settled.
    for (const [sqlState, code] of [
      ["40P01", "db_deadlock"],
      ["40001", "db_serialization_failure"],
    ] as const) {
      const settle = mock(async () => true);
      const error = rawFailure(sqlState);
      const { deps } = codexFailureDeps({ error, settle });
      deps.billingState.isCodexTurn = false;
      await expect(settleTurnFailure(deps as any)).rejects.toMatchObject({
        type: "OpenGeniPostClaimDatabaseRecovery",
        details: [{ turnId: "turn-1", triggerEventId: "trigger-1", executionGeneration: 1, code }],
      });
      expect(settle).not.toHaveBeenCalled();
      expect(deps.control.activityStatus).toBe("recovering");
      expect(deps.control.activityError).toBe(error);
    }
  });
});

describe("executing-turn database outage handoff", () => {
  function outage(code = "CONNECT_TIMEOUT") {
    return new DrizzleQueryError(
      "select account_id from workspaces",
      ["private-fixture"],
      Object.assign(new Error("private connection detail"), { code }),
    );
  }

  test.each(
    ["CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED"].flatMap(
      (code) => ["delta", "function-tool", "history"].map((stage) => ({ code, stage })),
    ),
  )(
    "%j outage stops without logical failure, ledger replay or invented writer proof",
    async ({ code, stage }) => {
      const cause = outage(code);
      const error =
        stage === "function-tool"
          ? new ToolCallError("Failed to run function tools", cause)
          : stage === "history"
            ? new Error("History persistence failed", { cause })
            : cause;
      const terminal = mock(async () => true);
      const flush = mock(async () => undefined);
      const history = mock(async () => undefined);
      const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery");
      const { deps } = codexFailureDeps({ error, settle: terminal });
      deps.flushRuntimeBatcher = flush;
      deps.historySink.reconcileConversationTruth = history;
      try {
        await expect(settleTurnFailure(deps as any)).rejects.toMatchObject({
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
        expect(terminal).not.toHaveBeenCalled();
        expect(recovery).not.toHaveBeenCalled();
        expect(flush).not.toHaveBeenCalled();
        expect(history).not.toHaveBeenCalled();
        expect(deps.control).toMatchObject({
          activityStatus: "recovering",
          turnMetricOutcome: "recovering",
          acknowledgeQuiescence: false,
        });
        expect(deps.attempt.providerRecoveryCount).toBe(0);
        expect(deps.control.activityError).toBe(error);
      } finally {
        recovery.mockRestore();
      }
    },
  );

  test.each(
    ["CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED"].flatMap(
      (code) => ["flush", "history", "settlement"].map((stage) => ({ code, stage })),
    ),
  )(
    "DB outage during %j of an unrelated error also exports exact recovery",
    async ({ code, stage }) => {
      const terminal = mock(async () => {
        if (stage === "settlement") throw outage(code);
        return true;
      });
      const { deps } = codexFailureDeps({ error: new Error("ordinary failure"), settle: terminal });
      deps.billingState.isCodexTurn = false;
      deps.flushRuntimeBatcher = mock(async () => {
        if (stage === "flush") throw outage(code);
      });
      deps.historySink.reconcileConversationTruth = mock(async () => {
        if (stage === "history") throw outage(code);
      });
      await expect(settleTurnFailure(deps as any)).rejects.toMatchObject({
        type: "OpenGeniPostClaimDatabaseRecovery",
        nonRetryable: true,
        details: [expect.objectContaining({ turnId: "turn-1", executionGeneration: 1 })],
      });
      expect(deps.control.activityStatus).toBe("recovering");
      expect(deps.control.acknowledgeQuiescence).toBe(false);
      expect(terminal).toHaveBeenCalledTimes(stage === "settlement" ? 1 : 0);
    },
  );

  test("a settlement outage cannot erase the original unknown tool outcome", async () => {
    const database = outage("CONNECTION_CLOSED");
    const terminal = mock(async () => {
      throw database;
    });
    const { deps } = codexFailureDeps({
      error: new RoutingMutationOutcomeUnknownError("execCommand", "unknown effect"),
      settle: terminal,
    });
    deps.billingState.isCodexTurn = false;
    await expect(settleTurnFailure(deps as any)).rejects.toBe(database);
    expect(deps.control.activityStatus).not.toBe("recovering");
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

  test.each([0, 4, 5])(
    "post-start internal observation uncertainty parks without replenishing recovery count %i",
    async (count) => {
      const command = {
        kind: "modal-router-v1" as const,
        sandboxId: "sb-test",
        taskId: "task-test",
        execId: "792e06b2-03c7-40f0-baa7-a51cf4bddaf8",
        streams: {
          stdout: { byteOffset: 17, utf8Remainder: "", eof: false, exitCode: null },
          stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        },
      };
      const error = new Error("setup observer unwound", {
        cause: new ProviderCommandObservationUnavailableError(command, { code: 14 }),
      });
      const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
        action: "recovering",
        events: [],
      } as never);
      const deps = earlyDeps(error);
      deps.attempt.providerRecoveryCount = count;
      const settled = mock(async () => true);
      deps.eventing.settle = settled;
      try {
        expect(await settleTurnFailure(deps as any)).toMatchObject({
          status: "recovering",
          deferredUntilWake: true,
        });
        expect(recovery).toHaveBeenCalledTimes(1);
        expect(recovery.mock.calls[0]?.[2]).toMatchObject({
          reason: "sandbox_command_observation_unavailable",
          sandboxSetupOutcomeUnknown: true,
          detail: {
            code: "sandbox_command_observation_unavailable",
            retryable: false,
            replay: "blocked",
            providerRecoveryCount: count,
          },
        });
        expect(recovery.mock.calls[0]?.[2]).not.toHaveProperty("providerRecoveryCount");
        expect(settled).not.toHaveBeenCalled();
        expect(deps.control.activityStatus).toBe("recovering");
      } finally {
        recovery.mockRestore();
      }
    },
  );

  test.each([0, 4, 5])(
    "genuine setup uncertainty parks before eventing without resetting recovery count %i",
    async (count) => {
      const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
        action: "recovering",
        events: [],
      } as never);
      const deps = earlyDeps(genuineSetupUnknown());
      deps.attempt.providerRecoveryCount = count;
      const reconcile = mock(async () => {
        throw new Error("no fabricated model history before inference");
      });
      deps.historySink.reconcileConversationTruth = reconcile;
      const settled = mock(async () => true);
      deps.eventing.settle = settled;
      try {
        expect(await settleTurnFailure(deps as any)).toMatchObject({
          status: "recovering",
          deferredUntilWake: true,
          turnId: "turn-1",
          attemptId: "attempt-1",
        });
        expect(recovery).toHaveBeenCalledTimes(1);
        expect(recovery.mock.calls[0]?.[2]).toMatchObject({
          reason: "sandbox_command_start_outcome_unknown",
          sandboxSetupOutcomeUnknown: true,
          detail: { retryable: false, replay: "blocked", providerRecoveryCount: count },
        });
        expect(recovery.mock.calls[0]?.[2]).not.toHaveProperty("providerRecoveryCount");
        expect(reconcile).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(deps.control.activityStatus).toBe("recovering");
      } finally {
        recovery.mockRestore();
      }
    },
  );

  test("setup uncertainty respects a stale ownership receipt instead of painting recovery", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "stale",
      events: [],
    } as never);
    const deps = earlyDeps(genuineSetupUnknown());
    const lost = mock(() => undefined);
    deps.acknowledgeLostAttemptOwnership = lost;
    try {
      expect(await settleTurnFailure(deps as any)).toMatchObject({ status: "cancelled" });
      expect(lost).toHaveBeenCalledTimes(1);
    } finally {
      recovery.mockRestore();
    }
  });

  test.each([false, true])(
    "setup uncertainty after eventing preserves history and no-replay authority on checkpoint outage %s",
    async (outage) => {
      const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
        action: "recovering",
        events: [],
      } as never);
      const { deps } = codexFailureDeps({ error: genuineSetupUnknown() });
      const reconcile = mock(async () => {
        if (outage)
          throw Object.assign(new Error("history database reset"), { code: "ECONNRESET" });
      });
      const terminal = mock(async () => true);
      deps.historySink.reconcileConversationTruth = reconcile;
      deps.eventing.settle = terminal;
      try {
        if (outage) {
          await expect(settleTurnFailure(deps as any)).rejects.toMatchObject({
            type: "OpenGeniPostClaimDatabaseRecovery",
            details: [expect.objectContaining({ sandboxSetupOutcomeUnknown: true })],
          });
          expect(recovery).not.toHaveBeenCalled();
        } else {
          expect(await settleTurnFailure(deps as any)).toMatchObject({
            status: "recovering",
            deferredUntilWake: true,
          });
          expect(recovery).toHaveBeenCalledTimes(1);
        }
        expect(reconcile).toHaveBeenCalledWith({ requireDurable: true });
        expect(terminal).not.toHaveBeenCalled();
        expect(deps.control.activityStatus).toBe("recovering");
      } finally {
        recovery.mockRestore();
      }
    },
  );

  test("a setup-unknown checkpoint outage carries the no-replay marker into DB-only recovery", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockRejectedValue(
      Object.assign(new Error("database connection reset"), { code: "ECONNRESET" }),
    );
    const deps = earlyDeps(genuineSetupUnknown());
    try {
      await expect(settleTurnFailure(deps as any)).rejects.toMatchObject({
        type: "OpenGeniPostClaimDatabaseRecovery",
        nonRetryable: true,
        details: [
          {
            turnId: "turn-1",
            triggerEventId: "trigger-1",
            executionGeneration: 1,
            code: "db_failure",
            sandboxSetupOutcomeUnknown: true,
          },
        ],
      });
      expect(deps.control.activityStatus).toBe("recovering");
    } finally {
      recovery.mockRestore();
    }
  });

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
      expect(await settleTurnFailure(exhausted as any)).toMatchObject({
        status: "recovering",
        turnId: "turn-1",
      });
      expect(exhausted.control.activityStatus).toBe("recovering");
      expect(recovery).toHaveBeenCalledTimes(6);
      const checkpoint = recovery.mock.calls[5]?.[2];
      expect(checkpoint).toMatchObject({
        turnId: "turn-1",
        attemptId: "attempt-1",
        triggerEventId: "trigger-1",
        reason: "sandbox_command_start_recovery_exhausted",
        sandboxSetupRecoveryExhausted: true,
        detail: {
          setupOutcome: "not_started",
          retryable: false,
          replay: "blocked",
          recoveryExhausted: true,
          providerRecoveryCount: 5,
        },
      });
      expect(checkpoint).not.toHaveProperty("providerRecoveryCount");
      expect(checkpoint).not.toHaveProperty("sandboxSetupOutcomeUnknown");
      expect(opengeniDb.SANDBOX_SETUP_RECOVERY_LIMIT).toBe(5);
      expect(MAX_AUTOMATIC_PROVIDER_RECOVERIES).toBe(opengeniDb.SANDBOX_SETUP_RECOVERY_LIMIT);
    } finally {
      recovery.mockRestore();
    }
  });

  test.each(["stale", "db_deadlock", "db_failure"] as const)(
    "exhausted pre-dispatch setup preserves the park fate on %s",
    async (failure) => {
      const error = await ModalCommandStartPreDispatchUnavailableError.ensureReady({
        waitForReady: (_deadline: number, callback: (error: Error) => void) =>
          callback(new Error("router not ready")),
      } as never).catch((value) => value);
      const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery");
      if (failure === "stale") {
        recovery.mockResolvedValue({ action: "stale", events: [] } as never);
      } else {
        recovery.mockRejectedValue(
          failure === "db_deadlock"
            ? Object.assign(new Error("test rollback"), { name: "PostgresError", code: "40P01" })
            : Object.assign(new Error("test disconnected DB"), { code: "ECONNRESET" }),
        );
      }
      const deps = earlyDeps(error);
      deps.attempt.providerRecoveryCount = 5;
      deps.historySink.reconcileConversationTruth = mock(async () => undefined);
      try {
        if (failure === "stale") {
          expect(await settleTurnFailure(deps as any)).toMatchObject({ status: "cancelled" });
        } else {
          await expect(settleTurnFailure(deps as any)).rejects.toMatchObject({
            type: "OpenGeniPostClaimDatabaseRecovery",
            nonRetryable: true,
            details: [
              {
                turnId: "turn-1",
                triggerEventId: "trigger-1",
                executionGeneration: 1,
                code: failure,
                sandboxSetupRecoveryExhausted: true,
              },
            ],
          });
          expect(deps.control.activityStatus).toBe("recovering");
        }
        expect(recovery).toHaveBeenCalledTimes(1);
        expect(deps.attempt.providerRecoveryCount).toBe(5);
        expect(deps.historySink.reconcileConversationTruth).not.toHaveBeenCalled();
      } finally {
        recovery.mockRestore();
      }
    },
  );

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

describe("a cut-off checkpoint request", () => {
  const timedOutCheckpoint = () => {
    const timeout = new CodexResponseTimeoutError("idle_stream", "attempt:1:1:7", true);
    return new CompactionProviderResponseError(
      compactionProviderFailureDiagnostics(timeout),
      timeout,
    );
  };

  test("retries within the provider budget and an exhausted terminal keeps its cause", async () => {
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    const settle = mock(async (_input: unknown) => true);
    try {
      const error = timedOutCheckpoint();
      const { deps } = codexFailureDeps({ error });
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
      expect(recovery).toHaveBeenLastCalledWith(
        {},
        "workspace-1",
        expect.objectContaining({
          reason: "provider_unavailable",
          providerRecoveryCount: 1,
          detail: expect.objectContaining({
            code: "provider_unavailable",
            timeoutClass: "idle_stream",
            responseObserved: true,
            requestId: "attempt:1:1:7",
            detail: error.message,
          }),
        }),
      );

      recovery.mockClear();
      const exhausted = codexFailureDeps({ error: timedOutCheckpoint(), settle });
      exhausted.deps.attempt.providerRecoveryCount = 5;
      expect(await settleTurnFailure(exhausted.deps as never)).toMatchObject({
        status: "failed",
      });
      expect(recovery).not.toHaveBeenCalled();
      expect((settle.mock.calls[0]![0] as any).events[0].payload).toMatchObject({
        code: "provider_unavailable",
        retryable: false,
        recoveryExhausted: true,
        providerRecoveryCount: 5,
        maxProviderRecoveryCount: 5,
        timeoutClass: "idle_stream",
        requestId: "attempt:1:1:7",
        detail: error.message,
      });
    } finally {
      recovery.mockRestore();
    }
  });
});
