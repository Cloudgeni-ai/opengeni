import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import { AnthropicRequestError } from "@opengeni/runtime";
import * as parentWake from "../src/activities/parent-wake";
import { classifyClaudeProviderError } from "../src/activities/agent-turn/errors";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import {
  claudeCoreRefusal,
  finalizeCoreClaudeTurn,
  joinCoreClaudeObservations,
} from "../src/activities/agent-turn/claude-core";
import { SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT } from "../src/activities/agent-turn/subscription-core-failover";
import { createCoreSubscriptionRequests } from "../src/activities/agent-turn/subscription-core-requests";
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
      },
      billingState: { isClaudeTurn: true },
      eventing: { publish: async () => [], turnStartedPublished: true, settle },
      providerTurn: {
        effectiveClaudeCredentialId: "connection-core",
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
  return { apply, count, touch, settlementProviders };
}

/**
 * The legacy Claude settlement is deleted (M4 C4): a core refusal never
 * records turn-local `claudeAuthRecovery` state (C1b's core receipts replace
 * it), and the db package no longer exports a legacy Claude credential reader
 * or capacity waiter the settlement could reach.
 */
function expectNoLegacyClaudeSettlement(recovery: { mock: { calls: unknown[][] } }) {
  for (const call of recovery.mock.calls)
    expect(Object.keys((call[2] ?? {}) as object)).not.toContain("claudeAuthRecovery");
}

test("the db package exports no legacy Claude settlement producers", () => {
  for (const name of [
    "resolveClaudeAccountCredential",
    "recordClaudeAccountUsage",
    "armClaudeCapacityWait",
    "reconcileClaudeCapacityWait",
    "claudeCapacityRepository",
    "heartbeatClaudeCredentialLeaseUntil",
  ])
    expect(name in db, name).toBe(false);
});

function recoveringRecovery() {
  spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
  return spy(db, "requestSessionTurnRecovery").mockResolvedValue({
    action: "recovering",
    events: [],
  } as never);
}

/**
 * The shared request custody with one answered request that still awaits its
 * history checkpoint; settles are recorded as `<requestId>:<outcome>`.
 */
