import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import { AnthropicRequestError } from "@opengeni/runtime";
import * as parentWake from "../src/activities/parent-wake";
import { classifyClaudeProviderError } from "../src/activities/agent-turn/errors";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import { finalizeCoreClaudeTurn } from "../src/activities/agent-turn/claude-core";
import { SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT } from "../src/activities/agent-turn/subscription-core-failover";
import type { SubscriptionCoreTurn } from "../src/activities/agent-turn/turn-context";

// Claude refusal settlement, finalization and waits on the shared core
// (design 5.3, Claude track C1b). Dormant: these paths run only for a turn
// the core placed, which needs the Claude binding registered (C3).

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

const MODEL = "organization-claude-subscription/claude-sonnet-5";

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

function anthropic(
  status: number | undefined,
  type = "api_error",
  headers: HeadersInit = {},
  subscription = true,
) {
  return new AnthropicRequestError(
    "Synthetic provider failure",
    status,
    "anthropic_http_error",
    { type, message: "Fixture" },
    new Headers(headers),
    { subscription },
  );
}

describe("Claude provider-error classification", () => {
  test("a revoked grant or a 401 after the forced refresh needs a new sign-in", () => {
    expect(
      classifyClaudeProviderError(new db.ClaudeSubscriptionReconnectRequired(), MODEL),
    ).toEqual({ kind: "unauthorized" });
    expect(
      classifyClaudeProviderError(
        new Error("Wrapped", { cause: new db.ClaudeSubscriptionReconnectRequired() }),
        MODEL,
      ),
    ).toEqual({ kind: "unauthorized" });
    expect(classifyClaudeProviderError(anthropic(401, "authentication_error"), MODEL)).toEqual({
      kind: "unauthorized",
    });
  });

  test("429 rests the turn's model, with the provider's retry time when it gave one", () => {
    expect(
      classifyClaudeProviderError(
        new Error("Wrapped", {
          cause: anthropic(429, "rate_limit_error", { "retry-after": "120" }),
        }),
        MODEL,
      ),
    ).toEqual({ kind: "rate_limited", retryAfterMs: 120_000, modelId: MODEL });
    expect(classifyClaudeProviderError(anthropic(429, "rate_limit_error"), MODEL)).toEqual({
      kind: "rate_limited",
      retryAfterMs: null,
      modelId: MODEL,
    });
  });

  test("529 and overloaded_error are overload, never an account refusal", () => {
    expect(classifyClaudeProviderError(anthropic(529, "overloaded_error"), MODEL)).toEqual({
      kind: "overloaded",
    });
    // An overload reported in a stream that began with HTTP 200.
    expect(classifyClaudeProviderError(anthropic(200, "overloaded_error"), MODEL)).toEqual({
      kind: "overloaded",
    });
  });

  test("403 is fatal: it never rotates or quarantines the account", () => {
    expect(classifyClaudeProviderError(anthropic(403, "permission_error"), MODEL)).toEqual({
      kind: "fatal",
    });
  });

  test("other failures, other transports and non-errors are not account refusals", () => {
    for (const status of [400, 404, 408, 500, 503, undefined])
      expect(classifyClaudeProviderError(anthropic(status), MODEL)).toBeNull();
    // An Anthropic API-key request is not the subscription transport.
    expect(
      classifyClaudeProviderError(anthropic(429, "rate_limit_error", {}, false), MODEL),
    ).toBeNull();
    expect(
      classifyClaudeProviderError(
        Object.assign(new Error("Tool rate limited"), { status: 429 }),
        MODEL,
      ),
    ).toBeNull();
    expect(classifyClaudeProviderError("not an error", MODEL)).toBeNull();
  });
});

function core(overrides: Partial<SubscriptionCoreTurn> = {}): SubscriptionCoreTurn {
  return {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 4,
    personal: false,
    productModelId: MODEL,
    ...overrides,
  };
}

