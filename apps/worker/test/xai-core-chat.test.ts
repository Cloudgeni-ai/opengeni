import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import {
  xaiSubscriptionFetch,
  xaiSubscriptionRequestStorage,
  type XaiSubscriptionRequestContext,
} from "@opengeni/xai-subscription";
import type { CapacityPhaseDeps } from "../src/activities/agent-turn/codex-capacity";
import {
  createTurnCredentialLeases,
  type TurnCredentialLeaseDeps,
} from "../src/activities/agent-turn/credential-leases";
import * as xaiCapacity from "../src/activities/agent-turn/xai-capacity";
import {
  buildXaiCoreRequestAuthorization,
  selectXaiTurnCapacityByRoute,
  xaiCoreRequestOutcomeUnknown,
} from "../src/activities/agent-turn/xai-core";
import type { SubscriptionCoreTurn } from "../src/activities/agent-turn/turn-context";
import { testSettings } from "@opengeni/testing";

// SuperGrok on the shared core (design 5.3, SuperGrok track X1a), dormant
// behind its provider route. No network: every upstream is scripted.

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
  return createTurnCredentialLeases(deps);
}

function capacityDeps(overrides: { source?: string; isXaiTurn?: boolean } = {}) {
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
    dispatchId: "dispatch-1",
    control: { activityStatus: "running", turnMetricOutcome: null },
    attempt: { turnId: "turn-1", executionGeneration: 3 },
    billingState: { isXaiTurn: overrides.isXaiTurn ?? true },
    eventing: { publish: async () => [], settle: async () => true },
    providerTurn: {
      effectiveXaiCredentialId: null,
      xaiRotationEnabled: true,
      xaiAuthoritySnapshot: { version: 1 },
      xaiSubscriptionCore: null,
      codexSubscriptionCore: null,
    },
    leases: leases(),
    claimedResult: (value: Record<string, unknown>) => ({ ...value, turnId: "turn-1" }),
    acknowledgeLostAttemptOwnership: () => undefined,
    turn: { id: "turn-1", source: overrides.source ?? "user", sandboxBackend: "none" },
    turnExecutionPolicy: {
      productModelId: "supergrok/grok-4.7",
      upstreamModelId: "grok-4.7",
      reasoningEffort: "medium",
      providerId: "supergrok-subscription",
    },
  };
  return deps as unknown as CapacityPhaseDeps;
}

function route(value: db.SubscriptionCoreProviderRoute) {
  spy(db, "withRlsContext").mockImplementation(
    async (_db: unknown, _context: unknown, callback: (scoped: never) => Promise<unknown>) =>
      await callback({} as never),
  );
  return spy(db, "readSubscriptionCoreProviderRoute").mockResolvedValue(value);
}

function coreTurns(
  placement: db.SubscriptionCorePlacement,
  evaluation: unknown = { kind: "run", connectionId: "connection-core", switch: "initial" },
) {
  const place = spyOn({ place: async () => placement }, "place");
  const recover = spyOn({ recover: async () => 0 }, "recover");
  const evaluate = spyOn({ evaluate: async () => evaluation }, "evaluate");
  spy(db, "subscriptionCoreTurns").mockReturnValue({
    placeSubscriptionCoreTurn: place,
    recoverSubscriptionCoreConnectionHealth: recover,
    evaluateSubscriptionCorePlacement: evaluate,
  } as never);
  return { place, recover, evaluate };
}

const runPlacement = {
  kind: "run",
  connectionId: "connection-core",
  personal: true,
  switch: "initial",
  reusedLease: false,
  explicit: false,
  previousConnectionId: null,
  rotationMode: "spread",
  refreshGeneration: 4,
  leasedUntil: new Date(Date.now() + 60_000),
  eligibleCount: 1,
  connectedCount: 1,
} as unknown as db.SubscriptionCorePlacement;

