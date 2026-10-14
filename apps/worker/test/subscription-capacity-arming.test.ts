import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { DrizzleQueryError } from "drizzle-orm";
import { isPostClaimDatabaseRecoveryCandidate } from "../src/activities/agent-turn/errors";
import {
  subscriptionCapacityArmingDiagnostic,
  subscriptionCapacityArmingFailure,
} from "../src/activities/agent-turn/subscription-capacity-arming";
import { parkCoreSubscriptionTurn } from "../src/activities/agent-turn/subscription-core-capacity";
import type { CapacityPhaseDeps } from "../src/activities/agent-turn/codex-capacity";
import type { CoreWaitBinding } from "../src/activities/subscription-core-codex-waits";

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

const providers = { codex: "Codex", claude: "Claude", xai: "SuperGrok" } as const;

test("SUB-WAIT-05: a capacity wait that cannot be armed becomes an explicit, secret-safe user state", () => {
  for (const provider of ["codex", "claude", "xai"] as const) {
    const failure = subscriptionCapacityArmingFailure(provider, armErrors.plain());
    expect(failure).toEqual({
      error: expect.stringContaining(providers[provider]),
      code: provider + "_capacity_wait_unavailable",
      retryable: true,
      recovery: "user_message",
    });
    expect(JSON.stringify(failure)).not.toContain("private-row-identifier");
  }
});

test("SUB-WAIT-05: structured database outages keep their exact-attempt recovery path", () => {
  expect(subscriptionCapacityArmingFailure("claude", armErrors.socketReset())).toBeNull();
  expect(subscriptionCapacityArmingFailure("xai", armErrors.connectionLost())).toBeNull();
});

test("only own-client database failures are recovery candidates (strict running-turn lane)", () => {
  expect(isPostClaimDatabaseRecoveryCandidate(armErrors.connectionLost())).toBe(true);
  expect(isPostClaimDatabaseRecoveryCandidate(armErrors.socketReset())).toBe(true);
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

test("a permanent database rejection keeps its class and SQLSTATE only for operators", () => {
  const denied = drizzleWrapped(
    postgresError("42501", "permission denied for private-row-identifier"),
  );
  expect(isPostClaimDatabaseRecoveryCandidate(denied)).toBe(false);
  const failure = subscriptionCapacityArmingFailure("claude", denied);
  expect(failure).toMatchObject({ code: "claude_capacity_wait_unavailable", retryable: true });
  expect(JSON.stringify(failure)).not.toContain("42501");
  expect(JSON.stringify(failure)).not.toContain("private-row-identifier");
  expect(subscriptionCapacityArmingDiagnostic("claude", denied)).toEqual({
    errorClass: "DrizzleQueryError",
    errorCode: "claude_capacity_wait_unavailable",
    origin: "database",
    sqlState: "42501",
  });
  expect(subscriptionCapacityArmingDiagnostic("xai", armErrors.plain())).toEqual({
    errorClass: "Error",
    errorCode: "xai_capacity_wait_unavailable",
    origin: "worker",
  });
});

// Turn-start placement and refusal settlement both use this shared arming
// boundary. A failure must never pretend the waiter was durably installed.
describe.each(["codex", "claude", "xai"] as const)("%s core capacity arming", (provider) => {
  function fixture(error: Error, settlementAccepted = true) {
    const settle = mock(async (_settlement: unknown) => settlementAccepted);
    const warn = mock((_message: string, _attributes: unknown) => undefined);
    const acknowledge = mock(() => undefined);
    const arm = mock(async () => {
      throw error;
    });
    const deps = {
      input: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
      },
      db: {},
      bus: {},
      observability: { warn },
      control: { activityStatus: "running", turnMetricOutcome: null, activityError: null },
      attempt: { turnId: "turn-1" },
      eventing: { settle },
      claimedResult: (value: Record<string, unknown>) => ({
        ...value,
        turnId: "turn-1",
        attemptId: "attempt-1",
      }),
      acknowledgeLostAttemptOwnership: acknowledge,
    } as unknown as CapacityPhaseDeps;
    restorers.push(spyOn(db, "getSessionGoal").mockResolvedValue(null));
    const run = () =>
      parkCoreSubscriptionTurn(
        deps,
        {
          kind: "wait",
          reason: "no_eligible_capacity",
          earliestResetAt: null,
          healthRetryAt: null,
        },
        { provider, arm } as unknown as CoreWaitBinding,
        providers[provider],
      );
    return { deps, settle, warn, arm, acknowledge, run };
  }

  test.each(["plain", "permission"] as const)(
    "%s arming failure settles explicitly, without a fake waiter",
    async (kind) => {
      const error =
        kind === "plain"
          ? armErrors.plain()
          : drizzleWrapped(postgresError("42501", "private-row-identifier"));
      const f = fixture(error);
      expect(await f.run()).toEqual({
        exit: { status: "idle", turnId: "turn-1", attemptId: "attempt-1" },
      });
      expect(f.arm).toHaveBeenCalledTimes(1);
      expect(f.settle).toHaveBeenCalledWith({
        events: [
          { type: "turn.failed", payload: subscriptionCapacityArmingFailure(provider, error) },
          { type: "session.status.changed", payload: { status: "idle" } },
        ],
        turnStatus: "failed",
        sessionStatus: "idle",
        activeTurnId: null,
      });
      expect(JSON.stringify(f.settle.mock.calls)).not.toContain("private-row-identifier");
      expect(f.deps.control).toMatchObject({
        activityStatus: "idle",
        turnMetricOutcome: "failed",
        activityError: error,
      });
      expect(f.warn).toHaveBeenCalledWith(
        expect.any(String),
        subscriptionCapacityArmingDiagnostic(provider, error),
      );
      expect(f.acknowledge).not.toHaveBeenCalled();
    },
  );

  test.each(["connectionLost", "socketReset"] as const)(
    "%s preserves the exact error for database recovery",
    async (kind) => {
      const error = armErrors[kind]();
      const f = fixture(error);
      await expect(f.run()).rejects.toBe(error);
      expect(f.settle).not.toHaveBeenCalled();
      expect(f.acknowledge).not.toHaveBeenCalled();
    },
  );

  test("a superseded attempt cannot settle its successor", async () => {
    const f = fixture(armErrors.plain(), false);
    expect(await f.run()).toEqual({
      exit: { status: "cancelled", turnId: "turn-1", attemptId: "attempt-1" },
    });
    expect(f.acknowledge).toHaveBeenCalledTimes(1);
    expect(f.deps.control).toMatchObject({
      activityStatus: "cancelled",
      turnMetricOutcome: "cancelled",
    });
  });
});