function failureDeps(error: unknown, coreTurn: SubscriptionCoreTurn | null) {
  const settle = mock(async (_input: unknown) => true);
  const counters: Array<{ name: string; labels: Record<string, string> }> = [];
  const releaseCurrent = mock(async () => true);
  return {
    settle,
    counters,
    releaseCurrent,
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
        incrementCounter: (metric: { name: string; labels: Record<string, string> }) => {
          counters.push({ name: metric.name, labels: metric.labels });
        },
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
        // A v1 marker the legacy path wrote: never read on the core.
        claudeAuthRecovery: { credentialId: "connection-core", credentialVersion: 4 },
      },
      billingState: { isClaudeTurn: true },
      eventing: { publish: async () => [], turnStartedPublished: true, settle },
      providerTurn: {
        effectiveClaudeCredentialId: "connection-core",
        effectiveClaudeCredentialVersion: null,
        claudeUpstreamModelId: "claude-sonnet-5",
        claudeSubscriptionCore: coreTurn,
        xaiSubscriptionCore: null,
        codexSubscriptionCore: null,
        latestClaudeUsage: new Map(),
      },
      leases: {
        codex: { lost: false },
        xai: { lost: false },
        claude: {
          lost: false,
          held: true,
          holderId: "claude-turn:session-1:turn-1",
          generation: 3,
          stopHeartbeat: () => undefined,
          releaseCurrent,
        },
      },
      historySink: { reconcileConversationTruth: async () => undefined },
      claimedResult: (value: Record<string, unknown>) => ({ ...value, turnId: "turn-1" }),
      flushRuntimeBatcher: async () => undefined,
      acknowledgeLostAttemptOwnership: () => undefined,
      acknowledgeRecoveryQuiescence: () => undefined,
    },
  };
}

/** Scripted Claude core runtime; the binding itself stays unregistered. */
function coreRuntime(options: {
  refusals?: number | null;
  receipt?: boolean;
  disconnected?: boolean;
}) {
  const apply = mock(async (..._args: unknown[]) => ({
    receipt: options.receipt ?? true,
    health: true,
  }));
  const count = mock(async () => (options.refusals === undefined ? 1 : options.refusals));
  const touch = mock(async (..._args: unknown[]) => true);
  const settlementProviders: unknown[] = [];
  spy(db, "subscriptionCoreSettlement").mockImplementation(((provider: unknown) => {
    settlementProviders.push(provider);
    return { applySubscriptionCoreRefusal: apply };
  }) as never);
  spy(db, "subscriptionCoreTurns").mockReturnValue({
    countSubscriptionCoreTurnRefusals: count,
    touchSubscriptionCoreBinding: touch,
  } as never);
  spy(db, "subscriptionCoreRequests").mockReturnValue({
    isSubscriptionCoreSourceDisconnected: async () => options.disconnected ?? false,
  } as never);
  // The legacy Claude settlement (receipts, refresh recovery, rotation and
  // its capacity wait) must never run for a core turn.
  const legacy = [
    spy(db, "armClaudeCapacityWait"),
    spy(db, "reconcileClaudeCapacityWait"),
    spy(db, "loadClaudeAccountCredential"),
    spy(db, "resolveClaudeAccountCredential"),
  ];
  return { apply, count, touch, settlementProviders, legacy };
}

function recoveringRecovery() {
  spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
  return spy(db, "requestSessionTurnRecovery").mockResolvedValue({
    action: "recovering",
    events: [],
  } as never);
}