async function answeredLane(settles: string[], options: { continuesAfterResponse: boolean }) {
  const lane = createCoreSubscriptionRequests({
    reserve: async (request) => ({ operationId: request.requestId }),
    settle: async ({ operationId, outcome }) => {
      settles.push(`${operationId}:${outcome}`);
    },
    displayName: "Provider",
    outcomeUnknown: () =>
      Object.assign(new Error("unknown"), { code: "subscription_core_request_outcome_unknown" }),
    isOutcomeUnknown: () => false,
    continuesAfterResponse: options.continuesAfterResponse,
  });
  const first = { requestId: "first", transportAttempt: 1 };
  await lane.reserve(first);
  await lane.observe({ ...first, outcome: "response_received" });
  expect(lane.canRecover()).toBe(false);
  return lane;
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
    expectNoLegacyClaudeSettlement(recovery);
  });

  test("a 401 the transport could not renew is a sign-in quarantine and re-places the turn", async () => {
    const runtime = coreRuntime({ refusals: 1 });
    const recovery = recoveringRecovery();
    const { deps } = failureDeps(anthropic(401, "authentication_error"), core());
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    // The transport already ran the turn's one forced refresh: no second
    // refresh plan.
    expect(runtime.apply.mock.calls[0]![3]).toMatchObject({
      kind: "settle",
      receipt: { kind: "unauthorized", evidence: { refreshGeneration: 4 } },
      health: { kind: "quarantine", reason: "sign_in" },
    });
    expect(recovery.mock.calls[0]![2]).toMatchObject({
      reason: "claude_credential_failover",
      detail: { failureKind: "unauthorized" },
    });
    expectNoLegacyClaudeSettlement(recovery);
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
    expectNoLegacyClaudeSettlement(recovery);
  });

  for (const unknown of [false, true]) {
    test(`an unfinished tool-less title does not checkpoint or fence overload recovery (unknown=${unknown})`, async () => {
      const runtime = coreRuntime({ refusals: 1 });
      const recovery = recoveringRecovery();
      const { deps, releaseCurrent } = failureDeps(
        anthropic(529, "overloaded_error"),
        core({
          titleRequests: {
            canRecover: () => false,
            hasUnknownOutcome: () => unknown,
          } as SubscriptionCoreTurn["titleRequests"],
        }),
      );
      const history = spy(deps.historySink, "reconcileConversationTruth");
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
      expect(recovery.mock.calls[0]![2]).toMatchObject({ reason: "provider_overloaded" });
      // Generic recovery commits history once. The title must not trigger a
      // second pre-recovery checkpoint of the already-safe main lane.
      expect(history).toHaveBeenCalledTimes(1);
      expect(runtime.apply).not.toHaveBeenCalled();
      expect(releaseCurrent).not.toHaveBeenCalled();
    });
  }

  test("a 529 on a paused search's continuation checkpoints the answered request, then recovers", async () => {
    coreRuntime({ refusals: 1 });
    const order: string[] = [];
    const recovery = recoveringRecovery();
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    let checkpointed = false;
    const paused = {
      checkpoint: async () => {
        order.push("checkpoint");
        checkpointed = true;
      },
      canRecover: () => checkpointed,
      hasUnknownOutcome: () => false,
      unknownIsOwnAndSettled: () => false,
    } as unknown as SubscriptionCoreTurn["requests"];
    const { deps } = failureDeps(
      anthropic(529, "overloaded_error"),
      core({ requests: paused, titleRequests: undefined }),
    );
    deps.historySink.reconcileConversationTruth = async () => {
      order.push("history");
    };
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(order.slice(0, 2)).toEqual(["history", "checkpoint"]);
    expect(order.filter((step) => step === "checkpoint")).toHaveLength(1);
    expect(recovery.mock.calls[0]![2]).toMatchObject({ reason: "provider_overloaded" });
  });

  test("a lane still without a response stays terminal after the checkpoint", async () => {
    coreRuntime({ refusals: 1 });
    const recovery = recoveringRecovery();
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    let checkpoints = 0;
    const pending = {
      checkpoint: async () => {
        checkpoints += 1;
      },
      canRecover: () => false,
      hasUnknownOutcome: () => false,
      unknownIsOwnAndSettled: () => false,
    } as unknown as SubscriptionCoreTurn["requests"];
    const { deps } = failureDeps(
      anthropic(529, "overloaded_error"),
      core({ requests: pending, titleRequests: undefined }),
    );
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
    expect(checkpoints).toBe(1);
    expect(recovery).not.toHaveBeenCalled();
  });

  test("a real paused lane settles the refused continuation, then checkpoints the answer and recovers", async () => {
    coreRuntime({ refusals: 1 });
    const recovery = recoveringRecovery();
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const settles: string[] = [];
    const lane = await answeredLane(settles, { continuesAfterResponse: true });
    // The paused search's continuation is refused with a 529.
    const continuation = { requestId: "continuation", transportAttempt: 1 };
    await lane.reserve(continuation);
    await lane.observe({ ...continuation, outcome: "refused" });
    const { deps } = failureDeps(
      anthropic(529, "overloaded_error"),
      core({ requests: lane, titleRequests: undefined }),
    );
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(settles).toEqual(["continuation:refused", "first:response_received"]);
    expect(recovery.mock.calls[0]![2]).toMatchObject({ reason: "provider_overloaded" });
  });

  for (const provider of ["Codex", "SuperGrok"] as const) {
    test(`a ${provider} core lane with an answer awaiting its checkpoint keeps its gate: terminal, no checkpoint`, async () => {
      coreRuntime({ refusals: 1 });
      const recovery = recoveringRecovery();
      spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
      const settles: string[] = [];
      const lane = await answeredLane(settles, { continuesAfterResponse: false });
      const { deps } = failureDeps(anthropic(529, "overloaded_error"), null);
      const turn = core({ requests: lane, titleRequests: undefined });
      Object.assign(deps.billingState, {
        isClaudeTurn: false,
        isCodexTurn: provider === "Codex",
        isXaiTurn: provider === "SuperGrok",
      });
      Object.assign(deps.providerTurn, {
        codexSubscriptionCore: provider === "Codex" ? turn : null,
        xaiSubscriptionCore: provider === "SuperGrok" ? turn : null,
      });
      expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
      expect(settles).toEqual([]);
      expect(recovery).not.toHaveBeenCalled();
    });
  }

  test("the same retryable failure and lane recover on Claude (the control for the gate cases)", async () => {
    coreRuntime({ refusals: 1 });
    const recovery = recoveringRecovery();
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const settles: string[] = [];
    const lane = await answeredLane(settles, { continuesAfterResponse: false });
    const { deps } = failureDeps(
      anthropic(529, "overloaded_error"),
      core({ requests: lane, titleRequests: undefined }),
    );
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(settles).toEqual(["first:response_received"]);
    expect(recovery).toHaveBeenCalledTimes(1);
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
    expectNoLegacyClaudeSettlement(recovery);
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

  test("an unknown outcome with an answered request awaiting its checkpoint stays terminal and unsettled", async () => {
    const runtime = coreRuntime({});
    const recovery = spy(db, "requestSessionTurnRecovery");
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const settles: string[] = [];
    const lane = await answeredLane(settles, { continuesAfterResponse: true });
    const error = new Error("stream broke", {
      cause: db.SUBSCRIPTION_CORE_CLAUDE.errors.requestOutcomeUnknown(),
    });
    const { deps } = failureDeps(error, core({ requests: lane, titleRequests: undefined }));
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
    expect(settles).toEqual([]);
    expect(runtime.apply).not.toHaveBeenCalled();
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

  test("a refused response's queued usage observations are joined before the refusal is recorded and the lease released", async () => {
    const order: string[] = [];
    const runtime = coreRuntime({ refusals: 1 });
    runtime.apply.mockImplementation(async () => {
      order.push("refusal");
      return { receipt: true, health: true };
    });
    recoveringRecovery();
    spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockImplementation((async () => {
      order.push("wake");
      return [];
    }) as never);
    // The 429's own headers (a rejected window with its reset) are still
    // queued when settlement starts.
    const chain = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("observation");
      return true;
    })();
    const { deps, releaseCurrent } = failureDeps(
      anthropic(429, "rate_limit_error", { "anthropic-ratelimit-unified-status": "rejected" }),
      core({ quota: { settled: () => chain } }),
    );
    releaseCurrent.mockImplementation(async () => {
      order.push("release");
      return true;
    });
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    // Placement sees the observed exhaustion before the refusal, and no write
    // runs after the lease fence moved; the recovery wakes Claude waiters.
    expect(order).toEqual(["observation", "wake", "refusal", "release"]);
  });

  function queuedObservation(order: string[]) {
    spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockImplementation((async () => {
      order.push("wake");
      return [];
    }) as never);
    const chain = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("observation");
      return true;
    })();
    return core({ quota: { settled: () => chain } });
  }

  test("a graceful disconnect joins queued observations before it releases the lease, recording no refusal", async () => {
    const order: string[] = [];
    const runtime = coreRuntime({ disconnected: true });
    recoveringRecovery();
    const { deps, releaseCurrent } = failureDeps(
      anthropic(401, "authentication_error"),
      queuedObservation(order),
    );
    releaseCurrent.mockImplementation(async () => {
      order.push("release");
      return true;
    });
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(order).toEqual(["observation", "wake", "release"]);
    expect(runtime.apply).not.toHaveBeenCalled();
  });

  test("the refusal that reaches the bound joins queued observations before it is recorded", async () => {
    const order: string[] = [];
    const runtime = coreRuntime({ refusals: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT });
    runtime.apply.mockImplementation(async () => {
      order.push("refusal");
      return { receipt: true, health: true };
    });
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps, releaseCurrent } = failureDeps(
      anthropic(429, "rate_limit_error"),
      queuedObservation(order),
    );
    releaseCurrent.mockImplementation(async () => {
      order.push("release");
      return true;
    });
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(order).toEqual(["observation", "wake", "refusal", "release"]);
  });

  test("refusal settlement passes its cancellation signal: a stuck wake never holds a cancelled turn", async () => {
    const runtime = coreRuntime({ refusals: 1 });
    recoveringRecovery();
    spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockImplementation(
      (() => new Promise(() => undefined)) as never,
    );
    const { deps } = failureDeps(
      anthropic(429, "rate_limit_error"),
      core({ quota: { settled: () => Promise.resolve(true) } }),
    );
    const cancelled = new AbortController();
    cancelled.abort();
    deps.cancellationSignal = cancelled.signal as never;
    // Without the signal the wake would hold settlement for the 30 second
    // finalizer bound, far past this test's timeout.
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(runtime.apply).toHaveBeenCalledTimes(1);
  });

  test("a joined observation chain wakes the account's Claude waiters once", async () => {
    const wake = spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockResolvedValue([]);
    const chain = Promise.resolve(true);
    const turn = core({ quota: { settled: () => chain } });
    await joinCoreClaudeObservations({ db: {} as db.Database }, turn);
    await joinCoreClaudeObservations({ db: {} as db.Database }, turn);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith({}, "claude", {
      accountId: "account-1",
      reason: "quota_observed_available",
    });
    // A failed chain records nothing and wakes nobody.
    await joinCoreClaudeObservations(
      { db: {} as db.Database },
      core({ quota: { settled: () => Promise.reject(new Error("write failed")) } }),
    );
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("a wake that never returns cannot hold the join: its delivery is bounded", async () => {
    const wake = spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockImplementation(
      (() => new Promise(() => undefined)) as never,
    );
    const turn = core({ quota: { settled: () => Promise.resolve(true) } });
    await joinCoreClaudeObservations({ db: {} as db.Database }, turn, { wakeTimeoutMs: 10 });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("a slow quota write is awaited in full; only the wake is bounded", async () => {
    const order: string[] = [];
    spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockImplementation((async () => {
      order.push("wake");
      return [];
    }) as never);
    const chain = new Promise<boolean>((resolve) =>
      setTimeout(() => {
        order.push("observation");
        resolve(true);
      }, 50),
    );
    await joinCoreClaudeObservations(
      { db: {} as db.Database },
      core({ quota: { settled: () => chain } }),
      { wakeTimeoutMs: 10 },
    );
    order.push("joined");
    expect(order).toEqual(["observation", "wake", "joined"]);
  });

  test("a cancelled settlement detaches the wake at once, after the queued writes", async () => {
    const order: string[] = [];
    const wake = spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockImplementation(
      (() => new Promise(() => undefined)) as never,
    );
    const cancelled = new AbortController();
    const chain = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("observation");
      return true;
    })();
    const turn = core({ quota: { settled: () => chain } });
    const joined = joinCoreClaudeObservations({ db: {} as db.Database }, turn, {
      signal: cancelled.signal,
      wakeTimeoutMs: 60_000,
    }).then(() => order.push("joined"));
    await chain;
    cancelled.abort();
    await joined;
    expect(order).toEqual(["observation", "joined"]);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("an already-cancelled join still awaits the queued writes in full", async () => {
    const order: string[] = [];
    spy(db, "wakeSubscriptionCoreProviderCapacityWaiters").mockImplementation(
      (() => new Promise(() => undefined)) as never,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    const chain = new Promise<boolean>((resolve) =>
      setTimeout(() => {
        order.push("observation");
        resolve(true);
      }, 50),
    );
    await joinCoreClaudeObservations(
      { db: {} as db.Database },
      core({ quota: { settled: () => chain } }),
      { signal: cancelled.signal },
    );
    order.push("joined");
    expect(order).toEqual(["observation", "joined"]);
  });

  test("a 429 without the accepted model is not settled: it never widens to the whole connection", async () => {
    const binding = claudeCoreRefusal(undefined);
    expect(binding.classify(anthropic(429, "rate_limit_error"))).toBeNull();
    expect(binding.classify(anthropic(401, "authentication_error"))).toEqual({
      kind: "unauthorized",
    });
    const runtime = coreRuntime({ refusals: 1 });
    spy(db, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps } = failureDeps(
      anthropic(429, "rate_limit_error"),
      core({ productModelId: undefined }),
    );
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(runtime.apply).not.toHaveBeenCalled();
  });

  test("the transport spent the one forced refresh: settlement never plans a second", () => {
    expect(claudeCoreRefusal(MODEL).credential).toEqual({
      renewable: true,
      refreshedBeforeRefusal: true,
    });
  });

  test("a 529 keeps the turn's lease and binding: the retry runs on the same connection", async () => {
    const runtime = coreRuntime({ refusals: 1 });
    recoveringRecovery();
    const { deps, releaseCurrent } = failureDeps(anthropic(529, "overloaded_error"), core());
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    // Nothing recorded and the lease still held: the next attempt's placement
    // reuses the binding (the shared conformance scenario "overloaded, failed
    // and lost requests neither fail over nor change health" proves the same
    // connection is placed again on real PostgreSQL for both Claude subjects).
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(releaseCurrent).not.toHaveBeenCalled();
    expect(deps.leases.claude.held).toBe(true);
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
