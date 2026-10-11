import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import { createCodexCapacityActivities } from "../src/activities/codex-capacity";
import {
  CORE_CODEX_WAKE_DELIVERY_MAX_ATTEMPTS,
  coreCodexWakeRetryDelayMs,
  deliverSubscriptionCoreCodexWakes,
  evaluateCoreCodexBlockedTurn,
  reconcileCoreCodexCapacityWait,
  wakeSubscriptionCoreCodexWaitersAndDeliver,
} from "../src/activities/subscription-core-codex-waits";

const restores: Array<{ mockRestore(): void }> = [];
function spy<T extends object, K extends keyof T>(target: T, key: K) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const handle = spyOn(target as any, key as any);
  restores.push(handle);
  return handle;
}
afterEach(() => {
  while (restores.length > 0) restores.pop()!.mockRestore();
});

const scope = { accountId: "account-1", workspaceId: "workspace-1" };

function delivery(overrides: Partial<db.SubscriptionCapacityWakeDelivery> = {}) {
  return {
    id: "delivery-1",
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    waiterId: "waiter-1",
    generation: 1,
    wakeRevision: 4,
    claimGeneration: 2,
    attemptCount: 1,
    ...overrides,
  };
}

/** The outbox scope runs its callback against a fake transaction handle. */
function outbox(deliveries: db.SubscriptionCapacityWakeDelivery[]) {
  spy(db, "withSubscriptionCapacityWakeOutboxScope").mockImplementation(
    (async (_db: unknown, _scope: unknown, operation: (tx: never) => Promise<unknown>) =>
      await operation({} as never)) as never,
  );
  return {
    claim: spy(db, "claimSubscriptionCapacityWakeDeliveries").mockResolvedValue(deliveries),
    mark: spy(db, "markSubscriptionCapacityWakeDelivered").mockResolvedValue(true),
    retry: spy(db, "retrySubscriptionCapacityWakeDelivery").mockResolvedValue(true),
    abandon: spy(db, "abandonSubscriptionCapacityWakeDelivery").mockResolvedValue(true),
  };
}

const waiter: db.SubscriptionCoreCodexCapacityWait = {
  waiterId: "waiter-1",
  accountId: "account-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  blockedTurnId: "turn-1",
  blockedTurnGeneration: 3,
  generation: 2,
  wakeRevision: 5,
  observedWakeRevision: 4,
  waitReason: "no_eligible_capacity",
  resetKind: "authoritative",
  refreshAttempt: 0,
  earliestResetAt: new Date("2030-01-01T00:00:00.000Z"),
  nextCheckAt: new Date("2030-01-01T00:00:00.000Z"),
  goalId: null,
  goalVersion: null,
  lastWakeReason: "quota_observed_available",
};

