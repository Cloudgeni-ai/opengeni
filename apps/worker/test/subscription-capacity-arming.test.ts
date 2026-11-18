import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as eventBus from "@opengeni/events";
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

describe.each(["codex", "claude", "xai"] as const)("%s capacity wait start log", (provider) => {
  function fixture(events: unknown[]) {
    const info = mock((_message: string, _attributes: Record<string, unknown>) => undefined);
    const waiter = {
      waiterId: "waiter-1",
      provider,
      generation: 1,
      wakeRevision: 1,
      waitReason: "no_eligible_capacity",
      earliestResetAt: new Date("2030-01-01T00:00:00.000Z"),
      nextCheckAt: new Date("2030-01-01T00:01:00.000Z"),
    };
    const arm = mock(async () => ({ action: "waiting" as const, waiter, events }));
    const deps = {
      input: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
      },
      db: {},
      bus: {},
      observability: { info, warn: mock(() => undefined) },
      control: { activityStatus: "running", turnMetricOutcome: null, activityError: null },
      attempt: { turnId: "turn-1" },
      eventing: { settle: mock(async () => true) },
      claimedResult: (value: Record<string, unknown>) => ({ ...value }),
      acknowledgeLostAttemptOwnership: mock(() => undefined),
    } as unknown as CapacityPhaseDeps;
    restorers.push(spyOn(db, "getSessionGoal").mockResolvedValue(null));
    restorers.push(spyOn(db, "resolveWaitingSteer").mockResolvedValue(null as never));
    restorers.push(
      spyOn(eventBus, "publishDurableSessionEvents").mockResolvedValue(undefined as never),
    );
    // The waiter is gone by the immediate re-evaluation; the start is logged regardless.
    const binding = {
      provider,
      arm,
      getWaiterById: async () => null,
    } as unknown as CoreWaitBinding;
    const run = () =>
      parkCoreSubscriptionTurn(
        deps,
        {
          kind: "wait",
          reason: "no_eligible_capacity",
          earliestResetAt: null,
          healthRetryAt: null,
        },
        binding,
        providers[provider],
      );
    return { info, run };
  }

  test("a newly armed wait logs its start once", async () => {
    const f = fixture([{ type: "turn.capacity_waiting" }]);
    await f.run();
    const starts = f.info.mock.calls.filter(
      ([message]) => message === "Turn started waiting for subscription capacity",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]![1]).toMatchObject({
      provider,
      waitReason: "no_eligible_capacity",
      earliestResetAt: "2030-01-01T00:00:00.000Z",
      nextCheckAt: "2030-01-01T00:01:00.000Z",
      waiterId: "waiter-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });
  });

  test("a replayed arm that finds its wait in place logs nothing", async () => {
    const f = fixture([]);
    await f.run();
    expect(f.info).not.toHaveBeenCalled();
  });
});
