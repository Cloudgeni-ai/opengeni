import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import { AnthropicRequestError } from "@opengeni/runtime";
import { ApplicationFailure } from "@temporalio/activity";
import { DrizzleQueryError } from "drizzle-orm";
import { isPostClaimDatabaseRecoveryCandidate } from "../src/activities/agent-turn/errors";
import {
  settleTurnFailure,
  type TurnFailureDeps,
} from "../src/activities/agent-turn/failure-settlement";
import {
  subscriptionCapacityArmingDiagnostic,
  subscriptionCapacityArmingFailure,
} from "../src/activities/agent-turn/subscription-capacity-arming";
import { selectClaudeTurnCapacity } from "../src/activities/agent-turn/xai-capacity";
import type { CapacityPhaseDeps } from "../src/activities/agent-turn/codex-capacity";

const restorers: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const restorer of restorers.splice(0)) restorer.mockRestore();
});

function postgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "PostgresError", code });
}

function drizzleWrapped(cause: Error): DrizzleQueryError {
  return new DrizzleQueryError("select private_detail", [], cause);
}

const armErrors = {
  plain: () => new Error("Session not found: private-row-identifier"),
  connectionLost: () => drizzleWrapped(postgresError("08006", "private connection detail")),
  socketReset: () =>
    drizzleWrapped(Object.assign(new Error("private driver detail"), { code: "ECONNRESET" })),
};

test("a capacity wait that cannot be armed becomes an explicit, secret-safe user state", () => {
  for (const provider of ["claude", "xai"] as const) {
    const failure = subscriptionCapacityArmingFailure(
      provider,
      new Error("Session not found: private-row-identifier"),
    );
    expect(failure).toEqual({
      error: expect.stringContaining(provider === "claude" ? "Claude" : "SuperGrok"),
      code: provider + "_capacity_wait_unavailable",
      retryable: true,
      recovery: "user_message",
    });
    expect(JSON.stringify(failure)).not.toContain("private-row-identifier");
  }
});

test("structured database outages keep their exact-attempt recovery path", () => {
  expect(subscriptionCapacityArmingFailure("claude", armErrors.socketReset())).toBeNull();
  expect(subscriptionCapacityArmingFailure("xai", armErrors.connectionLost())).toBeNull();
});

test("only own-client database failures are recovery candidates (strict running-turn lane)", () => {
  expect(isPostClaimDatabaseRecoveryCandidate(armErrors.connectionLost())).toBe(true);
  expect(isPostClaimDatabaseRecoveryCandidate(armErrors.socketReset())).toBe(true);
  // A transport-looking code without an ORM/persistence boundary is not ours.
  const bareTimeout = { code: "ETIMEDOUT" };
  expect(isPostClaimDatabaseRecoveryCandidate(bareTimeout)).toBe(false);
  expect(
    isPostClaimDatabaseRecoveryCandidate(Object.assign(new Error("timeout"), bareTimeout)),
  ).toBe(false);
  expect(isPostClaimDatabaseRecoveryCandidate(postgresError("08006", "unwrapped"))).toBe(false);
  expect(subscriptionCapacityArmingFailure("claude", bareTimeout)).toMatchObject({
    code: "claude_capacity_wait_unavailable",
  });
});

test("a permanent database rejection fails the turn but keeps its class and SQLSTATE for operators", () => {
  const denied = drizzleWrapped(
    postgresError("42501", "permission denied for private-table private-row-identifier"),
  );
  expect(isPostClaimDatabaseRecoveryCandidate(denied)).toBe(false);
  const failure = subscriptionCapacityArmingFailure("claude", denied);
  expect(failure).toMatchObject({ code: "claude_capacity_wait_unavailable", retryable: true });
  expect(JSON.stringify(failure)).not.toContain("42501");
  expect(JSON.stringify(failure)).not.toContain("private-row-identifier");
  const diagnostic = subscriptionCapacityArmingDiagnostic("claude", denied);
  expect(diagnostic).toEqual({
    errorClass: "DrizzleQueryError",
    errorCode: "claude_capacity_wait_unavailable",
    origin: "database",
    sqlState: "42501",
  });
  expect(JSON.stringify(diagnostic)).not.toContain("private");
  expect(subscriptionCapacityArmingDiagnostic("xai", armErrors.plain())).toEqual({
    errorClass: "Error",
    errorCode: "xai_capacity_wait_unavailable",
    origin: "worker",
  });
});

