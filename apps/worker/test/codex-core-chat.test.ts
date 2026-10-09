import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import { CODEX_TRANSPORT_ERROR_HEADER, CodexReloginRequired } from "@opengeni/codex";
import * as parentWake from "../src/activities/parent-wake";
import {
  selectCodexTurnCapacity,
  type CapacityPhaseDeps,
} from "../src/activities/agent-turn/codex-capacity";
import {
  assertTurnModelConnection,
  buildCoreCodexRequestTokenResolver,
} from "../src/activities/agent-turn/codex-core-capacity";
import {
  claimCodexActiveFromCutover,
  claimMayResolveLegacyCodexApps,
  readClaimCodexCutoverState,
  readSubscriptionLeaseBusyChain,
} from "../src/activities/agent-turn/codex-core-claim";
import {
  SubscriptionCoreCodexTurnError,
  subscriptionCoreCapacityFailure,
  subscriptionCoreLeaseBusyChain,
  subscriptionCoreLeaseBusyDelayMs,
  subscriptionCoreLeaseBusyFailure,
  SUBSCRIPTION_CORE_LEASE_BUSY_JITTER_MS,
  SUBSCRIPTION_CORE_LEASE_BUSY_MAX_MS,
} from "../src/activities/agent-turn/codex-core-errors";
import {
  codexRefusalQuotaObservation,
  codexUsageHeadersQuotaObservation,
  coreCodexModelCallCompletedAt,
  finalizeCoreCodexUsage,
  observeCodexResponseCompletion,
  recordCoreCodexRefusal,
} from "../src/activities/agent-turn/codex-core-settlement";
import {
  CodexCredentialLeaseLostError,
  createTurnCredentialLeases,
  type TurnCredentialLeaseDeps,
} from "../src/activities/agent-turn/credential-leases";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import type { CodexSubscriptionCoreTurn } from "../src/activities/agent-turn/turn-context";

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

const quietObservability = new Proxy(
  {},
  { get: () => () => undefined },
) as unknown as CapacityPhaseDeps["observability"];

function leases() {
  const deps: TurnCredentialLeaseDeps = {
    db: {} as TurnCredentialLeaseDeps["db"],
    observability: quietObservability as unknown as TurnCredentialLeaseDeps["observability"],
    accountId: "account-1",
    workspaceId: "workspace-1",
    codexWorkspaceKey: "fixture",
    getTurnId: () => "turn-1",
    getSessionId: () => "session-1",
  };
  const created = createTurnCredentialLeases(deps);
  created.codex.holderId = "codex-turn:holder";
  return created;
}

function capacityDeps(
  overrides: { source?: string } = {},
): CapacityPhaseDeps & { acknowledged: () => number } {
  let acknowledged = 0;
  const deps = {
    input: {
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attemptId: "attempt-1",
      workflowId: "session-session-1",
      workflowRunId: "run-1",
    },
    settings: {},
    db: {},
    bus: {},
    observability: quietObservability,
    wakeSessionWorkflow: async () => undefined,
    signalCodexCapacityWorkflow: async () => undefined,
    cancellationSignal: undefined,
    dispatchId: "dispatch-1",
    control: { activityStatus: "running", turnMetricOutcome: null },
    attempt: {
      turnId: "turn-1",
      executionGeneration: 3,
      redispatchesAtDispatch: 0,
      triggerEventId: "trigger-1",
    },
    billingState: { isCodexTurn: true },
    eventing: { publish: async () => [], settle: async () => true },
    providerTurn: {
      effectiveCodexCredentialId: null,
      effectiveCodexCredentialVersion: null,
      codexCredentialFailoverLimit: 1,
      codexPolicySnapshot: null,
      codexSubscriptionCore: null,
    },
    leases: leases(),
    claimedResult: (value: Record<string, unknown>) => ({ ...value, turnId: "turn-1" }),
    acknowledgeLostAttemptOwnership: () => {
      acknowledged += 1;
    },
    acknowledgeRecoveryQuiescence: () => undefined,
    setLastInputTokensFenced: async () => undefined,
    turn: { id: "turn-1", source: overrides.source ?? "user", sandboxBackend: "none" },
    session: {},
    turnExecutionPolicy: {
      productModelId: "codex/gpt-5.5",
      upstreamModelId: "gpt-5.5",
      reasoningEffort: "medium",
      providerId: "codex-subscription",
    },
    trigger: {},
    codexWorkspaceKey: "fixture",
    acknowledged: () => acknowledged,
  };
  return deps as unknown as CapacityPhaseDeps & { acknowledged: () => number };
}

function gate(state: "not_configured" | "disabled" | "enabled") {
  spy(db, "withRlsContext").mockImplementation(
    async (_db: unknown, _context: unknown, callback: (scoped: never) => Promise<unknown>) =>
      await callback({} as never),
  );
  spy(db, "readSubscriptionProviderCutoverState").mockResolvedValue(state);
}

