import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import {
  XAI_SUBSCRIPTION_TRANSPORT_ERROR_HEADER,
  XaiSubscriptionReloginRequired,
  XaiSubscriptionStreamingTerminalError,
} from "@opengeni/xai-subscription";
import * as parentWake from "../src/activities/parent-wake";
import { classifyXaiProviderError } from "../src/activities/agent-turn/errors";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import { SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT } from "../src/activities/agent-turn/subscription-core-failover";
import type { SubscriptionCoreTurn } from "../src/activities/agent-turn/turn-context";
import { finalizeCoreSubscriptionTurn } from "../src/activities/agent-turn/subscription-core-settlement";

// SuperGrok refusal settlement and finalization on the shared core
// (design 5.3, SuperGrok track X1b), the only SuperGrok path after X4.

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

const marked = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`xAI request failed (${status})`), {
    status,
    headers: new Headers({ ...headers, [XAI_SUBSCRIPTION_TRANSPORT_ERROR_HEADER]: "1" }),
  });

describe("SuperGrok provider-error classification", () => {
  test("definitive refusals become shared outcomes", () => {
    expect(classifyXaiProviderError(new XaiSubscriptionReloginRequired())).toEqual({
      kind: "unauthorized",
    });
    expect(classifyXaiProviderError(marked(401))).toEqual({ kind: "unauthorized" });
    expect(classifyXaiProviderError(marked(403))).toEqual({ kind: "forbidden" });
    expect(classifyXaiProviderError(marked(429, { "retry-after": "12" }))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 12_000,
    });
    // No provider retry time: the adapter's fallback applies on the core.
    const capacity = new XaiSubscriptionStreamingTerminalError({
      message:
        "The model is currently at capacity due to high demand. Please try again in a few minutes.",
      code: "response_error",
      eventType: "error",
      status: 502,
    });
    expect(classifyXaiProviderError(capacity)).toEqual({
      kind: "rate_limited",
      retryAfterMs: null,
    });
    expect(classifyXaiProviderError(marked(503))).toBeNull();
    expect(
      classifyXaiProviderError(Object.assign(new Error("unrelated 401"), { status: 401 })),
    ).toBeNull();
  });
});