function observabilityFixture() {
  return {
    incrementCounter: () => undefined,
    observeHistogram: () => undefined,
    warn: mock((_message: string, _attributes?: Record<string, unknown>) => undefined),
    error: () => undefined,
  };
}

function control() {
  return {
    cancellationRequestedAt: null,
    activityStatus: "unknown",
    turnMetricOutcome: null as string | null,
    activityError: null as unknown,
    acknowledgeQuiescence: false,
  };
}

const claimedResult = (value: Record<string, unknown>) => ({
  ...value,
  turnId: "turn-1",
  attemptId: "attempt-1",
});

const expectedUnavailableSettlement = {
  events: [
    {
      type: "turn.failed",
      payload: {
        error: expect.stringContaining("Claude"),
        code: "claude_capacity_wait_unavailable",
        retryable: true,
        recovery: "user_message",
      },
    },
    { type: "session.status.changed", payload: { status: "idle" } },
  ],
  turnStatus: "failed",
  sessionStatus: "idle",
  activeTurnId: null,
};

describe("turn-start capacity arming", () => {
  function capacityDeps() {
    const settle = mock(async (_settlement: unknown) => true);
    const observability = observabilityFixture();
    const deps = {
      input: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        workflowId: "session-session-1",
      },
      settings: {},
      db: {},
      bus: {},
      observability,
      dispatchId: "dispatch-1",
      control: control(),
      billingState: { isClaudeTurn: true, isXaiTurn: false },
      eventing: { publish: async () => [], settle },
      providerTurn: {},
      leases: { claude: { held: false, subjectId: null }, xai: { held: false } },
      claimedResult,
      turn: {
        id: "turn-1",
        source: "user",
        initiatingHumanSubjectId: "user:owner",
        claudeProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      },
      turnExecutionPolicy: { upstreamModelId: "claude-opus-fixture", productModelId: "fixture" },
    } as unknown as CapacityPhaseDeps;
    restorers.push(
      spyOn(opengeniDb, "getClaudeSessionAccountPin").mockResolvedValue(null),
      spyOn(opengeniDb, "getSessionGoal").mockResolvedValue(null),
      spyOn(opengeniDb, "acquireClaudeCredentialLease").mockResolvedValue({
        credentialId: null,
        rotationEnabled: false,
        holderId: null,
        generation: null,
        leasedUntil: null,
        nextCheckAt: null,
        accounts: [
          {
            id: "credential-1",
            allowedModelIds: null,
            allocatorEnabled: true,
            exhaustedUntil: null,
          },
        ],
      } as never),
    );
    return { deps, settle, observability };
  }

  test("a plain arming error fails the turn explicitly and leaves the session idle", async () => {
    const { deps, settle, observability } = capacityDeps();
    const armError = armErrors.plain();
    const arm = spyOn(opengeniDb, "armClaudeCapacityWait").mockRejectedValue(armError);
    restorers.push(arm);
    expect(await selectClaudeTurnCapacity(deps)).toEqual({
      exit: { status: "idle", turnId: "turn-1", attemptId: "attempt-1" },
    });
    expect(arm.mock.calls[0]![1]).toMatchObject({
      subjectId: opengeniDb.subscriptionPoolWorkerSubject("claude"),
      turnId: "turn-1",
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![0]).toEqual(expectedUnavailableSettlement);
    expect(JSON.stringify(settle.mock.calls[0]![0])).not.toContain("private-row-identifier");
    expect(deps.control).toMatchObject({
      activityStatus: "idle",
      turnMetricOutcome: "failed",
      activityError: armError,
    });
    expect(observability.warn).toHaveBeenCalledWith(expect.any(String), {
      errorClass: "Error",
      errorCode: "claude_capacity_wait_unavailable",
      origin: "worker",
    });
  });

  for (const kind of ["connectionLost", "socketReset"] as const)
    test(`a Drizzle-wrapped ${kind} arming error is rethrown to database recovery`, async () => {
      const { deps, settle } = capacityDeps();
      const armError = armErrors[kind]();
      restorers.push(spyOn(opengeniDb, "armClaudeCapacityWait").mockRejectedValue(armError));
      await expect(selectClaudeTurnCapacity(deps)).rejects.toBe(armError);
      expect(settle).not.toHaveBeenCalled();
    });
});