describe("Codex cutover gate dispositions", () => {
  test("no cutover row keeps the legacy selector and never touches the core", async () => {
    gate("not_configured");
    const sentinel = new Error("legacy selector reached");
    const legacy = spy(db, "acquireCodexCredentialLease").mockRejectedValue(sentinel);
    const core = spy(db, "placeSubscriptionCoreCodexTurn");
    await expect(selectCodexTurnCapacity(capacityDeps())).rejects.toBe(sentinel);
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(core).not.toHaveBeenCalled();
  });

  test("a disabled cutover fails closed with typed copy and reads neither selector", async () => {
    gate("disabled");
    const legacy = spy(db, "acquireCodexCredentialLease");
    const core = spy(db, "placeSubscriptionCoreCodexTurn");
    const error = await selectCodexTurnCapacity(capacityDeps()).catch((caught) => caught);
    expect(error).toBeInstanceOf(SubscriptionCoreCodexTurnError);
    expect(error.payload).toMatchObject({
      code: "subscription_core_cutover_disabled",
      retryable: false,
    });
    expect(legacy).not.toHaveBeenCalled();
    expect(core).not.toHaveBeenCalled();
  });

  test("an enabled cutover places, leases and records the selection on the core", async () => {
    gate("enabled");
    const legacy = spy(db, "acquireCodexCredentialLease");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    const place = spy(db, "placeSubscriptionCoreCodexTurn").mockResolvedValue({
      kind: "run",
      connectionId: "connection-core",
      personal: false,
      switch: "initial",
      reusedLease: false,
      explicit: false,
      previousConnectionId: "connection-before",
      rotationMode: "spread",
      refreshGeneration: 4,
      leasedUntil: new Date(Date.now() + 60_000),
      eligibleCount: 2,
      connectedCount: 3,
    });
    const selected = spy(
      db,
      "recordSubscriptionCoreCodexSelectionForTurnAttempt",
    ).mockResolvedValue({
      events: [],
      diagnostics: { transition: "switched", source: "allocator", reason: "switched" },
    });
    const legacySelection = spy(db, "recordSessionCodexSelectionForTurnAttempt");
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const deps = capacityDeps();
    try {
      expect(await selectCodexTurnCapacity(deps)).toEqual({ ok: true });
      expect(place).toHaveBeenCalledWith(deps.db, {
        identity,
        attemptId: "attempt-1",
        executionGeneration: 3,
        holderId: "codex-turn:holder",
        productModelId: "codex/gpt-5.5",
        reasoningLevel: "medium",
        leaseTtlMs: db.CODEX_CREDENTIAL_LEASE_TTL_MS,
      });
      expect(deps.providerTurn.codexSubscriptionCore).toEqual({
        identity,
        connectionId: "connection-core",
        placedRefreshGeneration: 4,
        personal: false,
      });
      expect(deps.providerTurn.effectiveCodexCredentialId).toBe("connection-core");
      expect(deps.leases.codex.subscriptionCoreConnection).toBe("connection-core");
      expect(deps.leases.codex.generation).toBe(3);
      expect(deps.leases.codex.held).toBe(true);
      expect(selected).toHaveBeenCalledWith(deps.db, {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        attemptId: "attempt-1",
        executionGeneration: 3,
        credentialId: "connection-core",
        previousCredentialId: "connection-before",
        strategy: "spread",
        reusedLease: false,
        pinnedCredentialId: null,
        eligibleCount: 2,
        connectedCount: 3,
      });
      expect(legacy).not.toHaveBeenCalled();
      expect(legacySelection).not.toHaveBeenCalled();
    } finally {
      deps.leases.codex.stopHeartbeat();
    }
  });

  test("a core wait fails closed with typed, user-readable copy and no lease", async () => {
    gate("enabled");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    const resetAt = new Date(Date.now() + 3_600_000);
    spy(db, "placeSubscriptionCoreCodexTurn").mockResolvedValue({
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: resetAt,
      explicitConnectionId: "connection-pinned",
    });
    const deps = capacityDeps();
    const error = await selectCodexTurnCapacity(deps).catch((caught) => caught);
    expect(error).toBeInstanceOf(SubscriptionCoreCodexTurnError);
    expect(error.payload).toMatchObject({
      code: "subscription_capacity_unavailable",
      retryable: false,
      waitReason: "pinned_account_unavailable",
      resetsAt: resetAt.toISOString(),
    });
    expect(agentRunFailurePayload(error)).toEqual(error.payload);
    expect(deps.leases.codex.held).toBe(false);
    expect(deps.providerTurn.codexSubscriptionCore).toBeNull();
  });

  test("an older attempt's live lease is a retryable typed failure", async () => {
    gate("enabled");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    spy(db, "placeSubscriptionCoreCodexTurn").mockResolvedValue({
      kind: "lease_busy",
      leasedUntil: null,
    });
    const error = await selectCodexTurnCapacity(capacityDeps()).catch((caught) => caught);
    expect(error.payload).toMatchObject({ code: "subscription_lease_busy", retryable: true });
  });

  test("a fenced attempt exits cancelled and acknowledges lost ownership", async () => {
    gate("enabled");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    spy(db, "placeSubscriptionCoreCodexTurn").mockResolvedValue({ kind: "attempt_fenced" });
    const deps = capacityDeps();
    expect(await selectCodexTurnCapacity(deps)).toEqual({
      exit: { status: "cancelled", turnId: "turn-1" },
    });
    expect(deps.acknowledged()).toBe(1);
  });

  test("a cutover switched off between the gate and placement fails closed", async () => {
    gate("enabled");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    spy(db, "placeSubscriptionCoreCodexTurn").mockResolvedValue({ kind: "cutover_not_enabled" });
    const error = await selectCodexTurnCapacity(capacityDeps()).catch((caught) => caught);
    expect(error.payload).toMatchObject({ code: "subscription_core_cutover_disabled" });
  });

  test("a compaction turn fails closed instead of reaching a legacy consumer", async () => {
    gate("enabled");
    const place = spy(db, "placeSubscriptionCoreCodexTurn");
    const legacy = spy(db, "acquireCodexCredentialLease");
    const error = await selectCodexTurnCapacity(capacityDeps({ source: "compaction" })).catch(
      (caught) => caught,
    );
    expect(error.payload).toMatchObject({ code: "subscription_core_unsupported" });
    expect(place).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("core Codex credential materialization in the worker", () => {
  const core: CodexSubscriptionCoreTurn = {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 1,
    personal: false,
  };

  function heldLease() {
    const held = leases();
    Object.assign(held.codex, {
      held: true,
      generation: 3,
      confirmedUntilMs: performance.now() + 60_000,
    });
    held.codex.useSubscriptionCoreLease("connection-core", db.subscriptionCoreTurnActor(identity));
    return held;
  }

  test("uses the exact turn and lease, and a lost core lease stops dispatch", async () => {
    const held = heldLease();
    const getToken = mock(async () => {
      throw new db.SubscriptionCoreCodexLeaseLostError();
    });
    const build = spy(db, "buildSubscriptionCoreCodexTokenResolver").mockReturnValue({
      getToken,
      refresh: getToken,
    });
    const resolver = buildCoreCodexRequestTokenResolver(
      {} as db.Database,
      {} as never,
      core,
      held.codex,
    );
    expect(build).toHaveBeenCalledWith({}, {}, identity, {
      connectionId: "connection-core",
      holderId: "codex-turn:holder",
      generation: 3,
    });
    await expect(resolver.getToken()).rejects.toBeInstanceOf(CodexCredentialLeaseLostError);
    expect(held.codex.lost).toBe(true);
    // Once lost, no further credential read is attempted.
    await expect(resolver.refresh()).rejects.toBeInstanceOf(CodexCredentialLeaseLostError);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  test("refuses to materialize for a lease that does not hold the placed connection", () => {
    const held = heldLease();
    held.codex.useLegacyCodexLease();
    expect(() =>
      buildCoreCodexRequestTokenResolver({} as db.Database, {} as never, core, held.codex),
    ).toThrow("Core Codex lease does not hold the placed connection");
  });

  test("routes lease renewal, dispatch fencing and release under the core turn actor", async () => {
    const held = heldLease();
    const actors: Array<unknown> = [];
    spy(db, "withSessionRlsActorContext").mockImplementation(
      async (actor: unknown, callback: () => Promise<unknown>) => {
        actors.push(actor);
        return await callback();
      },
    );
    spy(db, "withRlsContext").mockImplementation(
      async (_db: unknown, _context: unknown, callback: (scoped: never) => Promise<unknown>) =>
        await callback({} as never),
    );
    spy(db, "assertSubscriptionTurnLeaseCurrent").mockResolvedValue(true);
    const release = spy(db, "releaseSubscriptionTurnLease").mockResolvedValue(true);
    const legacyRelease = spy(db, "releaseCodexCredentialLease");
    await held.codex.assertCurrentForDispatch();
    expect(await held.codex.releaseCurrent()).toBe(true);
    expect(release).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ connectionId: "connection-core", generation: 3 }),
    );
    expect(legacyRelease).not.toHaveBeenCalled();
    expect(actors).toEqual([
      { subjectId: "service:subscription-core", initiatingHumanSubjectId: "user:owner" },
      { subjectId: "service:subscription-core", initiatingHumanSubjectId: "user:owner" },
    ]);
  });
});

describe("core Codex usage, quota and refusal bookkeeping", () => {
  const core: CodexSubscriptionCoreTurn = {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 5,
    personal: false,
  };
  const lease = { holderId: "codex-turn:holder", generation: 3 };

  test("usage headers become a fenced shared quota observation", () => {
    const checkedAt = new Date("2026-10-08T12:00:00Z");
    const reset = new Date("2026-10-08T15:00:00Z");
    expect(
      codexUsageHeadersQuotaObservation(
        {
          primaryUsedPercent: 100,
          primaryResetAt: reset,
          secondaryUsedPercent: 91,
          secondaryResetAt: null,
          checkedAt,
        },
        6,
      ),
    ).toEqual({
      windows: [
        { id: "primary", usedPercent: 100, resetsAt: reset.getTime(), status: "exhausted" },
        { id: "secondary", usedPercent: 91, resetsAt: null, status: "warning" },
      ],
      modelCooldowns: {},
      exhaustedUntil: null,
      exhaustedKind: null,
      revision: 0,
      observedAt: checkedAt.getTime(),
      observedRefreshGeneration: 6,
      source: "response_headers",
    });
  });

  test("quota and rate-limit refusals carry their reset; auth refusals do not", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(
      codexRefusalQuotaObservation({ kind: "quota", cooldownSeconds: 600 }, 5, now),
    ).toMatchObject({
      exhaustedUntil: now.getTime() + 600_000,
      exhaustedKind: "quota",
      observedRefreshGeneration: 5,
      source: "refusal",
    });
    expect(
      codexRefusalQuotaObservation({ kind: "rate_limit", cooldownSeconds: 30 }, 5, now),
    ).toMatchObject({ exhaustedUntil: now.getTime() + 30_000, exhaustedKind: "rate_limit" });
    expect(
      codexRefusalQuotaObservation({ kind: "auth", cooldownSeconds: null }, 5, now),
    ).toBeNull();
  });

  test("a refusal is recorded against the leased core connection only", async () => {
    const failure = spy(db, "recordSubscriptionCoreCodexTurnFailure").mockResolvedValue(true);
    const quota = spy(db, "recordSubscriptionCoreCodexQuotaObservation").mockResolvedValue(true);
    const legacy = spy(db, "quarantineCodexCredentialForLease");
    await recordCoreCodexRefusal({
      db: {} as db.Database,
      core,
      lease,
      failure: { kind: "quota", cooldownSeconds: 60 },
      credentialVersion: 7,
    });
    const ref = { connectionId: "connection-core", holderId: "codex-turn:holder", generation: 3 };
    expect(failure).toHaveBeenCalledWith({}, identity, ref, {
      kind: "quota",
      evidence: { refreshGeneration: 7, cooldownSeconds: 60 },
    });
    expect(quota).toHaveBeenCalledWith(
      {},
      identity,
      ref,
      expect.objectContaining({ exhaustedKind: "quota", observedRefreshGeneration: 7 }),
    );
    expect(legacy).not.toHaveBeenCalled();
  });

  test("finalization records usage and the model-call clock before release", async () => {
    const quota = spy(db, "recordSubscriptionCoreCodexQuotaObservation").mockResolvedValue(true);
    const touch = spy(db, "touchSubscriptionCoreCodexBinding").mockResolvedValue(true);
    const legacy = spy(db, "recordCodexAccountUsageForFinalization");
    const completed = new Date();
    await finalizeCoreCodexUsage({
      db: {} as db.Database,
      core,
      lease,
      usage: {
        primaryUsedPercent: 10,
        primaryResetAt: null,
        secondaryUsedPercent: 5,
        secondaryResetAt: null,
        checkedAt: completed,
      },
      credentialVersion: 5,
      modelCallCompletedAt: completed,
    });
    expect(quota).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith(
      {},
      identity,
      { connectionId: "connection-core", holderId: "codex-turn:holder", generation: 3 },
      completed,
    );
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("core Codex failure settlement", () => {
  function failureDeps(error: unknown, core: CodexSubscriptionCoreTurn | null) {
    const settle = mock(async (_input: unknown) => true);
    return {
      settle,
      deps: {
        error,
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
        observability: {
          incrementCounter: () => undefined,
          observeHistogram: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          info: () => undefined,
        },
        wakeSessionWorkflow: async () => undefined,
        cancellationSignal: undefined,
        sandboxRotationController: new AbortController(),
        noteCancellationRequested: () => undefined,
        codexWorkspaceKey: "workspace-key",
        control: {
          cancellationRequestedAt: null,
          activityStatus: "unknown",
          turnMetricOutcome: null,
          activityError: null,
        },
        attempt: {
          turnId: "turn-1",
          dispatchId: "dispatch-1",
          triggerEventId: "trigger-1",
          executionGeneration: 3,
          providerRecoveryCount: 0,
          modelRequestStarted: true,
          redispatchesAtDispatch: 0,
          triggerType: "user",
        },
        billingState: { isCodexTurn: true },
        eventing: { publish: async () => [], turnStartedPublished: true, settle },
        providerTurn: {
          effectiveCodexCredentialId: core?.connectionId ?? null,
          effectiveCodexCredentialVersion: 5,
          codexCredentialFailoverLimit: 1,
          codexProductModelId: "codex/gpt-5.5",
          codexPolicySnapshot: null,
          codexSubscriptionCore: core,
          latestCodexUsage: null,
        },
        leases: {
          codex: { lost: false, held: true, holderId: "codex-turn:holder", generation: 3 },
          xai: { lost: false },
          claude: { lost: false },
        },
        historySink: { reconcileConversationTruth: async () => undefined },
        claimedResult: (value: Record<string, unknown>) => ({ ...value, turnId: "turn-1" }),
        flushRuntimeBatcher: async () => undefined,
        acknowledgeLostAttemptOwnership: () => undefined,
        acknowledgeRecoveryQuiescence: () => undefined,
      },
    };
  }
  const core: CodexSubscriptionCoreTurn = {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 5,
    personal: false,
  };

  test("a placement outcome fails the turn with typed copy and idles the session", async () => {
    const error = subscriptionCoreCapacityFailure("no_eligible_capacity", null);
    const { deps, settle } = failureDeps(error, null);
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
    expect(settle).toHaveBeenCalledWith({
      events: [
        {
          type: "turn.failed",
          payload: { ...error.payload, recovery: "user_message" },
        },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
      turnStatus: "failed",
      sessionStatus: "idle",
      activeTurnId: null,
    });
  });

  test("a lost core lease recovers the same turn without the legacy Codex settlement", async () => {
    const recovery = spy(db, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const legacy = spy(db, "settleCodexCredentialLeaseLoss");
    const { deps } = failureDeps(new db.SubscriptionCoreCodexLeaseLostError(), core);
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(recovery).toHaveBeenCalledWith(
      {},
      "workspace-1",
      expect.objectContaining({
        turnId: "turn-1",
        reason: "codex_lease_lost",
        detail: { provider: "codex-subscription" },
      }),
    );
    expect(legacy).not.toHaveBeenCalled();
  });

  test("a usage cap records against the core connection and never walks the legacy pool", async () => {
    const quota = spy(db, "recordSubscriptionCoreCodexQuotaObservation").mockResolvedValue(true);
    const failure = spy(db, "recordSubscriptionCoreCodexTurnFailure").mockResolvedValue(true);
    const legacyStatuses = spy(db, "listCodexAccountStatuses");
    const legacyQuarantine = spy(db, "quarantineCodexCredentialForLease");
    const legacyFailover = spy(db, "settleCodexCredentialFailover");
    const cap = Object.assign(new Error("429 You have hit your usage limit"), {
      status: 429,
      type: "usage_limit_reached",
      error: { type: "usage_limit_reached", resets_in_seconds: 7200 },
      headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
    });
    const { deps, settle } = failureDeps(cap, core);
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
    expect(quota).toHaveBeenCalledWith(
      {},
      identity,
      { connectionId: "connection-core", holderId: "codex-turn:holder", generation: 3 },
      expect.objectContaining({ exhaustedKind: "quota", observedRefreshGeneration: 5 }),
    );
    expect(failure).toHaveBeenCalledTimes(1);
    expect(legacyStatuses).not.toHaveBeenCalled();
    expect(legacyQuarantine).not.toHaveBeenCalled();
    expect(legacyFailover).not.toHaveBeenCalled();
    const settled = settle.mock.calls[0]![0] as { events: Array<{ payload: { code?: string } }> };
    expect(settled.events[0]!.payload.code).toBe("codex_usage_limit_reached");
  });

  test("an older attempt's lease retries at its expiry without spending the provider budget", async () => {
    const recovery = spy(db, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const leasedUntil = new Date(Date.now() + 90_000);
    const { deps } = failureDeps(subscriptionCoreLeaseBusyFailure(leasedUntil), null);
    // Already deep into an unrelated provider recovery budget.
    Object.assign(deps.attempt, { providerRecoveryCount: 4 });
    const result = (await settleTurnFailure(deps as never)) as {
      status: string;
      continueDelayMs: number;
    };
    expect(result.status).toBe("recovering");
    expect(result.continueDelayMs).toBeGreaterThanOrEqual(85_000);
    expect(result.continueDelayMs).toBeLessThanOrEqual(
      90_000 + SUBSCRIPTION_CORE_LEASE_BUSY_JITTER_MS,
    );
    const request = recovery.mock.calls[0]![2] as Record<string, unknown>;
    expect(request).toMatchObject({ turnId: "turn-1", reason: "subscription_lease_busy" });
    expect(request.providerRecoveryCount).toBeUndefined();
    expect(request.detail).toMatchObject({ code: "subscription_lease_busy", retryable: true });
  });

  test.each([
    [
      "a revoked sign-in",
      () => new Error("wrapped", { cause: new CodexReloginRequired("Codex sign-in was revoked") }),
      "sign_in",
    ],
    [
      "a 403 that survived refresh",
      () =>
        Object.assign(new Error("403 forbidden"), {
          status: 403,
          headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
        }),
      "forbidden",
    ],
    [
      "a plan-entitlement refusal",
      () =>
        Object.assign(new Error("400 model not in plan"), {
          status: 400,
          code: "model_not_in_plan",
          headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
        }),
      "entitlement",
    ],
  ] as const)(
    "%s on a core turn fails with typed copy, idles the session and wakes a parent",
    async (_label, makeError, refusal) => {
      spy(db, "recordSubscriptionCoreCodexQuotaObservation").mockResolvedValue(true);
      const receipt = spy(db, "recordSubscriptionCoreCodexTurnFailure").mockResolvedValue(true);
      const parent = spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
        undefined as never,
      );
      const legacyRecheck = spy(db, "recheckCodexCredentialPlan");
      const { deps, settle } = failureDeps(makeError(), core);
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
      const settled = settle.mock.calls[0]![0] as {
        events: Array<{ type: string; payload: Record<string, unknown> }>;
        sessionStatus: string;
      };
      expect(settled.sessionStatus).toBe("idle");
      expect(settled.events[0]).toMatchObject({
        type: "turn.failed",
        payload: {
          code: "subscription_account_refused",
          refusal,
          retryable: false,
          recovery: "user_message",
        },
      });
      expect(receipt).toHaveBeenCalledTimes(1);
      expect(parent).toHaveBeenCalledWith(expect.anything(), "workspace-1", "session-1", "turn-1");
      expect(legacyRecheck).not.toHaveBeenCalled();
    },
  );

  test("a capacity outcome also wakes a waiting parent", async () => {
    const parent = spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    const { deps } = failureDeps(
      subscriptionCoreCapacityFailure("no_eligible_capacity", null),
      null,
    );
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
    expect(parent).toHaveBeenCalledTimes(1);
  });

  test("a lease-busy chain records where it started and continues across generations", async () => {
    const recovery = spy(db, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const startedAt = Date.now() - 60_000;
    const { deps } = failureDeps(subscriptionCoreLeaseBusyFailure(null), null);
    // The previous attempt (generation 2) recorded the chain; this is generation 3.
    Object.assign(deps.attempt, { subscriptionLeaseBusy: { startedAt, executionGeneration: 2 } });
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(recovery.mock.calls[0]![2]).toMatchObject({
      subscriptionLeaseBusy: {
        startedAt: new Date(startedAt).toISOString(),
        executionGeneration: 3,
      },
    });
  });

  test("a lease-busy chain past its bound stops with typed copy and an idle session", async () => {
    const recovery = spy(db, "requestSessionTurnRecovery");
    const parent = spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    const { deps, settle } = failureDeps(subscriptionCoreLeaseBusyFailure(null), null);
    Object.assign(deps.attempt, {
      subscriptionLeaseBusy: {
        startedAt: Date.now() - SUBSCRIPTION_CORE_LEASE_BUSY_MAX_MS - 1_000,
        executionGeneration: 2,
      },
    });
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
    expect(recovery).not.toHaveBeenCalled();
    const settled = settle.mock.calls[0]![0] as {
      events: Array<{ payload: Record<string, unknown> }>;
    };
    expect(settled.events[0]!.payload).toMatchObject({
      code: "subscription_lease_busy",
      retryable: false,
      recovery: "user_message",
    });
    expect(parent).toHaveBeenCalledTimes(1);
  });

  test("a database failure while recovering from lease busy keeps the turn recoverable", async () => {
    spy(db, "requestSessionTurnRecovery").mockRejectedValue(
      Object.assign(new Error("database connection reset"), { code: "ECONNRESET" }),
    );
    const { deps } = failureDeps(subscriptionCoreLeaseBusyFailure(null), null);
    await expect(settleTurnFailure(deps as never)).rejects.toMatchObject({
      type: "OpenGeniPostClaimDatabaseRecovery",
      details: [{ turnId: "turn-1", triggerEventId: "trigger-1", executionGeneration: 3 }],
    });
    expect(deps.control.activityStatus).toBe("recovering");
  });

  test("lost access to the leased account is not reported as a revoked sign-in", async () => {
    spy(db, "recordSubscriptionCoreCodexTurnFailure").mockResolvedValue(true);
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps, settle } = failureDeps(
      new Error("request failed", { cause: new db.SubscriptionCoreCodexAccessLostError() }),
      core,
    );
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
    const settled = settle.mock.calls[0]![0] as {
      events: Array<{ payload: Record<string, unknown> }>;
    };
    expect(settled.events[0]!.payload).toMatchObject({
      code: "subscription_account_refused",
      refusal: "access_lost",
    });
    expect(String(settled.events[0]!.payload.error)).not.toContain("sign-in");
  });
});

describe("core Codex lease-busy chain", () => {
  test("continues only from the immediately previous generation", () => {
    const now = 10_000_000;
    expect(subscriptionCoreLeaseBusyChain(undefined, 4, now)).toEqual({
      startedAt: now,
      executionGeneration: 4,
      exhausted: false,
    });
    expect(
      subscriptionCoreLeaseBusyChain({ startedAt: now - 1_000, executionGeneration: 3 }, 4, now),
    ).toEqual({ startedAt: now - 1_000, executionGeneration: 4, exhausted: false });
    // A successful attempt in between breaks the chain.
    expect(
      subscriptionCoreLeaseBusyChain({ startedAt: now - 1_000, executionGeneration: 2 }, 4, now),
    ).toEqual({ startedAt: now, executionGeneration: 4, exhausted: false });
    expect(
      subscriptionCoreLeaseBusyChain(
        { startedAt: now - SUBSCRIPTION_CORE_LEASE_BUSY_MAX_MS, executionGeneration: 3 },
        4,
        now,
      ).exhausted,
    ).toBe(true);
  });

  test("a stored start in the future is clamped to now", () => {
    const now = 10_000_000;
    const future = {
      startedAt: now + 10 * SUBSCRIPTION_CORE_LEASE_BUSY_MAX_MS,
      executionGeneration: 3,
    };
    expect(subscriptionCoreLeaseBusyChain(future, 4, now)).toEqual({
      startedAt: now,
      executionGeneration: 4,
      exhausted: false,
    });
    // The clamped start is what the next attempt stores, so the bound still
    // fires once real time passes it.
    const next = subscriptionCoreLeaseBusyChain(future, 4, now);
    expect(
      subscriptionCoreLeaseBusyChain(
        { startedAt: next.startedAt, executionGeneration: 4 },
        5,
        now + SUBSCRIPTION_CORE_LEASE_BUSY_MAX_MS,
      ).exhausted,
    ).toBe(true);
  });

  test("the claim reads a stored chain and ignores malformed metadata", () => {
    expect(
      readSubscriptionLeaseBusyChain({
        subscriptionLeaseBusy: { startedAt: "2026-10-08T12:00:00.000Z", executionGeneration: 2 },
      }),
    ).toEqual({ startedAt: Date.parse("2026-10-08T12:00:00.000Z"), executionGeneration: 2 });
    expect(
      readSubscriptionLeaseBusyChain({ subscriptionLeaseBusy: { startedAt: "x" } }),
    ).toBeUndefined();
    expect(readSubscriptionLeaseBusyChain(null)).toBeUndefined();
  });
});

describe("run.ts records Codex response completion", () => {
  test("only a completed call is recorded", () => {
    const providerTurn: { lastCodexResponseCompletedAt?: number | null } = {
      lastCodexResponseCompletedAt: null,
    };
    observeCodexResponseCompletion(providerTurn, { phase: "started" }, 1);
    observeCodexResponseCompletion(providerTurn, { phase: "headers" }, 2);
    expect(providerTurn.lastCodexResponseCompletedAt).toBeNull();
    observeCodexResponseCompletion(providerTurn, { phase: "completed" }, 3);
    expect(providerTurn.lastCodexResponseCompletedAt).toBe(3);
  });

  test("the Codex request context's diagnostic handler records it", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/run.ts", import.meta.url),
    ).text();
    // The Codex request context is the first diagnostic handler after it is
    // declared; it must hand every diagnostic event to the recorder.
    const context = source.indexOf("const codexContext: CodexRequestContext | null");
    expect(context).toBeGreaterThan(0);
    const handler = source.indexOf("onModelRequestDiagnostic: (event) => {", context);
    const nextHandler = source.indexOf("onModelRequestDiagnostic", handler + 1);
    const body = source.slice(handler, nextHandler === -1 ? undefined : nextHandler);
    expect(body).toContain("observeCodexResponseCompletion(providerTurn, event)");
  });
});

describe("core Codex lease-busy pacing", () => {
  test("waits for the older lease, adds bounded jitter and never exceeds one TTL", () => {
    const now = 1_000_000;
    expect(subscriptionCoreLeaseBusyDelayMs(new Date(now + 30_000).toISOString(), now, 0)).toBe(
      30_000,
    );
    expect(subscriptionCoreLeaseBusyDelayMs(new Date(now + 30_000).toISOString(), now, 1)).toBe(
      30_000 + SUBSCRIPTION_CORE_LEASE_BUSY_JITTER_MS,
    );
    expect(
      subscriptionCoreLeaseBusyDelayMs(new Date(now + 3_600_000).toISOString(), now, 0, 300_000),
    ).toBe(300_000);
    expect(subscriptionCoreLeaseBusyDelayMs(undefined, now, 0, 300_000)).toBe(300_000);
    expect(subscriptionCoreLeaseBusyDelayMs(new Date(now - 5_000).toISOString(), now, 0)).toBe(
      1_000,
    );
  });
});

describe("claim-time Codex cutover handling", () => {
  test("a cutover row of any state stops legacy Apps resolution for every turn", () => {
    expect(
      claimMayResolveLegacyCodexApps({
        codexConnectedAppsEnabled: true,
        cutover: "not_configured",
      }),
    ).toBe(true);
    for (const cutover of ["enabled", "disabled"] as const) {
      expect(claimMayResolveLegacyCodexApps({ codexConnectedAppsEnabled: true, cutover })).toBe(
        false,
      );
    }
    expect(
      claimMayResolveLegacyCodexApps({
        codexConnectedAppsEnabled: false,
        cutover: "not_configured",
      }),
    ).toBe(false);
  });

  test("the legacy active-credential flag is read only without a cutover row", () => {
    expect(claimCodexActiveFromCutover("not_configured")).toBe("read_legacy");
    expect(claimCodexActiveFromCutover("enabled")).toBe(true);
    expect(claimCodexActiveFromCutover("disabled")).toBe(false);
  });

  test("the cutover read retries a thrown read with the legacy bound, then surfaces it", async () => {
    let calls = 0;
    spy(db, "withRlsContext").mockImplementation(
      async (_db: unknown, _context: unknown, callback: (scoped: never) => Promise<unknown>) =>
        await callback({} as never),
    );
    spy(db, "readSubscriptionProviderCutoverState").mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient read");
      return "enabled";
    });
    expect(
      await readClaimCodexCutoverState(
        {} as db.Database,
        { accountId: "account-1", workspaceId: "workspace-1" },
        { retryMs: 1 },
      ),
    ).toBe("enabled");
    expect(calls).toBe(3);

    calls = 0;
    const persistent = new Error("persistent read outage");
    spy(db, "readSubscriptionProviderCutoverState").mockImplementation(async () => {
      calls += 1;
      throw persistent;
    });
    await expect(
      readClaimCodexCutoverState(
        {} as db.Database,
        { accountId: "account-1", workspaceId: "workspace-1" },
        { retryMs: 1 },
      ),
    ).rejects.toBe(persistent);
    expect(calls).toBe(3);
  });
});

describe("run and finalization wiring for core turns", () => {
  const core: CodexSubscriptionCoreTurn = {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 1,
    personal: false,
  };
  const check = {
    workspaceId: "workspace-1",
    subjectId: "user:owner",
    modelId: "codex/gpt-5.5",
    codexCredentialId: "connection-core",
  };

  test("the legacy model-connection check never sees a core connection id", async () => {
    const legacy = spy(db, "assertModelConnectionAllowsTurn").mockResolvedValue(undefined);
    await assertTurnModelConnection({} as db.Database, { codexSubscriptionCore: core }, check);
    expect(legacy).not.toHaveBeenCalled();
    await assertTurnModelConnection({} as db.Database, { codexSubscriptionCore: null }, check);
    expect(legacy).toHaveBeenCalledWith({}, check);
  });

  test("only a call that produced a response advances the binding clock", () => {
    expect(coreCodexModelCallCompletedAt({ lastCodexResponseCompletedAt: null })).toBeNull();
    expect(coreCodexModelCallCompletedAt({})).toBeNull();
    expect(coreCodexModelCallCompletedAt({ lastCodexResponseCompletedAt: 1_234 })).toEqual(
      new Date(1_234),
    );
  });

  test("finalization without a responded call records usage but leaves the binding clock", async () => {
    const quota = spy(db, "recordSubscriptionCoreCodexQuotaObservation").mockResolvedValue(true);
    const touch = spy(db, "touchSubscriptionCoreCodexBinding").mockResolvedValue(true);
    await finalizeCoreCodexUsage({
      db: {} as db.Database,
      core,
      lease: { holderId: "codex-turn:holder", generation: 3 },
      usage: {
        primaryUsedPercent: 100,
        primaryResetAt: null,
        secondaryUsedPercent: 1,
        secondaryResetAt: null,
        checkedAt: new Date(),
      },
      credentialVersion: 1,
      modelCallCompletedAt: coreCodexModelCallCompletedAt({ lastCodexResponseCompletedAt: null }),
    });
    expect(quota).toHaveBeenCalledTimes(1);
    expect(touch).not.toHaveBeenCalled();
  });
});