function core(overrides: Partial<SubscriptionCoreTurn> = {}): SubscriptionCoreTurn {
  return {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 4,
    personal: false,
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
      billingState: { isXaiTurn: true },
      eventing: { publish: async () => [], turnStartedPublished: true, settle },
      providerTurn: {
        effectiveXaiCredentialId: null,
        xaiSubscriptionCore: coreTurn,
        codexSubscriptionCore: null,
      },
      leases: {
        codex: { lost: false },
        xai: {
          lost: false,
          held: true,
          holderId: "xai-turn:session-1:turn-1",
          generation: 3,
          stopHeartbeat: () => undefined,
          releaseCurrent,
        },
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

/** Scripted SuperGrok core runtime; the binding itself stays unregistered. */
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
  // The scoped legacy settlement (Claude's, the only one left) must never
  // run for a SuperGrok turn.
  const legacy = [spy(db, "armClaudeCapacityWait"), spy(db, "reconcileClaudeCapacityWait")];
  return { apply, count, touch, settlementProviders, legacy };
}

describe("SuperGrok refusal settlement on the core", () => {
  test("a rate limit is recorded against the leased connection and the same turn re-places", async () => {
    const runtime = coreRuntime({ refusals: 1 });
    const recovery = spy(db, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const coreTurn = core({ credentialVersion: 6 });
    const { deps, counters, releaseCurrent, settle } = failureDeps(
      marked(429, { "retry-after": "30" }),
      coreTurn,
    );
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });

    // The refusal plan is fenced on the generation the refused bearer carried.
    expect(runtime.settlementProviders[0]).toBe(db.SUBSCRIPTION_CORE_XAI);
    const [, appliedIdentity, ref, plan, fence] = runtime.apply.mock.calls[0]!;
    expect(appliedIdentity).toEqual(identity);
    expect(ref).toEqual({
      connectionId: "connection-core",
      holderId: "xai-turn:session-1:turn-1",
      generation: 3,
    });
    expect(plan).toMatchObject({ kind: "settle" });
    expect(fence).toMatchObject({ refreshGeneration: 6 });
    expect(runtime.count).toHaveBeenCalledTimes(1);
    expect(releaseCurrent).toHaveBeenCalledTimes(1);
    expect(recovery).toHaveBeenCalledWith(deps.db, "workspace-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      triggerEventId: "trigger-1",
      attemptId: "attempt-1",
      reason: "xai_credential_failover",
      detail: {
        provider: "supergrok-subscription",
        credentialId: "connection-core",
        failureKind: "rate_limited",
        failoverCount: 1,
        maxFailovers: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT - 1,
      },
    });
    expect(settle).not.toHaveBeenCalled();
    expect(counters).toContainEqual({
      name: "opengeni_subscription_core_failover_settlements_total",
      labels: { provider: "xai", outcome: "core_failover" },
    });
    expect(counters.some((counter) => counter.name.startsWith("opengeni_codex_failover"))).toBe(
      false,
    );
    for (const legacy of runtime.legacy) expect(legacy).not.toHaveBeenCalled();
  });

  test("without a resolver report the plan is fenced on the placed generation", async () => {
    const runtime = coreRuntime({ refusals: 1 });
    spy(db, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const { deps } = failureDeps(marked(429), core());
    await settleTurnFailure(deps as never);
    expect(runtime.apply.mock.calls[0]![4]).toMatchObject({ refreshGeneration: 4 });
  });

  test("the refusal that reaches the shared bound fails the turn with SuperGrok copy", async () => {
    coreRuntime({ refusals: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT });
    const recovery = spy(db, "requestSessionTurnRecovery");
    const parent = spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
      undefined as never,
    );
    const { deps, settle, counters } = failureDeps(marked(429), core());
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
        maxRefusals: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT,
        retryable: false,
        recovery: "user_message",
      },
    });
    expect(String(settled.events[0]!.payload.error)).toStartWith("SuperGrok accounts refused");
    expect(counters).toContainEqual({
      name: "opengeni_subscription_core_failover_settlements_total",
      labels: { provider: "xai", outcome: "core_exhausted" },
    });
    expect(parent).toHaveBeenCalledWith(expect.anything(), "workspace-1", "session-1", "turn-1");
  });

  test("an unrecorded sign-in refusal is never replayed and fails with typed copy", async () => {
    const runtime = coreRuntime({ receipt: false });
    const recovery = spy(db, "requestSessionTurnRecovery");
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps, settle } = failureDeps(new Error("wrapped", { cause: marked(401) }), core());
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
    expect(String(settled.events[0]!.payload.error)).toContain("SuperGrok");
  });

  test("a graceful disconnect re-places the same turn without a refusal or a count", async () => {
    const runtime = coreRuntime({ disconnected: true });
    const recovery = spy(db, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const { deps } = failureDeps(marked(401), core());
    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "recovering" });
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.count).not.toHaveBeenCalled();
    expect(recovery.mock.calls[0]![2]).toMatchObject({
      reason: "xai_credential_failover",
      detail: { provider: "supergrok-subscription", failureKind: "source_disconnected" },
    });
    expect(
      (recovery.mock.calls[0]![2] as { detail: Record<string, unknown> }).detail,
    ).not.toHaveProperty("failoverCount");
  });

  test("an unknown request outcome never records a refusal or re-places", async () => {
    const runtime = coreRuntime({});
    const recovery = spy(db, "requestSessionTurnRecovery");
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const error = new Error("stream broke", {
      cause: db.SUBSCRIPTION_CORE_XAI.errors.requestOutcomeUnknown(),
    });
    const { deps } = failureDeps(error, core());
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.count).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
  });

  test("a non-refusal provider failure leaves the core untouched", async () => {
    const runtime = coreRuntime({});
    const recovery = spy(db, "requestSessionTurnRecovery");
    spy(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(undefined as never);
    const { deps } = failureDeps(marked(503), core());
    await settleTurnFailure(deps as never).catch(() => undefined);
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.count).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: "xai_credential_failover" }),
    );
  });
});

describe("SuperGrok finalization on the core", () => {
  const lease = { holderId: "xai-turn:session-1:turn-1", generation: 3 } as never;
  const lane = (at: Date | null) =>
    ({ lastResponseReceivedAt: () => at }) as unknown as SubscriptionCoreTurn["requests"];

  test("a completed model call moves the binding clock to the latest response", async () => {
    const runtime = coreRuntime({});
    const early = new Date("2026-10-11T03:00:00.000Z");
    const late = new Date("2026-10-11T03:00:05.000Z");
    await finalizeCoreSubscriptionTurn({
      db: {} as db.Database,
      provider: db.SUBSCRIPTION_CORE_XAI as db.SubscriptionCoreProvider,
      core: core({ requests: lane(early), titleRequests: lane(late) }),
      lease,
    });
    expect(runtime.touch).toHaveBeenCalledWith(
      {},
      identity,
      { connectionId: "connection-core", holderId: "xai-turn:session-1:turn-1", generation: 3 },
      late,
    );
  });

  test("a turn without a responded call leaves the binding clock", async () => {
    const runtime = coreRuntime({});
    await finalizeCoreSubscriptionTurn({
      db: {} as db.Database,
      provider: db.SUBSCRIPTION_CORE_XAI as db.SubscriptionCoreProvider,
      core: core({ requests: lane(null) }),
      lease,
    });
    expect(runtime.touch).not.toHaveBeenCalled();
  });
});