describe("failure-settlement capacity arming", () => {
  function failureDeps() {
    const settle = mock(async (_settlement: unknown) => true);
    const observability = observabilityFixture();
    const error = new AnthropicRequestError(
      "Synthetic provider failure",
      429,
      "anthropic_http_error",
      { type: "rate_limit_error", message: "Fixture" },
      new Headers({ "retry-after": "120", "request-id": "req_exact_fixture" }),
    );
    const deps = {
      error,
      input: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        workflowId: "session-session-1",
      },
      settings: { environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64") },
      db: {},
      bus: {},
      observability,
      wakeSessionWorkflow: async () => undefined,
      cancellationSignal: undefined,
      sandboxRotationController: new AbortController(),
      noteCancellationRequested: () => undefined,
      codexWorkspaceKey: "workspace-key",
      control: control(),
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
      billingState: { isCodexTurn: false, isXaiTurn: false, isClaudeTurn: true },
      eventing: { publish: async () => [], turnStartedPublished: true, settle },
      providerTurn: {
        effectiveClaudeCredentialId: "credential-fixture",
        effectiveClaudeCredentialVersion: 3,
        claudeAuthoritySnapshot: { version: 1, scope: "workspace" },
        claudeUpstreamModelId: "claude-opus-fixture",
        latestClaudeUsage: new Map([
          [
            "fixture",
            {
              scope: "workspace",
              token: "sk-ant-oat01-fixture",
              expectedConnectionId: "credential-fixture",
              expectedCredentialVersion: 3,
              responseStatus: 429,
              requestId: "req_exact_fixture",
              upstreamModelId: "claude-opus-fixture",
            },
          ],
        ]),
      },
      leases: {
        codex: { lost: false },
        xai: { lost: false },
        claude: {
          lost: false,
          held: true,
          subjectId: opengeniDb.subscriptionPoolWorkerSubject("claude"),
          holderId: "holder-fixture",
          generation: 7,
        },
      },
      historySink: { reconcileConversationTruth: async () => undefined },
      claimedResult,
      flushRuntimeBatcher: async () => undefined,
      acknowledgeLostAttemptOwnership: () => undefined,
      acknowledgeRecoveryQuiescence: () => undefined,
    } as unknown as TurnFailureDeps;
    restorers.push(
      spyOn(opengeniDb, "getSessionGoal").mockResolvedValue(null),
      spyOn(opengeniDb, "recordClaudeAccountUsage").mockResolvedValue({} as never),
    );
    return { deps, settle, observability };
  }

  test("a plain arming error fails the turn explicitly and leaves the session idle", async () => {
    const { deps, settle, observability } = failureDeps();
    const armError = armErrors.plain();
    const arm = spyOn(opengeniDb, "armClaudeCapacityWait").mockRejectedValue(armError);
    restorers.push(arm);
    expect(await settleTurnFailure(deps)).toEqual({
      status: "idle",
      turnId: "turn-1",
      attemptId: "attempt-1",
    });
    expect(arm).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![0]).toEqual(expectedUnavailableSettlement);
    expect(deps.control).toMatchObject({
      activityStatus: "idle",
      turnMetricOutcome: "failed",
      activityError: armError,
    });
    expect(observability.warn).toHaveBeenCalledWith(expect.any(String), {
      errorClass: "Error",
      errorCode: "claude_capacity_wait_unavailable",
      origin: "worker",
    });
  });

  for (const kind of ["connectionLost", "socketReset"] as const)
    test(`a Drizzle-wrapped ${kind} arming error is rethrown to database recovery`, async () => {
      const { deps, settle } = failureDeps();
      restorers.push(
        spyOn(opengeniDb, "armClaudeCapacityWait").mockRejectedValue(armErrors[kind]()),
      );
      const failure = await settleTurnFailure(deps).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect((failure as ApplicationFailure).type).toBe("OpenGeniPostClaimDatabaseRecovery");
      expect(deps.control.activityStatus).toBe("recovering");
      expect(settle).not.toHaveBeenCalled();
    });
});