describe("Claude refusal settlement on the core", () => {
  test("a 429 cools the turn's model on the leased connection and the same turn re-places", async () => {
    const runtime = coreRuntime({ refusals: 1 });
    const recovery = recoveringRecovery();
    const { deps, counters, releaseCurrent, settle } = failureDeps(
      new Error("wrapped", { cause: anthropic(429, "rate_limit_error", { "retry-after": "30" }) }),
      core({ credentialVersion: 6 }),
    );
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });

    expect(runtime.settlementProviders[0]).toBe(db.SUBSCRIPTION_CORE_CLAUDE);
    const [, appliedIdentity, ref, plan, fence] = runtime.apply.mock.calls[0]!;
    expect(appliedIdentity).toEqual(identity);
    expect(ref).toEqual({
      connectionId: "connection-core",
      holderId: "claude-turn:session-1:turn-1",
      generation: 3,
    });
    // A per-model cooldown until the provider's retry time, never the whole
    // connection; fenced on the generation the refused bearer carried.
    expect(plan).toMatchObject({
      kind: "settle",
      receipt: { kind: "rate_limited", evidence: { refreshGeneration: 6 } },
      health: { kind: "model_cooldown", modelId: MODEL },
    });
    expect(fence).toMatchObject({ refreshGeneration: 6 });
    expect(runtime.count).toHaveBeenCalledTimes(1);
    expect(releaseCurrent).toHaveBeenCalledTimes(1);
    expect(recovery).toHaveBeenCalledWith(deps.db, "workspace-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      triggerEventId: "trigger-1",
      attemptId: "attempt-1",
      reason: "claude_credential_failover",
      detail: {
        provider: "claude-subscription",
        credentialId: "connection-core",
        failureKind: "rate_limited",
        failoverCount: 1,
        maxFailovers: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT - 1,
      },
    });
    expect(settle).not.toHaveBeenCalled();
    expect(counters).toContainEqual({
      name: "opengeni_subscription_core_failover_settlements_total",
      labels: { provider: "claude", outcome: "core_failover" },
    });
    for (const legacy of runtime.legacy) expect(legacy).not.toHaveBeenCalled();
  });

  test("a 401 the transport could not renew is a sign-in quarantine and re-places the turn", async () => {
    const runtime = coreRuntime({ refusals: 1 });
    const recovery = recoveringRecovery();
    const { deps } = failureDeps(anthropic(401, "authentication_error"), core());
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    // The transport already ran the turn's one forced refresh: no second
    // refresh plan, and the v1 `claudeAuthRecovery` marker is not consulted.
    expect(runtime.apply.mock.calls[0]![3]).toMatchObject({
      kind: "settle",
      receipt: { kind: "unauthorized", evidence: { refreshGeneration: 4 } },
      health: { kind: "quarantine", reason: "sign_in" },
    });
    expect(recovery.mock.calls[0]![2]).toMatchObject({
      reason: "claude_credential_failover",
      detail: { failureKind: "unauthorized" },
    });
    for (const legacy of runtime.legacy) expect(legacy).not.toHaveBeenCalled();
  });

  test("a 529 stays in the overload lane: nothing recorded, no account change", async () => {
    const runtime = coreRuntime({ refusals: 1 });
    const recovery = recoveringRecovery();
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps, releaseCurrent } = failureDeps(anthropic(529, "overloaded_error"), core());
    // The generic provider-overload recovery retries the same turn; the
    // binding keeps its connection.
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(recovery.mock.calls[0]![2]).toMatchObject({
      reason: "provider_overloaded",
      detail: { providerCondition: "overloaded", retryable: true },
    });
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.count).not.toHaveBeenCalled();
    expect(releaseCurrent).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: "claude_credential_failover" }),
    );
    for (const legacy of runtime.legacy) expect(legacy).not.toHaveBeenCalled();
  });

  test("a 403 is fatal: nothing recorded, no rotation, no quarantine", async () => {
    const runtime = coreRuntime({ refusals: 1 });
    const recovery = recoveringRecovery();
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps, settle } = failureDeps(anthropic(403, "permission_error"), core());
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.count).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    const settled = settle.mock.calls[0]![0] as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
      turnStatus: string;
    };
    expect(settled.turnStatus).toBe("failed");
    expect(settled.events[0]).toMatchObject({ type: "turn.failed", payload: { retryable: false } });
    for (const legacy of runtime.legacy) expect(legacy).not.toHaveBeenCalled();
  });

  test("the refusal that reaches the shared bound fails the turn with Claude copy", async () => {
    coreRuntime({ refusals: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT });
    const recovery = spy(db, "requestSessionTurnRecovery");
    const parent = spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    const { deps, settle, counters } = failureDeps(anthropic(429, "rate_limit_error"), core());
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
    expect(recovery).not.toHaveBeenCalled();
    const settled = settle.mock.calls[0]![0] as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
      sessionStatus: string;
    };
    expect(settled.sessionStatus).toBe("idle");
    expect(settled.events[0]).toMatchObject({
      type: "turn.failed",
      payload: {
        code: "subscription_failover_exhausted",
        refusals: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT,
        retryable: false,
        recovery: "user_message",
      },
    });
    expect(String(settled.events[0]!.payload.error)).toStartWith("Claude accounts refused");
    expect(counters).toContainEqual({
      name: "opengeni_subscription_core_failover_settlements_total",
      labels: { provider: "claude", outcome: "core_exhausted" },
    });
    expect(parent).toHaveBeenCalledWith(expect.anything(), "workspace-1", "session-1", "turn-1");
  });

  test("an unrecorded sign-in refusal is never replayed and fails with typed Claude copy", async () => {
    const runtime = coreRuntime({ receipt: false });
    const recovery = spy(db, "requestSessionTurnRecovery");
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps, settle } = failureDeps(
      new Error("wrapped", { cause: new db.ClaudeSubscriptionReconnectRequired() }),
      core(),
    );
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
    expect(runtime.count).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    const settled = settle.mock.calls[0]![0] as {
      events: Array<{ payload: Record<string, unknown> }>;
    };
    expect(settled.events[0]!.payload).toMatchObject({
      code: "subscription_account_refused",
      refusal: "sign_in",
      retryable: false,
    });
    expect(String(settled.events[0]!.payload.error)).toContain("Claude");
  });

  test("a graceful disconnect re-places the same turn without a refusal or a count", async () => {
    const runtime = coreRuntime({ disconnected: true });
    const recovery = recoveringRecovery();
    const { deps } = failureDeps(anthropic(401, "authentication_error"), core());
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.count).not.toHaveBeenCalled();
    expect(recovery.mock.calls[0]![2]).toMatchObject({
      reason: "claude_credential_failover",
      detail: { provider: "claude-subscription", failureKind: "source_disconnected" },
    });
  });

  test("an unknown request outcome never records a refusal or re-places", async () => {
    const runtime = coreRuntime({});
    const recovery = spy(db, "requestSessionTurnRecovery");
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const error = new Error("stream broke", {
      cause: db.SUBSCRIPTION_CORE_CLAUDE.errors.requestOutcomeUnknown(),
    });
    const { deps } = failureDeps(error, core());
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.count).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
  });

  test("a lost core lease records nothing and never re-places", async () => {
    const runtime = coreRuntime({});
    const recovery = spy(db, "requestSessionTurnRecovery");
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps } = failureDeps(anthropic(429, "rate_limit_error"), core());
    (deps.leases.claude as { lost: boolean }).lost = true;
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: "claude_credential_failover" }),
    );
  });
});