describe("SuperGrok capacity by provider route", () => {
  test("legacy runs the legacy selection unchanged after exactly one route read", async () => {
    const read = route("legacy");
    const legacy = spy(xaiCapacity, "selectXaiTurnCapacity").mockResolvedValue({ ok: true });
    const { place } = coreTurns(runPlacement);
    const deps = capacityDeps();
    expect(await selectXaiTurnCapacityByRoute(deps)).toEqual({ ok: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![1]).toEqual({ accountId: "account-1", provider: "xai" });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(legacy.mock.calls[0]![0]).toBe(deps);
    expect(place).not.toHaveBeenCalled();
    expect(deps.leases.xai.holderId).toBeNull();
  });

  test("a non-SuperGrok turn reads no route", async () => {
    const read = route("core");
    expect(await selectXaiTurnCapacityByRoute(capacityDeps({ isXaiTurn: false }))).toEqual({
      ok: true,
    });
    expect(read).not.toHaveBeenCalled();
  });

  test("maintenance fails closed and reads neither selector", async () => {
    route("maintenance");
    const legacy = spy(xaiCapacity, "selectXaiTurnCapacity");
    const { place } = coreTurns(runPlacement);
    await expect(selectXaiTurnCapacityByRoute(capacityDeps())).rejects.toMatchObject({
      payload: { code: "subscription_core_cutover_disabled", retryable: false },
    });
    expect(legacy).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });

  test("core places the accepted turn and adopts the core lease, never the legacy rotation", async () => {
    route("core");
    const legacy = spy(xaiCapacity, "selectXaiTurnCapacity");
    const legacyLease = spy(db, "acquireXaiCredentialLease");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    const { place, recover } = coreTurns(runPlacement);
    const deps = capacityDeps();
    try {
      expect(await selectXaiTurnCapacityByRoute(deps)).toEqual({ ok: true });
      expect(recover).toHaveBeenCalledTimes(1);
      expect(place).toHaveBeenCalledWith(deps.db, {
        identity,
        attemptId: "attempt-1",
        executionGeneration: 3,
        holderId: "xai-turn:session-session-1:turn-1:attempt-1",
        productModelId: "supergrok/grok-4.7",
        reasoningLevel: "medium",
        leaseTtlMs: db.XAI_CREDENTIAL_LEASE_TTL_MS,
      });
      expect(deps.providerTurn.xaiSubscriptionCore).toEqual({
        identity,
        connectionId: "connection-core",
        placedRefreshGeneration: 4,
        personal: true,
      });
      expect(deps.providerTurn.codexSubscriptionCore).toBeNull();
      expect(deps.providerTurn.effectiveXaiCredentialId).toBe("connection-core");
      expect(deps.providerTurn.xaiRotationEnabled).toBe(false);
      expect(deps.providerTurn.xaiAuthoritySnapshot).toBeNull();
      expect(deps.leases.xai.subscriptionCoreConnection).toBe("connection-core");
      expect(deps.leases.xai.subjectId).toBeNull();
      expect(deps.leases.xai.generation).toBe(3);
      expect(deps.leases.xai.held).toBe(true);
      expect(legacy).not.toHaveBeenCalled();
      expect(legacyLease).not.toHaveBeenCalled();
    } finally {
      deps.leases.xai.stopHeartbeat();
    }
  });

  test("a core wait parks the same turn on its SuperGrok core waiter and re-evaluates it", async () => {
    route("core");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    spy(db, "readSubscriptionCoreTurnModel").mockResolvedValue({
      productModelId: "supergrok/grok-4.7",
      reasoningLevel: "medium",
    });
    spy(db, "getSessionGoal").mockResolvedValue(null);
    spy(events, "publishDurableSessionEvents").mockResolvedValue(undefined as never);
    const resetAt = new Date(Date.now() + 3_600_000);
    const { evaluate } = coreTurns(
      {
        kind: "wait",
        reason: "no_eligible_capacity",
        earliestResetAt: resetAt,
        healthRetryAt: null,
        explicitConnectionId: null,
      } as unknown as db.SubscriptionCorePlacement,
      {
        kind: "wait",
        reason: "no_eligible_capacity",
        earliestResetAt: resetAt,
        healthRetryAt: null,
        explicitConnectionId: null,
      },
    );
    const waiter = {
      waiterId: "waiter-1",
      provider: "xai",
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      blockedTurnId: "turn-1",
      blockedTurnGeneration: 3,
      generation: 1,
      wakeRevision: 1,
      observedWakeRevision: 1,
      waitReason: "no_eligible_capacity",
      resetKind: "authoritative",
      refreshAttempt: 0,
      earliestResetAt: resetAt,
      nextCheckAt: resetAt,
      goalId: null,
      goalVersion: null,
      lastWakeReason: "capacity_wait_armed",
    } satisfies db.SubscriptionCoreCodexCapacityWait;
    const arm = spy(db, "armSubscriptionCoreCapacityWait").mockResolvedValue({
      action: "waiting",
      waiter,
      events: [],
    });
    const codexArm = spy(db, "armSubscriptionCoreCodexCapacityWait");
    spy(db, "getSubscriptionCoreCapacityWaitById").mockResolvedValue(waiter);
    const reconcile = spy(db, "reconcileSubscriptionCoreCapacityWait").mockResolvedValue({
      action: "waiting",
      waiter,
      events: [],
    });
    const deps = capacityDeps();
    expect(await selectXaiTurnCapacityByRoute(deps)).toEqual({
      exit: {
        status: "waiting_capacity",
        capacityWait: {
          provider: "xai",
          waiterId: "waiter-1",
          generation: 1,
          nextCheckAt: resetAt.toISOString(),
          wakeRevision: 1,
        },
        turnId: "turn-1",
      },
    });
    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm.mock.calls[0]![1]).toBe("xai");
    expect(arm.mock.calls[0]![2]).toMatchObject({
      turnId: "turn-1",
      attemptId: "attempt-1",
      waitReason: "no_eligible_capacity",
      earliestResetAt: resetAt,
      failurePayload: { code: "subscription_capacity_unavailable" },
    });
    expect(
      String((arm.mock.calls[0]![2] as { failurePayload: { error: string } }).failurePayload.error),
    ).toContain("SuperGrok");
    expect(codexArm).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]![1]).toMatchObject({
      waiterId: "waiter-1",
      generation: 1,
      provider: "xai",
      evaluation: { kind: "wait", waitReason: "no_eligible_capacity" },
    });
    expect(deps.leases.xai.held).toBe(false);
  });

  test("a core wait for compaction defers with its request preserved, never parks", async () => {
    route("core");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    coreTurns({
      kind: "wait",
      reason: "all_accounts_exhausted",
      earliestResetAt: null,
      healthRetryAt: null,
      explicitConnectionId: null,
    } as unknown as db.SubscriptionCorePlacement);
    const deps = capacityDeps({ source: "compaction" });
    const settled: unknown[] = [];
    (deps.eventing as { settle: (value: unknown) => Promise<boolean> }).settle = async (value) => {
      settled.push(value);
      return true;
    };
    expect(await selectXaiTurnCapacityByRoute(deps)).toEqual({
      exit: { status: "idle", deferredUntilWake: true, turnId: "turn-1" },
    });
    expect(JSON.stringify(settled)).toContain('"requestPreserved":true');
  });
});

