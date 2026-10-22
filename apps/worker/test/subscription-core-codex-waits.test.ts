import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import { createCodexCapacityActivities } from "../src/activities/codex-capacity";
import {
  CODEX_CORE_WAIT_BINDING,
  CORE_CODEX_WAKE_DELIVERY_MAX_ATTEMPTS,
  coreCodexWakeRetryDelayMs,
  deliverSubscriptionCoreCodexWakes,
  evaluateCoreCodexBlockedTurn,
  reconcileCoreCodexCapacityWait,
  wakeSubscriptionCoreCodexWaitersAndDeliver,
} from "../src/activities/subscription-core-codex-waits";
import { XAI_CORE_WAIT_BINDING } from "../src/activities/subscription-core-xai-waits";
import * as xaiQuota from "../src/activities/subscription-core-xai-quota";
import * as codexQuota from "../src/activities/subscription-core-codex-quota";

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
  provider: "codex",
  candidateProviders: null,
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
    spy(db, "getSubscriptionCoreCapacityWaitForSession").mockResolvedValue(waiter);
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
    spy(db, "getSubscriptionCoreCapacityWaitForSession").mockResolvedValue({
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

  test("a SuperGrok core waiter is peeked before the legacy waiters and names its provider", async () => {
    spy(db, "getSubscriptionCoreCapacityWaitForSession").mockResolvedValue({
      ...waiter,
      provider: "xai",
    });

    expect(
      await activities().getCodexCapacityWait({
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toEqual({
      waiterId: "waiter-1",
      generation: 2,
      nextCheckAt: new Date(0).toISOString(),
      wakeRevision: 5,
      provider: "xai",
    });
  });

  test("a Claude core waiter is peeked before the legacy waiters and names its provider", async () => {
    spy(db, "getSubscriptionCoreCapacityWaitForSession").mockResolvedValue({
      ...waiter,
      provider: "claude",
    });

    expect(
      await activities().getCodexCapacityWait({
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toEqual({
      waiterId: "waiter-1",
      generation: 2,
      nextCheckAt: new Date(0).toISOString(),
      wakeRevision: 5,
      provider: "claude",
    });
  });

  test("without a core waiter the peek has no legacy fallback", async () => {
    spy(db, "getSubscriptionCoreCapacityWaitForSession").mockResolvedValue(null);
    expect(
      await activities().getCodexCapacityWait({
        workspaceId: "workspace-1",
        sessionId: "session-1",
      }),
    ).toBeNull();
  });

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

  test("SuperGrok and Claude waits consult the core by id first; a Codex-only lookup never runs", async () => {
    const core = spy(db, "getSubscriptionCoreCodexCapacityWaitById");
    const anyCore = spy(db, "getSubscriptionCoreCapacityWaitById").mockResolvedValue(null);

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
    expect(anyCore).toHaveBeenCalledTimes(1);
    expect(
      await activities().reconcileCodexCapacityWait({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        waiterId: "claude-waiter",
        generation: 1,
        cause: "timer",
        provider: "claude",
      }),
    ).toEqual({ action: "stale" });
    expect(anyCore).toHaveBeenCalledTimes(2);
    expect(core).not.toHaveBeenCalled();
  });

  const xaiWaiter: db.SubscriptionCoreCodexCapacityWait = { ...waiter, provider: "xai" };
  const xaiReconcile = {
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    waiterId: "waiter-1",
    generation: 2,
    cause: "timer" as const,
    provider: "xai" as const,
  };

  const parkedTurn: db.SubscriptionCoreTurnIdentity = {
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sessionOwnerSubjectId: "user:owner",
    sessionOwnerMembershipId: "00000000-0000-4000-8000-000000000001",
    initiatingHumanSubjectId: "user:owner",
    acceptedAuthorityV2: { version: 2, personal: [] },
  };

  test("a SuperGrok core waiter re-reads billing under the parked turn's identity before its reconcile evaluates, at the woken revision", async () => {
    const read = spy(db, "getSubscriptionCoreCapacityWaitById")
      .mockResolvedValueOnce(xaiWaiter)
      .mockResolvedValueOnce({ ...xaiWaiter, wakeRevision: 6 });
    outbox([]);
    const refresh = spy(xaiQuota, "refreshExhaustedXaiCoreQuota").mockResolvedValue(undefined);
    const identityRead = spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(parkedTurn);
    spy(db, "readSubscriptionCoreTurnModel").mockResolvedValue(null);
    const reconcile = spy(db, "reconcileSubscriptionCoreCapacityWait").mockResolvedValue({
      action: "superseded",
      events: [],
    });
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    expect(await activities().reconcileCodexCapacityWait(xaiReconcile)).toEqual({
      action: "superseded",
    });
    expect(identityRead).toHaveBeenCalledWith(
      {},
      {
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
      },
    );
    expect(refresh).toHaveBeenCalledWith({
      db: {},
      settings: {},
      accountId: "account-1",
      workspaceId: "workspace-1",
      personalTurn: parkedTurn,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        provider: "xai",
        evaluatedWakeRevision: 6,
        evaluation: { kind: "revoked" },
      }),
    );
  });

  test("a SuperGrok waiter gone after the billing re-read is stale; a failed re-read still evaluates", async () => {
    spy(db, "getSubscriptionCoreCapacityWaitById")
      .mockResolvedValueOnce(xaiWaiter)
      .mockResolvedValueOnce(null);
    outbox([]);
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(parkedTurn);
    spy(db, "readSubscriptionCoreTurnModel").mockResolvedValue(null);
    const refresh = spy(xaiQuota, "refreshExhaustedXaiCoreQuota").mockResolvedValue(undefined);
    const reconcile = spy(db, "reconcileSubscriptionCoreCapacityWait");
    expect(await activities().reconcileCodexCapacityWait(xaiReconcile)).toEqual({
      action: "stale",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();

    spy(db, "getSubscriptionCoreCapacityWaitById").mockResolvedValue(xaiWaiter);
    refresh.mockRejectedValue(new Error("billing unavailable"));
    reconcile.mockResolvedValue({ action: "superseded", events: [] });
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    expect(await activities().reconcileCodexCapacityWait(xaiReconcile)).toEqual({
      action: "superseded",
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("a SuperGrok waiter whose turn has no accepted identity re-reads nothing and is revoked", async () => {
    spy(db, "getSubscriptionCoreCapacityWaitById").mockResolvedValue(xaiWaiter);
    outbox([]);
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(null);
    const refresh = spy(xaiQuota, "refreshExhaustedXaiCoreQuota").mockResolvedValue(undefined);
    const reconcile = spy(db, "reconcileSubscriptionCoreCapacityWait").mockResolvedValue({
      action: "superseded",
      events: [],
    });
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    expect(await activities().reconcileCodexCapacityWait(xaiReconcile)).toEqual({
      action: "superseded",
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ evaluation: { kind: "revoked" } }),
    );
  });

  test("a provider whose usage read ends an exhaustion re-reads before reconcile", () => {
    expect(XAI_CORE_WAIT_BINDING.refreshBeforeReconcile).toBeFunction();
    expect(CODEX_CORE_WAIT_BINDING.refreshBeforeReconcile).toBeFunction();
  });

  test("a Codex core waiter re-reads usage under the parked turn's identity before its reconcile evaluates, at the woken revision", async () => {
    const read = spy(db, "getSubscriptionCoreCodexCapacityWaitById")
      .mockResolvedValueOnce(waiter)
      .mockResolvedValueOnce({ ...waiter, wakeRevision: 6 });
    outbox([]);
    const refresh = spy(codexQuota, "refreshExhaustedCodexCoreQuota").mockResolvedValue(undefined);
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(parkedTurn);
    spy(db, "readSubscriptionCoreTurnModel").mockResolvedValue(null);
    const reconcile = spy(db, "reconcileSubscriptionCoreCodexCapacityWait").mockResolvedValue({
      action: "superseded",
      events: [],
    });
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    expect(
      await activities().reconcileCodexCapacityWait({ ...xaiReconcile, provider: "codex" }),
    ).toEqual({ action: "superseded" });
    expect(refresh).toHaveBeenCalledWith({
      db: {},
      settings: {},
      accountId: "account-1",
      workspaceId: "workspace-1",
      personalTurn: parkedTurn,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ evaluatedWakeRevision: 6, evaluation: { kind: "revoked" } }),
    );

    // A failed usage read never blocks the reconcile.
    read.mockResolvedValue(waiter);
    refresh.mockRejectedValue(new Error("usage unavailable"));
    expect(
      await activities().reconcileCodexCapacityWait({ ...xaiReconcile, provider: "codex" }),
    ).toEqual({ action: "superseded" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("a core waiter of another provider never reconciles through the Claude binding", async () => {
    // The exact id names a SuperGrok core waiter: the Claude reference does
    // not adopt it and falls back to the legacy Claude waiter (none here).
    spy(db, "getSubscriptionCoreCapacityWaitById").mockResolvedValue({
      ...waiter,
      provider: "xai",
    });
    const reconcile = spy(db, "reconcileSubscriptionCoreCapacityWait");
    expect(
      await activities().reconcileCodexCapacityWait({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        waiterId: "waiter-1",
        generation: 2,
        cause: "timer",
        provider: "claude",
      }),
    ).toEqual({ action: "stale" });
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("a Claude core waiter found by exact id and generation reconciles on the core, never the legacy waiter", async () => {
    spy(db, "getSubscriptionCoreCapacityWaitById").mockResolvedValue({
      ...waiter,
      provider: "claude",
    });
    outbox([]);
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(null);
    const reconcile = spy(db, "reconcileSubscriptionCoreCapacityWait").mockResolvedValue({
      action: "superseded",
      events: [],
    });
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);

    const codexReconcile = spy(db, "reconcileSubscriptionCoreCodexCapacityWait");
    expect(
      await activities().reconcileCodexCapacityWait({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        waiterId: "waiter-1",
        generation: 2,
        cause: "signal",
        provider: "claude",
      }),
    ).toEqual({ action: "superseded" });
    expect(reconcile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        provider: "claude",
        waiterId: "waiter-1",
        generation: 2,
        evaluatedWakeRevision: 5,
        evaluation: { kind: "revoked" },
      }),
    );

    expect(codexReconcile).not.toHaveBeenCalled();
  });

  test("an older generation of a Claude core waiter is stale and evaluates nothing", async () => {
    spy(db, "getSubscriptionCoreCapacityWaitById").mockResolvedValue({
      ...waiter,
      provider: "claude",
    });
    outbox([]);
    const identityRead = spy(db, "readSubscriptionCoreTurnIdentity");
    const reconcile = spy(db, "reconcileSubscriptionCoreCapacityWait");

    expect(
      await activities().reconcileCodexCapacityWait({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        waiterId: "waiter-1",
        generation: 1,
        cause: "timer",
        provider: "claude",
      }),
    ).toEqual({ action: "stale" });
    expect(identityRead).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test.each(["claude", "xai"] as const)(
    "a missing %s core waiter is stale, never a legacy reconciliation",
    async (provider) => {
      spy(db, "getSubscriptionCoreCapacityWaitById").mockResolvedValue(null);
      const reconcile = spy(db, "reconcileSubscriptionCoreCapacityWait");
      const identity = spy(db, "readSubscriptionCoreTurnIdentity");
      const wake = spy(db, "wakeSubscriptionCoreProviderCapacityWaiters");
      expect(
        await activities().reconcileCodexCapacityWait({
          accountId: "account-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          waiterId: "legacy-waiter",
          generation: 3,
          cause: "timer",
          provider,
        }),
      ).toEqual({ action: "stale" });
      expect(reconcile).not.toHaveBeenCalled();
      expect(identity).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    },
  );
});

describe("core waiter recheck schedule", () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() + ms);

  test("a provider that rechecks before its reset backs off from 60 s to 15 min, capped at the reset", () => {
    const resetAt = at(6 * 3_600_000);
    const schedule = (refreshAttempt: number, earliestResetAt = resetAt) =>
      db.subscriptionCoreCodexNextCheckAt({
        earliestResetAt,
        healthRetryAt: null,
        refreshAttempt,
        now,
        rechecksBeforeReset: true,
      });
    expect(schedule(0)).toEqual({ nextCheckAt: at(60_000), resetKind: "bounded_refresh" });
    expect(schedule(1)).toEqual({ nextCheckAt: at(120_000), resetKind: "bounded_refresh" });
    expect(schedule(9)).toEqual({ nextCheckAt: at(15 * 60_000), resetKind: "bounded_refresh" });
    expect(schedule(9, at(30_000))).toEqual({
      nextCheckAt: at(30_000),
      resetKind: "authoritative",
    });
    // A quarantine that ends sooner than the bounded check moves it earlier.
    expect(
      db.subscriptionCoreCodexNextCheckAt({
        earliestResetAt: resetAt,
        healthRetryAt: at(90_000),
        refreshAttempt: 9,
        now,
        rechecksBeforeReset: true,
      }),
    ).toEqual({ nextCheckAt: at(90_000), resetKind: "bounded_refresh" });
  });

  test("the bare schedule sleeps until its reset; every live provider rechecks before it", () => {
    expect(
      db.subscriptionCoreCodexNextCheckAt({
        earliestResetAt: at(6 * 3_600_000),
        healthRetryAt: null,
        refreshAttempt: 0,
        now,
      }),
    ).toEqual({ nextCheckAt: at(6 * 3_600_000), resetKind: "authoritative" });
    expect(db.subscriptionCoreWaiterRechecksBeforeReset("codex")).toBe(true);
    expect(db.subscriptionCoreWaiterRechecksBeforeReset("xai")).toBe(true);
    expect(db.subscriptionCoreWaiterRechecksBeforeReset("claude")).toBe(true);
  });
});