describe("Claude finalization on the core", () => {
  const lease = { holderId: "claude-turn:session-1:turn-1", generation: 3 } as never;
  const lane = (at: Date | null) =>
    ({ lastResponseReceivedAt: () => at }) as unknown as SubscriptionCoreTurn["requests"];

  test("joined observations that ended an exhaustion wake the account's Claude waiters", async () => {
    const runtime = coreRuntime({});
    const wake = spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockResolvedValue([]);
    const codexWake = spy(db, "wakeSubscriptionCoreCodexCapacityWaiters");
    const late = new Date("2026-10-11T03:00:05.000Z");
    await finalizeCoreClaudeTurn({
      db: {} as db.Database,
      core: core({ requests: lane(late), quota: { settled: async () => true } }),
      lease,
    });
    expect(wake).toHaveBeenCalledWith({}, "claude", {
      accountId: "account-1",
      reason: "quota_observed_available",
    });
    expect(codexWake).not.toHaveBeenCalled();
    expect(runtime.touch).toHaveBeenCalledWith(
      {},
      identity,
      { connectionId: "connection-core", holderId: "claude-turn:session-1:turn-1", generation: 3 },
      late,
    );
  });

  test("without a recovery no waiter is woken; without a response the clock stays", async () => {
    const runtime = coreRuntime({});
    const wake = spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockResolvedValue([]);
    await finalizeCoreClaudeTurn({
      db: {} as db.Database,
      core: core({ requests: lane(null), quota: { settled: async () => false } }),
      lease,
    });
    expect(wake).not.toHaveBeenCalled();
    expect(runtime.touch).not.toHaveBeenCalled();
  });
});