describe("core Codex wake outbox delivery", () => {
  test("signals codexCapacityChanged with the waiter's wake revision, then acknowledges", async () => {
    const { claim, mark, retry } = outbox([delivery()]);
    const signal = mock(async () => undefined);
    expect(
      await deliverSubscriptionCoreCodexWakes(
        { db: {} as db.Database, signalCodexCapacityWorkflow: signal },
        scope,
      ),
    ).toEqual({ claimed: 1, delivered: 1, retried: 0, abandoned: 0 });
    expect(claim).toHaveBeenCalledWith({}, { limit: 100, claimTtlMs: 60_000 });
    expect(signal).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      workflowId: "session-session-1",
      wakeRevision: 4,
    });
    expect(mark).toHaveBeenCalledWith({}, delivery());
    expect(retry).not.toHaveBeenCalled();
  });

  test("a failed signal is retried with bounded backoff, then given up", async () => {
    const { mark, retry, abandon } = outbox([
      delivery({ id: "first", attemptCount: 3 }),
      delivery({ id: "last", attemptCount: CORE_CODEX_WAKE_DELIVERY_MAX_ATTEMPTS }),
    ]);
    const signal = mock(async () => {
      throw new Error("temporal unavailable");
    });
    expect(
      await deliverSubscriptionCoreCodexWakes(
        { db: {} as db.Database, signalCodexCapacityWorkflow: signal },
        scope,
      ),
    ).toEqual({ claimed: 2, delivered: 0, retried: 1, abandoned: 1 });
    expect(mark).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith(
      {},
      {
        id: "first",
        claimGeneration: 2,
        retryInMs: coreCodexWakeRetryDelayMs(3),
        failureCode: "signal_failed",
      },
    );
    expect(abandon).toHaveBeenCalledWith(
      {},
      { id: "last", claimGeneration: 2, failureCode: "signal_attempts_exhausted" },
    );
  });

  test("a host without a capacity signaler leaves every wake pending for one that has it", async () => {
    const { claim, mark, retry, abandon } = outbox([delivery()]);
    expect(await deliverSubscriptionCoreCodexWakes({ db: {} as db.Database }, scope)).toEqual({
      claimed: 0,
      delivered: 0,
      retried: 0,
      abandoned: 0,
    });
    expect(claim).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
  });

  test("the retry delay doubles from one second and is capped at five minutes", () => {
    expect(coreCodexWakeRetryDelayMs(1)).toBe(1_000);
    expect(coreCodexWakeRetryDelayMs(2)).toBe(2_000);
    expect(coreCodexWakeRetryDelayMs(5)).toBe(16_000);
    expect(coreCodexWakeRetryDelayMs(20)).toBe(300_000);
    expect(coreCodexWakeRetryDelayMs(0)).toBe(1_000);
  });

  test("a wake commits first, then delivers each touched workspace; a failed wake never throws", async () => {
    const wake = spy(db, "wakeSubscriptionCoreCodexCapacityWaiters").mockResolvedValue([
      scope,
      { accountId: "account-1", workspaceId: "workspace-2" },
    ]);
    const { claim } = outbox([]);
    expect(
      await wakeSubscriptionCoreCodexWaitersAndDeliver(
        { db: {} as db.Database, signalCodexCapacityWorkflow: async () => undefined },
        { accountId: "account-1", reason: "plan_changed" },
      ),
    ).toHaveLength(2);
    expect(wake).toHaveBeenCalledWith({}, { accountId: "account-1", reason: "plan_changed" });
    expect(claim).toHaveBeenCalledTimes(2);
    wake.mockRejectedValue(new Error("database unavailable"));
    expect(
      await wakeSubscriptionCoreCodexWaitersAndDeliver(
        { db: {} as db.Database },
        { accountId: "account-1", reason: "plan_changed" },
      ),
    ).toEqual([]);
  });
});