/** A placed core turn with a held core lease and scripted request custody. */
function placedCore(options: { fence?: () => Promise<void> } = {}) {
  const order: string[] = [];
  let operation = 0;
  const runtime = {
    reserveSubscriptionCoreRequest: async (
      _db: unknown,
      _identity: unknown,
      _ref: unknown,
      request: { requestId: string; transportAttempt: number },
    ) => {
      order.push(`reserve:${request.requestId}:${request.transportAttempt}`);
      return { operationId: `operation-${++operation}` };
    },
    settleSubscriptionCoreRequest: async (
      _db: unknown,
      _identity: unknown,
      _ref: unknown,
      request: { operationId: string; outcome: string },
    ) => {
      order.push(`settle:${request.operationId}:${request.outcome}`);
    },
    isSubscriptionCoreSourceDisconnected: async () => false,
  };
  spy(db, "subscriptionCoreRequests").mockReturnValue(runtime as never);
  let refreshes = 0;
  const resolverInputs: unknown[] = [];
  spy(db, "buildSubscriptionCoreXaiTokenResolver").mockImplementation(((...args: unknown[]) => {
    resolverInputs.push(args);
    return {
      getToken: async () => ({
        accessToken: "core-access",
        userId: "subject-1",
        credentialVersion: 4,
      }),
      refresh: async () => {
        refreshes += 1;
        return { accessToken: "core-fresh", userId: "subject-1", credentialVersion: 5 };
      },
    };
  }) as never);
  const turnLeases = leases();
  const lease = turnLeases.xai;
  lease.holderId = "xai-turn:session-1:turn-1";
  lease.generation = 3;
  lease.useSubscriptionCoreLease("connection-core");
  lease.held = true;
  lease.confirmedUntilMs = performance.now() + 60_000;
  spyOn(lease, "assertCurrentForDispatch").mockImplementation(async () => {
    order.push("fence");
    await options.fence?.();
  });
  const core: SubscriptionCoreTurn = {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 4,
    personal: false,
  };
  const authorization = buildXaiCoreRequestAuthorization({
    db: {} as db.Database,
    settings: testSettings({ supergrokSubscriptionEnabled: true }),
    core,
    lease,
    execution: { attemptId: "attempt-1", executionGeneration: 3 },
  });
  return { order, core, lease, authorization, refreshes: () => refreshes, resolverInputs };
}

function sse(...items: unknown[]): Response {
  return new Response(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function send(
  authorization: ReturnType<typeof placedCore>["authorization"],
  responses: Array<() => Response>,
  prefix = "attempt-1:1:1:xai",
) {
  let call = 0;
  let sequence = 0;
  const tokens: string[] = [];
  const fetch = xaiSubscriptionFetch(async (_input, init) => {
    tokens.push(new Headers(init?.headers).get("authorization") ?? "");
    const next = responses[call++];
    if (!next) throw new Error("unexpected provider call");
    return next();
  });
  const context: XaiSubscriptionRequestContext = {
    clientVersion: "1.0.1",
    sessionId: "session-1",
    turnId: "turn-1",
    getToken: authorization.getToken,
    refresh: authorization.refresh,
    resolveModel: (slug) => slug,
    nextRequestId: () => `${prefix}:${++sequence}`,
    beforeProviderDispatch: authorization.beforeProviderDispatch,
    onProviderRequestSettled: authorization.onProviderRequestSettled,
  };
  const response = xaiSubscriptionRequestStorage.run(context, () =>
    fetch("https://cli-chat-proxy.grok.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "supergrok/grok-4.7", input: "hello" }),
    }),
  );
  return { response, calls: () => call, tokens };
}

const completed = () =>
  sse(
    { type: "response.created", response: { id: "r1" } },
    { type: "response.output_text.delta", delta: "hi" },
    { type: "response.completed", response: { id: "r1", output: [] } },
  );

describe("SuperGrok request custody on the core", () => {
  test("the bearer comes from the core resolver for the exact turn and lease", async () => {
    const { authorization, resolverInputs, core } = placedCore();
    expect(await authorization.getToken()).toEqual({
      accessToken: "core-access",
      userId: "subject-1",
    });
    // The refusal settlement fences on the generation the latest bearer carried.
    expect(core.credentialVersion).toBe(4);
    await authorization.refresh();
    expect(core.credentialVersion).toBe(5);
    expect((resolverInputs[0] as unknown[])[2]).toEqual(identity);
    expect((resolverInputs[0] as unknown[])[3]).toEqual({
      connectionId: "connection-core",
      holderId: "xai-turn:session-1:turn-1",
      generation: 3,
    });
  });

  test("each physical request is fenced and reserved before network I/O and settled once", async () => {
    const { order, core, authorization } = placedCore();
    const first = send(authorization, [completed]);
    await (await first.response).text();
    expect(order).toEqual(["fence", "reserve:attempt-1:1:1:xai:1:1"]);
    // A completed response is settled only after the history checkpoint.
    await core.requests!.checkpoint();
    expect(order.at(-1)).toBe("settle:operation-1:response_received");
    expect(core.requests!.canRecover()).toBe(true);
  });

  test("a 401 is settled refused and its refreshed retry is a new reserved physical request", async () => {
    const { order, core, authorization, refreshes } = placedCore();
    const sent = send(authorization, [
      () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      completed,
    ]);
    await (await sent.response).text();
    expect(sent.calls()).toBe(2);
    expect(refreshes()).toBe(1);
    expect(sent.tokens).toEqual(["Bearer core-access", "Bearer core-fresh"]);
    expect(order).toEqual([
      "fence",
      "reserve:attempt-1:1:1:xai:1:1",
      "settle:operation-1:refused",
      "fence",
      "reserve:attempt-1:1:1:xai:1:2",
    ]);
    await core.requests!.checkpoint();
    expect(order.at(-1)).toBe("settle:operation-2:response_received");
  });

  test("an HTTP 200 capacity terminal before any output is a refusal", async () => {
    const { order, authorization } = placedCore();
    const sent = send(authorization, [
      () =>
        sse(
          { type: "response.created", response: { id: "r1" } },
          {
            type: "response.failed",
            response: { id: "r1", status: "failed", error: { code: "usage_limit_reached" } },
          },
        ),
    ]);
    await (await sent.response).text().catch(() => undefined);
    expect(order).toEqual(["fence", "reserve:attempt-1:1:1:xai:1:1", "settle:operation-1:refused"]);
  });

  test("an unknown outcome is settled unknown and never replayed", async () => {
    const { order, core, authorization } = placedCore();
    const dropped = send(authorization, [
      () => new Response("upstream gateway timeout", { status: 504 }),
    ]);
    await dropped.response.catch(() => undefined);
    expect(order).toEqual(["fence", "reserve:attempt-1:1:1:xai:1:1", "settle:operation-1:unknown"]);
    expect(core.requests!.hasUnknownOutcome()).toBe(true);
    expect(core.requests!.canRecover()).toBe(false);
    expect(xaiCoreRequestOutcomeUnknown(new Error("plain"), core)).toMatchObject({
      code: "subscription_core_request_outcome_unknown",
    });
    // A later request in the same attempt is refused locally before network I/O.
    const replay = send(authorization, [completed], "attempt-1:1:1:xai-again");
    await expect(replay.response).rejects.toMatchObject({
      code: "subscription_core_request_outcome_unknown",
    });
    expect(replay.calls()).toBe(0);
  });

  test("a lost core lease stops dispatch before any reservation", async () => {
    const lost = Object.assign(new Error("lease lost"), { code: "xai_credential_lease_lost" });
    const { order, authorization } = placedCore({
      fence: async () => {
        throw lost;
      },
    });
    const sent = send(authorization, [completed]);
    await expect(sent.response).rejects.toBe(lost);
    expect(sent.calls()).toBe(0);
    expect(order).toEqual(["fence"]);
  });

  test("session-title requests use their own custody lane under the same fence", async () => {
    const { core, authorization } = placedCore();
    expect(core.titleRequests).toBeDefined();
    expect(core.titleRequests).not.toBe(core.requests);
    await authorization.assertDispatch();
  });
});

test("no SuperGrok turn on the legacy route touches durable events through the core", async () => {
  route("legacy");
  const publish = spy(events, "publishDurableSessionEvents");
  spy(xaiCapacity, "selectXaiTurnCapacity").mockResolvedValue({ ok: true });
  await selectXaiTurnCapacityByRoute(capacityDeps());
  expect(publish).not.toHaveBeenCalled();
});