describe("core Codex blocked-turn evaluation", () => {
  const identity: db.SubscriptionCoreTurnIdentity = {
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sessionOwnerSubjectId: "user:owner",
    sessionOwnerMembershipId: "00000000-0000-4000-8000-000000000001",
    initiatingHumanSubjectId: "user:owner",
    acceptedAuthorityV2: { version: 2, personal: [] },
  };
  const turn = { ...scope, sessionId: "session-1", turnId: "turn-1" };

  test("maps placement to run, wait, revoked authority and a paused cutover", async () => {
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    spy(db, "readSubscriptionCoreCodexTurnModel").mockResolvedValue({
      productModelId: "codex/gpt-5.5",
      reasoningLevel: "high",
    });
    spy(db, "recoverSubscriptionCoreCodexConnectionHealth").mockResolvedValue(0);
    const evaluate = spy(db, "evaluateSubscriptionCoreCodexPlacement");
    const services = { db: {} as db.Database };
    evaluate.mockResolvedValue({ kind: "run", connectionId: "c", switch: "initial" });
    expect(await evaluateCoreCodexBlockedTurn(services, turn)).toEqual({ kind: "run" });
    expect(evaluate).toHaveBeenCalledWith(
      {},
      { identity, productModelId: "codex/gpt-5.5", reasoningLevel: "high" },
    );
    const retryAt = new Date("2030-01-01T00:00:00.000Z");
    evaluate.mockResolvedValue({
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: null,
      healthRetryAt: retryAt,
      explicitConnectionId: "c",
    });
    expect(await evaluateCoreCodexBlockedTurn(services, turn)).toEqual({
      kind: "wait",
      waitReason: "pinned_account_unavailable",
      earliestResetAt: null,
      healthRetryAt: retryAt,
    });
    evaluate.mockResolvedValue({ kind: "not_visible" });
    expect(await evaluateCoreCodexBlockedTurn(services, turn)).toEqual({ kind: "revoked" });
    evaluate.mockResolvedValue({ kind: "cutover_not_enabled" });
    expect(await evaluateCoreCodexBlockedTurn(services, turn)).toEqual({ kind: "paused" });
  });

  test("a turn whose accepted identity is gone is revoked without placement", async () => {
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(null);
    const evaluate = spy(db, "evaluateSubscriptionCoreCodexPlacement");
    expect(await evaluateCoreCodexBlockedTurn({ db: {} as db.Database }, turn)).toEqual({
      kind: "revoked",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  test("a recovered quarantine wakes the account's other waiters", async () => {
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    spy(db, "readSubscriptionCoreCodexTurnModel").mockResolvedValue({
      productModelId: "codex/gpt-5.5",
      reasoningLevel: "medium",
    });
    spy(db, "recoverSubscriptionCoreCodexConnectionHealth").mockResolvedValue(1);
    const wake = spy(db, "wakeSubscriptionCoreCodexCapacityWaiters").mockResolvedValue([]);
    spy(db, "evaluateSubscriptionCoreCodexPlacement").mockResolvedValue({
      kind: "run",
      connectionId: "c",
      switch: "initial",
    });
    await evaluateCoreCodexBlockedTurn({ db: {} as db.Database }, turn);
    expect(wake).toHaveBeenCalledWith(
      {},
      { accountId: "account-1", reason: "connection_health_recovered" },
    );
  });
});

describe("capacity activities accept both waiter shapes", () => {
  function activities() {
    return createCodexCapacityActivities(
      async () =>
        ({
          db: {},
          bus: { publish: async () => undefined },
          settings: {},
          signalCodexCapacityWorkflow: async () => undefined,
          wakeSessionWorkflow: async () => undefined,
        }) as never,
    );
  }

  test("the peek activity returns a core waiter first, in the legacy Codex reference shape", async () => {
    spy(db, "getSubscriptionCoreCodexCapacityWaitForSession").mockResolvedValue(waiter);
    const legacy = spy(db, "getCodexCapacityWaitForSession");
    expect(
      await activities().getCodexCapacityWait({
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toEqual({
      waiterId: "waiter-1",
      generation: 2,
      // An unobserved wake revision becomes an immediate check.
      nextCheckAt: new Date(0).toISOString(),
      wakeRevision: 5,
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  test("a core waiter left behind by a Steer or Cancel becomes an immediate check", async () => {
    spy(db, "getSubscriptionCoreCodexCapacityWaitForSession").mockResolvedValue({
      ...waiter,
      observedWakeRevision: waiter.wakeRevision,
      blockedTurnLive: false,
    });
    expect(
      await activities().getCodexCapacityWait({
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({ waiterId: "waiter-1", nextCheckAt: new Date(0).toISOString() });
  });

  test.each(["xai", "claude"] as const)(
    "without a core waiter the %s peek remains unchanged",
    async (provider) => {
      spy(db, "getSubscriptionCoreCodexCapacityWaitForSession").mockResolvedValue(null);
      const legacy = spy(db, "getCodexCapacityWaitForSession");
      const nextCheckAt = new Date("2030-01-01T00:00:00.000Z");
      const row = {
        id: "provider-waiter",
        generation: 7,
        wakeRevision: 2,
        observedWakeRevision: 2,
        nextCheckAt,
      };
      spy(db, "getXaiCapacityWaitForSession").mockResolvedValue(
        provider === "xai" ? (row as never) : null,
      );
      spy(db, "getClaudeCapacityWaitForSession").mockResolvedValue(
        provider === "claude" ? (row as never) : null,
      );
      expect(
        await activities().getCodexCapacityWait({
          workspaceId: "workspace-1",
          sessionId: "session-1",
        }),
      ).toEqual({
        provider,
        waiterId: row.id,
        generation: 7,
        nextCheckAt: nextCheckAt.toISOString(),
        wakeRevision: 2,
      });
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  test("reconcile resolves a recorded waiter id against the core waiter first", async () => {
    spy(db, "getSubscriptionCoreCodexCapacityWaitById").mockResolvedValue(waiter);
    outbox([]);
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(null);
    const reconcile = spy(db, "reconcileSubscriptionCoreCodexCapacityWait").mockResolvedValue({
      action: "superseded",
      events: [],
    });
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const legacy = spy(db, "getCodexCapacityWaitForSession");
    expect(
      await activities().reconcileCodexCapacityWait({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        waiterId: "waiter-1",
        generation: 2,
        cause: "signal",
      }),
    ).toEqual({ action: "superseded" });
    expect(reconcile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        waiterId: "waiter-1",
        generation: 2,
        evaluatedWakeRevision: 5,
        evaluation: { kind: "revoked" },
      }),
    );
    expect(legacy).not.toHaveBeenCalled();
  });

  test("a left-behind core waiter is superseded without placement", async () => {
    spy(db, "getSubscriptionCoreCodexCapacityWaitById").mockResolvedValue({
      ...waiter,
      blockedTurnLive: false,
    });
    outbox([]);
    const identityRead = spy(db, "readSubscriptionCoreTurnIdentity");
    const reconcile = spy(db, "reconcileSubscriptionCoreCodexCapacityWait").mockResolvedValue({
      action: "superseded",
      events: [],
    });
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    expect(
      await reconcileCoreCodexCapacityWait(
        { db: {} as db.Database, bus: { publish: async () => undefined } as never },
        { ...scope, sessionId: "session-1", waiterId: "waiter-1", generation: 2 },
      ),
    ).toEqual({ action: "superseded" });
    expect(identityRead).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ evaluation: { kind: "paused" } }),
    );
  });

  test("a reconcile repairs a typed wake a crash left pending before it evaluates", async () => {
    spy(db, "getSubscriptionCoreCodexCapacityWaitById").mockResolvedValue(waiter);
    const { claim, mark } = outbox([delivery({ sessionId: "session-2", waiterId: "waiter-2" })]);
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(null);
    spy(db, "reconcileSubscriptionCoreCodexCapacityWait").mockResolvedValue({
      action: "superseded",
      events: [],
    });
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const signal = mock(async () => undefined);
    expect(
      await reconcileCoreCodexCapacityWait(
        {
          db: {} as db.Database,
          bus: { publish: async () => undefined } as never,
          signalCodexCapacityWorkflow: signal,
        },
        { ...scope, sessionId: "session-1", waiterId: "waiter-1", generation: 2 },
      ),
    ).toEqual({ action: "superseded" });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-2", workflowId: "session-session-2" }),
    );
    expect(mark).toHaveBeenCalledTimes(1);
  });

  test("an older generation of a core waiter is stale and evaluates nothing", async () => {
    spy(db, "getSubscriptionCoreCodexCapacityWaitById").mockResolvedValue(waiter);
    outbox([]);
    const evaluate = spy(db, "readSubscriptionCoreTurnIdentity");
    expect(
      await reconcileCoreCodexCapacityWait(
        { db: {} as db.Database, bus: { publish: async () => undefined } as never },
        { ...scope, sessionId: "session-1", waiterId: "waiter-1", generation: 1 },
      ),
    ).toEqual({ action: "stale" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  test("a historical Codex waiter missing from core is stale without a legacy read", async () => {
    spy(db, "getSubscriptionCoreCodexCapacityWaitById").mockResolvedValue(null);
    const legacyRead = spy(db, "getCodexCapacityWaitForSession").mockResolvedValue(null);
    expect(
      await activities().reconcileCodexCapacityWait({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        waiterId: "legacy-waiter",
        generation: 7,
        cause: "timer",
      }),
    ).toEqual({ action: "stale" });
    expect(legacyRead).not.toHaveBeenCalled();
  });

  test("SuperGrok and Claude waits never consult the core", async () => {
    const core = spy(db, "getSubscriptionCoreCodexCapacityWaitById");
    spy(db, "getXaiCapacityWaitForSession").mockResolvedValue(null);
    expect(
      await activities().reconcileCodexCapacityWait({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        waiterId: "xai-waiter",
        generation: 1,
        cause: "timer",
        provider: "xai",
      }),
    ).toEqual({ action: "stale" });
    expect(core).not.toHaveBeenCalled();
  });
});
