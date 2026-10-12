import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import { testSettings } from "@opengeni/testing";
import { withClaudeUsageObserver } from "../../../packages/runtime/src/claude-subscription-usage";
import { instrumentedModelFetch } from "../../../packages/runtime/src/model-provider-client";
import { AnthropicMessagesModel } from "../../../packages/runtime/src/anthropic-messages";
import { anthropicSearchAccountScope } from "../../../packages/runtime/src/anthropic-web-search";
import {
  parseModelProvidersJson,
  withClaudeConnectionCatalog,
  withClaudeConnectionCredential,
  type ResolvedModelProvider,
} from "@opengeni/config";
import type { CapacityPhaseDeps } from "../src/activities/agent-turn/codex-capacity";
import {
  createTurnCredentialLeases,
  type TurnCredentialLeaseDeps,
} from "../src/activities/agent-turn/credential-leases";
import * as legacyCapacity from "../src/activities/agent-turn/xai-capacity";
import {
  buildClaudeCoreRequestAuthorization,
  CLAUDE_CORE_SETTINGS_PLACEHOLDER_TOKEN,
  claudeCoreModelScope,
  claudeCoreSettingsCredential,
  claudeCoreSettingsPlaceholderToken,
  claudeCoreRequestOutcomeUnknown,
  claudeCoreRequestPreparer,
  claudeResponseInspector,
  claudeSubscriptionProviderIds,
  selectClaudeTurnCapacityByRoute,
} from "../src/activities/agent-turn/claude-core";
import {
  subscriptionCoreTurnOf,
  type SubscriptionCoreTurn,
} from "../src/activities/agent-turn/turn-context";
import { placedSubscriptionCore } from "../src/activities/agent-turn/subscription-core-placed";
import { createCoreSubscriptionRequests } from "../src/activities/agent-turn/subscription-core-requests";
import { assertTurnModelConnection } from "../src/activities/agent-turn/codex-core-capacity";

// Claude chat on the shared core (design 5.3, Claude track C1a), dormant
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

const PRODUCT_MODEL = "organization-claude-subscription/claude-sonnet-5";
const PROVIDER_ID = "organization-claude-subscription";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

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

function capacityDeps(overrides: { source?: string; isClaudeTurn?: boolean } = {}) {
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
    billingState: { isClaudeTurn: overrides.isClaudeTurn ?? true },
    eventing: { publish: async () => [], settle: async () => true },
    providerTurn: {
      effectiveClaudeCredentialId: null,
      effectiveClaudeCredentialVersion: 7,
      claudeRotationEnabled: true,
      claudeAuthoritySnapshot: { version: 1, scope: "workspace" },
      claudeUpstreamModelId: null,
      claudeSubscriptionCore: null,
      xaiSubscriptionCore: null,
      codexSubscriptionCore: null,
    },
    leases: leases(),
    claimedResult: (value: Record<string, unknown>) => ({ ...value, turnId: "turn-1" }),
    acknowledgeLostAttemptOwnership: () => undefined,
    turn: { id: "turn-1", source: overrides.source ?? "user", sandboxBackend: "none" },
    turnExecutionPolicy: {
      productModelId: PRODUCT_MODEL,
      upstreamModelId: "claude-sonnet-5",
      reasoningEffort: "medium",
      providerId: PROVIDER_ID,
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

function coreTurns(placement: db.SubscriptionCorePlacement) {
  const place = spyOn({ place: async () => placement }, "place");
  const recover = spyOn({ recover: async () => 0 }, "recover");
  spy(db, "subscriptionCoreTurns").mockReturnValue({
    placeSubscriptionCoreTurn: place,
    recoverSubscriptionCoreConnectionHealth: recover,
  } as never);
  return { place, recover };
}

const runPlacement = {
  kind: "run",
  connectionId: "connection-core",
  personal: false,
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

describe("Claude capacity by provider route", () => {
  test("legacy runs the legacy selection unchanged after exactly one route read", async () => {
    const read = route("legacy");
    const legacy = spy(legacyCapacity, "selectClaudeTurnCapacity").mockResolvedValue({ ok: true });
    const { place } = coreTurns(runPlacement);
    const deps = capacityDeps();
    expect(await selectClaudeTurnCapacityByRoute(deps)).toEqual({ ok: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![1]).toEqual({ accountId: "account-1", provider: "claude" });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(legacy.mock.calls[0]![0]).toBe(deps);
    expect(place).not.toHaveBeenCalled();
    expect(deps.leases.claude.holderId).toBeNull();
  });

  test("a non-Claude turn reads no route", async () => {
    const read = route("core");
    const legacy = spy(legacyCapacity, "selectClaudeTurnCapacity");
    expect(await selectClaudeTurnCapacityByRoute(capacityDeps({ isClaudeTurn: false }))).toEqual({
      ok: true,
    });
    expect(read).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  test("maintenance fails closed and reads neither selector", async () => {
    route("maintenance");
    const legacy = spy(legacyCapacity, "selectClaudeTurnCapacity");
    const { place } = coreTurns(runPlacement);
    await expect(selectClaudeTurnCapacityByRoute(capacityDeps())).rejects.toMatchObject({
      payload: { code: "subscription_core_cutover_disabled", retryable: false },
    });
    expect(legacy).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });

  test("core places the accepted turn and adopts the core lease, never the legacy rotation", async () => {
    route("core");
    const legacy = spy(legacyCapacity, "selectClaudeTurnCapacity");
    const legacyLease = spy(db, "acquireClaudeCredentialLease");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    const { place, recover } = coreTurns(runPlacement);
    const deps = capacityDeps();
    try {
      expect(await selectClaudeTurnCapacityByRoute(deps)).toEqual({ ok: true });
      expect(recover).toHaveBeenCalledTimes(1);
      expect(place).toHaveBeenCalledWith(deps.db, {
        identity,
        attemptId: "attempt-1",
        executionGeneration: 3,
        holderId: "claude-turn:session-session-1:turn-1:attempt-1",
        productModelId: PRODUCT_MODEL,
        reasoningLevel: "medium",
        leaseTtlMs: db.CLAUDE_CREDENTIAL_LEASE_TTL_MS,
      });
      expect(deps.providerTurn.claudeSubscriptionCore).toEqual({
        identity,
        connectionId: "connection-core",
        placedRefreshGeneration: 4,
        personal: false,
      });
      expect(deps.providerTurn.codexSubscriptionCore).toBeNull();
      expect(deps.providerTurn.xaiSubscriptionCore).toBeNull();
      expect(deps.providerTurn.effectiveClaudeCredentialId).toBe("connection-core");
      expect(deps.providerTurn.effectiveClaudeCredentialVersion).toBeNull();
      expect(deps.providerTurn.claudeRotationEnabled).toBe(false);
      expect(deps.providerTurn.claudeAuthoritySnapshot).toBeNull();
      expect(deps.providerTurn.claudeUpstreamModelId).toBe("claude-sonnet-5");
      expect(deps.leases.claude.subscriptionCoreConnection).toBe("connection-core");
      expect(deps.leases.claude.subjectId).toBeNull();
      expect(deps.leases.claude.generation).toBe(3);
      expect(deps.leases.claude.held).toBe(true);
      expect(legacy).not.toHaveBeenCalled();
      expect(legacyLease).not.toHaveBeenCalled();
    } finally {
      deps.leases.claude.stopHeartbeat();
    }
  });

  test("a core wait is a terminal capacity failure until the Claude waits exist", async () => {
    route("core");
    spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
    const arm = spy(db, "armSubscriptionCoreCapacityWait");
    coreTurns({
      kind: "wait",
      reason: "all_accounts_exhausted",
      earliestResetAt: null,
      healthRetryAt: null,
      explicitConnectionId: null,
    } as unknown as db.SubscriptionCorePlacement);
    const deps = capacityDeps();
    await expect(selectClaudeTurnCapacityByRoute(deps)).rejects.toMatchObject({
      payload: { code: "subscription_capacity_unavailable" },
    });
    expect(arm).not.toHaveBeenCalled();
    expect(deps.leases.claude.held).toBe(false);
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
    expect(await selectClaudeTurnCapacityByRoute(deps)).toEqual({
      exit: { status: "idle", deferredUntilWake: true, turnId: "turn-1" },
    });
    expect(JSON.stringify(settled)).toContain('"requestPreserved":true');
  });
});

function credential(token: string) {
  return {
    version: 1,
    token,
    identity: { accountUuid: "account-uuid", organizationUuid: "organization-uuid" },
  } as unknown as db.SubscriptionCoreClaudeTokenSnapshot["credential"];
}

/** A placed core turn with a held core lease and scripted request custody. */
function placedCore(options: { fence?: () => Promise<void>; refreshAdvances?: boolean } = {}) {
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
  let current = { credential: credential("sk-ant-oat01-core"), credentialVersion: 4 };
  const resolverInputs: unknown[] = [];
  spy(db, "buildSubscriptionCoreClaudeTokenResolver").mockImplementation(((...args: unknown[]) => {
    resolverInputs.push(args);
    return {
      getToken: async () => current,
      refresh: async () => {
        refreshes += 1;
        if (options.refreshAdvances !== false)
          current = { credential: credential("sk-ant-oat01-fresh"), credentialVersion: 5 };
        return current;
      },
    };
  }) as never);
  const turnLeases = leases();
  const lease = turnLeases.claude;
  lease.holderId = "claude-turn:session-1:turn-1";
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
  const authorization = buildClaudeCoreRequestAuthorization({
    db: {} as db.Database,
    settings: testSettings({ claudeSubscriptionEnabled: true }),
    core,
    lease,
    execution: { attemptId: "attempt-1", executionGeneration: 3 },
  });
  return { order, core, lease, authorization, refreshes: () => refreshes, resolverInputs };
}

function sse(...items: Array<[string, unknown]>): Response {
  return new Response(
    items.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const answered = () =>
  sse(
    ["message_start", { type: "message_start" }],
    ["content_block_start", { type: "content_block_start", index: 0 }],
    ["content_block_delta", { type: "content_block_delta", index: 0 }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }],
    ["message_stop", { type: "message_stop" }],
  );

function send(
  placed: ReturnType<typeof placedCore>,
  responses: Array<() => Response>,
  options: { lane?: "requests" | "titleRequests"; prefix?: string; providerId?: string } = {},
) {
  let call = 0;
  let sequence = 0;
  const sent: Array<{ authorization: string | null; apiKey: string | null; body: string }> = [];
  const providerId = options.providerId ?? PROVIDER_ID;
  const fetcher = instrumentedModelFetch(providerId, (async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const headers = new Headers(init?.headers);
    sent.push({
      authorization: headers.get("authorization"),
      apiKey: headers.get("x-api-key"),
      body: String(init?.body),
    });
    const next = responses[call++];
    if (!next) throw new Error("unexpected provider call");
    return next();
  }) as typeof fetch);
  const lane = placed.core[options.lane ?? "requests"]!;
  const response = withClaudeUsageObserver(
    () => undefined,
    () =>
      fetcher(MESSAGES_URL, {
        method: "POST",
        headers: { "x-api-key": "placeholder" },
        body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
      }),
    claudeCoreRequestPreparer({
      authorization: placed.authorization,
      lane,
      mainLane: (options.lane ?? "requests") === "requests",
      nextRequestId: () => `${options.prefix ?? "attempt-1:1:1:claude"}:${++sequence}`,
      providerIds: new Set([PROVIDER_ID]),
    }),
  );
  return { response, calls: () => call, sent };
}

describe("Claude request custody on the core", () => {
  test("the bearer comes from the core resolver for the exact turn and lease", async () => {
    const placed = placedCore();
    expect(await placed.authorization.getToken()).toEqual({
      credential: credential("sk-ant-oat01-core"),
      credentialVersion: 4,
    });
    // Obtaining a bearer moves no refusal fence: only an admitted main-lane request does.
    expect(placed.core.credentialVersion).toBeUndefined();
    expect((placed.resolverInputs[0] as unknown[])[2]).toEqual(identity);
    expect((placed.resolverInputs[0] as unknown[])[3]).toEqual({
      connectionId: "connection-core",
      holderId: "claude-turn:session-1:turn-1",
      generation: 3,
    });
  });

  test("each physical request is fenced and reserved before network I/O and settled once", async () => {
    const placed = placedCore();
    const sent = send(placed, [answered]);
    await (await sent.response).text();
    expect(sent.sent).toEqual([
      {
        authorization: "Bearer sk-ant-oat01-core",
        apiKey: null,
        body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
      },
    ]);
    expect(placed.order).toEqual(["fence", "reserve:attempt-1:1:1:claude:1:1"]);
    // The refusal settlement fences on the generation the admitted main-lane bearer carried.
    expect(placed.core.credentialVersion).toBe(4);
    // A completed response is settled only after the history checkpoint.
    await placed.core.requests!.checkpoint();
    expect(placed.order.at(-1)).toBe("settle:operation-1:response_received");
    expect(placed.core.requests!.canRecover()).toBe(true);
  });

  test("a 401 forces one refresh and retries the same request as a new reservation when the generation advanced", async () => {
    const placed = placedCore();
    const sent = send(placed, [
      () => new Response(JSON.stringify({ type: "error" }), { status: 401 }),
      answered,
    ]);
    await (await sent.response).text();
    expect(sent.calls()).toBe(2);
    expect(placed.refreshes()).toBe(1);
    expect(sent.sent.map((request) => request.authorization)).toEqual([
      "Bearer sk-ant-oat01-core",
      "Bearer sk-ant-oat01-fresh",
    ]);
    expect(sent.sent[1]!.body).toBe(sent.sent[0]!.body);
    expect(placed.order).toEqual([
      "fence",
      "reserve:attempt-1:1:1:claude:1:1",
      "settle:operation-1:refused",
      "fence",
      "reserve:attempt-1:1:1:claude:1:2",
    ]);
    expect(placed.core.credentialVersion).toBe(5);
    await placed.core.requests!.checkpoint();
    expect(placed.order.at(-1)).toBe("settle:operation-2:response_received");
  });

  test("a refresh that does not advance the generation surfaces the 401 on the same connection", async () => {
    const placed = placedCore({ refreshAdvances: false });
    const sent = send(placed, [() => new Response("{}", { status: 401 })]);
    expect((await sent.response).status).toBe(401);
    expect(sent.calls()).toBe(1);
    expect(placed.refreshes()).toBe(1);
    expect(placed.order).toEqual([
      "fence",
      "reserve:attempt-1:1:1:claude:1:1",
      "settle:operation-1:refused",
    ]);
  });

  test("the attempt's one forced refresh is never repeated", async () => {
    const placed = placedCore();
    const first = send(placed, [
      () => new Response("{}", { status: 401 }),
      () => new Response("{}", { status: 401 }),
    ]);
    // The retried request was refused too: it surfaces, with no third send.
    expect((await first.response).status).toBe(401);
    expect(first.calls()).toBe(2);
    const second = send(placed, [() => new Response("{}", { status: 401 })], {
      prefix: "attempt-1:1:2:claude",
    });
    expect((await second.response).status).toBe(401);
    expect(second.calls()).toBe(1);
    expect(second.sent[0]!.authorization).toBe("Bearer sk-ant-oat01-fresh");
    expect(placed.refreshes()).toBe(1);
  });

  test("an overload (529) is a refusal on the same connection: no refresh, no retry here", async () => {
    const placed = placedCore();
    const sent = send(placed, [
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), {
          status: 529,
        }),
    ]);
    expect((await sent.response).status).toBe(529);
    expect(placed.refreshes()).toBe(0);
    expect(placed.order).toEqual([
      "fence",
      "reserve:attempt-1:1:1:claude:1:1",
      "settle:operation-1:refused",
    ]);
    expect(placed.core.requests!.canRecover()).toBe(true);
  });

  test("an HTTP 200 error event before any content is a refusal", async () => {
    const placed = placedCore();
    const sent = send(placed, [
      () =>
        sse(
          ["message_start", { type: "message_start" }],
          ["error", { type: "error", error: { type: "overloaded_error" } }],
        ),
    ]);
    await (await sent.response).text();
    expect(placed.order).toEqual([
      "fence",
      "reserve:attempt-1:1:1:claude:1:1",
      "settle:operation-1:refused",
    ]);
  });

  test("an unknown outcome is settled unknown and never replayed", async () => {
    const placed = placedCore();
    const dropped = send(placed, [() => new Response("gateway timeout", { status: 504 })]);
    expect((await dropped.response).status).toBe(504);
    expect(placed.order).toEqual([
      "fence",
      "reserve:attempt-1:1:1:claude:1:1",
      "settle:operation-1:unknown",
    ]);
    expect(placed.core.requests!.hasUnknownOutcome()).toBe(true);
    expect(placed.core.requests!.canRecover()).toBe(false);
    expect(claudeCoreRequestOutcomeUnknown(new Error("plain"), placed.core)).toMatchObject({
      code: "subscription_core_request_outcome_unknown",
    });
    // A later request in the same attempt is refused locally before network I/O.
    const replay = send(placed, [answered], { prefix: "attempt-1:1:1:claude-again" });
    await expect(replay.response).rejects.toMatchObject({
      code: "subscription_core_request_outcome_unknown",
    });
    expect(replay.calls()).toBe(0);
  });

  test("a stream cut after content began is unknown", async () => {
    const placed = placedCore();
    const sent = send(placed, [
      () =>
        sse(
          ["message_start", { type: "message_start" }],
          ["content_block_start", { type: "content_block_start", index: 0 }],
          ["error", { type: "error", error: { type: "api_error" } }],
        ),
    ]);
    await (await sent.response).text();
    expect(placed.order.at(-1)).toBe("settle:operation-1:unknown");
    expect(claudeCoreRequestOutcomeUnknown(new Error("plain"), placed.core)).not.toBeNull();
  });

  test("a lost core lease stops dispatch before any reservation", async () => {
    const lost = Object.assign(new Error("lease lost"), { code: "claude_credential_lease_lost" });
    const placed = placedCore({
      fence: async () => {
        throw lost;
      },
    });
    const sent = send(placed, [answered]);
    await expect(sent.response).rejects.toBe(lost);
    expect(sent.calls()).toBe(0);
    expect(placed.order).toEqual(["fence"]);
  });

  test("session-title requests use their own custody lane under the same fence", async () => {
    const placed = placedCore();
    expect(placed.core.titleRequests).toBeDefined();
    expect(placed.core.titleRequests).not.toBe(placed.core.requests);
    const dropped = send(placed, [() => new Response("timeout", { status: 504 })], {
      lane: "titleRequests",
      prefix: "attempt-1:1:1:claude:title",
    });
    await dropped.response;
    expect(placed.order).toEqual([
      "fence",
      "reserve:attempt-1:1:1:claude:title:1:1",
      "settle:operation-1:unknown",
    ]);
    expect(placed.core.titleRequests!.hasUnknownOutcome()).toBe(true);
    expect(placed.core.requests!.hasUnknownOutcome()).toBe(false);
    // Either lane's unknown outcome ends the turn without a replay.
    expect(claudeCoreRequestOutcomeUnknown(new Error("plain"), placed.core)).not.toBeNull();
  });

  test("a session-title request, even one renewed after a 401, never moves the main lane's refusal fence", async () => {
    const placed = placedCore();
    const main = send(placed, [answered]);
    await (await main.response).text();
    expect(placed.core.credentialVersion).toBe(4);
    const title = send(placed, [() => new Response("{}", { status: 401 }), answered], {
      lane: "titleRequests",
      prefix: "attempt-1:1:1:claude:title",
    });
    await (await title.response).text();
    expect(title.sent.map((request) => request.authorization)).toEqual([
      "Bearer sk-ant-oat01-core",
      "Bearer sk-ant-oat01-fresh",
    ]);
    expect(placed.core.credentialVersion).toBe(4);
  });

  test("a request to another provider passes through without custody", async () => {
    const placed = placedCore();
    const sent = send(placed, [() => new Response("ok")], { providerId: "openai" });
    expect(await (await sent.response).text()).toBe("ok");
    expect(sent.sent[0]!.authorization).toBeNull();
    expect(placed.order).toEqual([]);
  });
});

describe("Claude response inspection", () => {
  const chunks = (inspector: ReturnType<typeof claudeResponseInspector>, text: string) => {
    const bytes = new TextEncoder().encode(text);
    // Split mid-line: event names are read across chunk boundaries.
    inspector.chunk(bytes.slice(0, 9));
    inspector.chunk(bytes.slice(9));
  };
  const streamed = () =>
    new Response(null, { headers: { "content-type": "text/event-stream; charset=utf-8" } });

  test("a final message delta is a response even when the reader stops right after it", () => {
    const inspector = claudeResponseInspector(streamed());
    chunks(inspector, "event: content_block_start\ndata: {}\n\nevent: message_delta\ndata: {}\n\n");
    expect(inspector.outcome(false)).toBe("response_received");
  });

  const error = (type: string) =>
    `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message: "x" } })}\n\n`;

  test("an overload or rate-limit error event before any content is refused; after content it is unknown", () => {
    for (const type of ["overloaded_error", "rate_limit_error"]) {
      const refused = claudeResponseInspector(streamed());
      chunks(refused, `event: message_start\ndata: {}\n\n${error(type)}`);
      expect(refused.outcome(true)).toBe("refused");
      const cut = claudeResponseInspector(streamed());
      chunks(cut, `event: content_block_start\ndata: {}\n\n${error(type)}`);
      expect(cut.outcome(true)).toBe("unknown");
    }
  });

  test("any other stream error, or one without a readable type, is unknown", () => {
    for (const body of [
      error("timeout_error"),
      error("conflict_error"),
      error("api_error"),
      "event: error\ndata: {}\n\n",
      "event: error\ndata: not json\n\n",
    ]) {
      const inspector = claudeResponseInspector(streamed());
      chunks(inspector, `event: message_start\ndata: {}\n\n${body}`);
      expect(inspector.outcome(true)).toBe("unknown");
    }
  });

  test("a stream that ends without a final event is unknown; a plain body is a response once it ends", () => {
    const ended = claudeResponseInspector(streamed());
    chunks(ended, "event: message_start\ndata: {}\n\n");
    expect(ended.outcome(true)).toBe("unknown");
    const plain = claudeResponseInspector(new Response("{}"));
    expect(plain.outcome(true)).toBe("response_received");
    expect(plain.outcome(false)).toBe("unknown");
  });
});

describe("Claude model scope and provider ids", () => {
  test("the scope follows the product model's own prefix", () => {
    expect(claudeCoreModelScope("organization-claude-subscription/claude-sonnet-5")).toBe(
      "organization",
    );
    expect(claudeCoreModelScope("workspace-claude-subscription/claude-sonnet-5")).toBe("workspace");
    expect(claudeCoreModelScope("supergrok/grok-4")).toBe("organization");
    // A workspace-scoped model runs on organization connections on the core,
    // so workspace policy must allow it under both identities.
    expect(
      db.subscriptionCoreClaudeModelPolicyProviderIds(
        "workspace-claude-subscription/claude-sonnet-5",
      ),
    ).toEqual(["workspace-claude-subscription", "organization-claude-subscription"]);
    expect(db.subscriptionCoreClaudeModelPolicyProviderIds("supergrok/grok-4")).toEqual([
      "organization-claude-subscription",
    ]);
  });

  test("only the Claude subscription providers of the catalog carry core custody", () => {
    const provider = (id: string, kind: string) => ({
      id,
      kind,
      api: "anthropic-messages",
      apiKey: "sk-ant-api03-fixture",
      baseUrl: "https://api.anthropic.com",
      models: [{ id: `${id}/claude-sonnet-5`, upstreamModelId: "claude-sonnet-5" }],
    });
    const ids = claudeSubscriptionProviderIds({
      modelProvidersJson: JSON.stringify([
        provider("workspace-claude-subscription", "claude-subscription-workspace"),
        provider("organization-claude-subscription", "claude-subscription-organization"),
        provider("organization-anthropic", "anthropic-organization"),
      ]),
    });
    expect([...ids].toSorted()).toEqual([
      "organization-claude-subscription",
      "workspace-claude-subscription",
    ]);
  });
});

test("no Claude turn on the legacy route touches durable events through the core", async () => {
  route("legacy");
  const publish = spy(events, "publishDurableSessionEvents");
  spy(legacyCapacity, "selectClaudeTurnCapacity").mockResolvedValue({ ok: true });
  await selectClaudeTurnCapacityByRoute(capacityDeps());
  expect(publish).not.toHaveBeenCalled();
});

test("a core-placed Claude turn is the turn's placement for attribution, checkpoints and revalidation", async () => {
  const core: SubscriptionCoreTurn = {
    identity,
    connectionId: "connection-core",
    placedRefreshGeneration: 4,
    personal: false,
  };
  const providerTurn = {
    codexSubscriptionCore: null,
    xaiSubscriptionCore: null,
    claudeSubscriptionCore: core,
  };
  expect(subscriptionCoreTurnOf(providerTurn)).toBe(core);
  expect(placedSubscriptionCore(providerTurn)).toMatchObject({ core, provider: { id: "claude" } });
  // The legacy connection check never receives a core connection id.
  const legacyCheck = spy(db, "assertModelConnectionAllowsTurn");
  await assertTurnModelConnection({} as db.Database, providerTurn, {
    workspaceId: "workspace-1",
    subjectId: "user:owner",
    modelId: PRODUCT_MODEL,
    codexCredentialId: null,
    xaiCredentialId: null,
    claudeCredentialId: "connection-core",
    claudeAuthoritySnapshot: null,
  } as never);
  expect(legacyCheck).not.toHaveBeenCalled();
});

describe("Claude custody edge paths on the core", () => {
  test("the settings credential keeps the account identity with the placeholder bearer only", () => {
    const accountIdentity = {
      accountUuid: "10000000-0000-4000-8000-000000000001",
      deviceId: "a".repeat(64),
    };
    const live = {
      credential: {
        version: 1,
        token: "sk-ant-oat01-live-secret",
        identity: accountIdentity,
        oauth: {
          refreshToken: "refresh-secret",
          expiresAt: "2026-10-12T00:00:00.000Z",
          scopes: ["user:inference"],
        },
      } as unknown as db.SubscriptionCoreClaudeTokenSnapshot["credential"],
      credentialVersion: 7,
    } as db.SubscriptionCoreClaudeTokenSnapshot;
    const connectionId = "20000000-0000-4000-8000-000000000002";
    const serialized = claudeCoreSettingsCredential(live, connectionId);
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      token: claudeCoreSettingsPlaceholderToken(connectionId, 7),
      identity: accountIdentity,
    });
    expect(JSON.parse(serialized).token).toStartWith(CLAUDE_CORE_SETTINGS_PLACEHOLDER_TOKEN);
    expect(serialized).not.toContain("live-secret");
    expect(serialized).not.toContain("refresh-secret");
    const settings = withClaudeConnectionCredential(
      withClaudeConnectionCatalog(
        testSettings({ claudeSubscriptionEnabled: true }),
        { claude_subscription: { models: [{ upstreamModelId: "claude-opus-5-5" }] } },
        "organization",
      ),
      "claude_subscription",
      serialized,
      "organization",
      { connectionId, credentialVersion: 7 },
    );
    // The settings accept it as a strict Claude subscription credential and
    // map only the placeholder bearer and the account identity.
    const parsed = parseModelProvidersJson(settings.modelProvidersJson);
    const mapped = parsed.find((provider) => provider.id === "organization-claude-subscription");
    expect(mapped?.apiKey).toBe(claudeCoreSettingsPlaceholderToken(connectionId, 7));
    expect(mapped?.anthropic?.identity).toEqual(accountIdentity);
    expect(mapped?.anthropic?.credentialBinding).toEqual({
      connectionId,
      credentialVersion: 7,
    });
    const providers = JSON.stringify(parsed);
    expect(providers).not.toContain("live-secret");
    expect(providers).not.toContain("refresh-secret");
  });

  test("connections without an account UUID keep separate web-search scopes on the core", () => {
    // A setup-token account has no UUID, so a stored hosted search is scoped
    // by the settings' key: one shared placeholder would replay one
    // account's encrypted results to another, which Anthropic rejects.
    const scopeOf = (connectionId: string, credentialVersion: number) => {
      const snapshot = {
        credential: {
          version: 1,
          token: "sk-ant-oat01-live-secret",
          identity: { accountUuid: "", deviceId: "b".repeat(64) },
        },
        credentialVersion,
      } as unknown as db.SubscriptionCoreClaudeTokenSnapshot;
      const settings = withClaudeConnectionCredential(
        withClaudeConnectionCatalog(
          testSettings({ claudeSubscriptionEnabled: true }),
          { claude_subscription: { models: [{ upstreamModelId: "claude-opus-5-5" }] } },
          "organization",
        ),
        "claude_subscription",
        claudeCoreSettingsCredential(snapshot, connectionId),
        "organization",
        { connectionId, credentialVersion },
      );
      const mapped = parseModelProvidersJson(settings.modelProvidersJson).find(
        (provider) => provider.id === "organization-claude-subscription",
      )!;
      return anthropicSearchAccountScope(mapped);
    };
    const a = "20000000-0000-4000-8000-00000000000a";
    const b = "20000000-0000-4000-8000-00000000000b";
    expect(scopeOf(a, 3)).toStartWith("credential:");
    // Different connections never share a scope, so a search from one reaches
    // the other as readable facts (the runtime's cross-account replay).
    expect(scopeOf(a, 3)).not.toBe(scopeOf(b, 3));
    // The same connection at the same version replays natively.
    expect(scopeOf(a, 3)).toBe(scopeOf(a, 3));
    // A refresh, like a rotated live token on the legacy path, only costs a
    // readable replay.
    expect(scopeOf(a, 4)).not.toBe(scopeOf(a, 3));
  });

  const claudeProvider: ResolvedModelProvider = {
    id: PROVIDER_ID,
    label: "Claude",
    kind: "api-key",
    api: "anthropic-messages",
    wireProfile: "openai",
    builtin: false,
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-ant-oat01-opengeni-core-custody-only",
    credentialSource: { kind: "deployment", mechanism: "api_key" },
    billing: { upstreamPayer: "deployment", metering: "external" },
  };
  const message = (id: string, text: string, stop: string) => ({
    id,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const streamed = (id: string, text: string, stop: string) =>
    sse(
      [
        "message_start",
        {
          type: "message_start",
          message: { ...message(id, "", ""), content: [], stop_reason: null },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
      ],
      ["message_stop", { type: "message_stop" }],
    );
  const modelRequest = {
    input: "Search",
    systemInstructions: "Instructions",
    modelSettings: {},
    tools: [],
    handoffs: [],
    outputType: "text",
    tracing: false,
  } as never;
  // The production subscription provider: OAuth auth with the settings'
  // placeholder bearer (`claudeCoreSettingsCredential`).
  const oauthProvider: ResolvedModelProvider = {
    ...claudeProvider,
    apiKey: claudeCoreSettingsPlaceholderToken("20000000-0000-4000-8000-000000000002", 4),
    anthropic: {
      auth: "oauth",
      identity: { accountUuid: "10000000-0000-4000-8000-000000000001", deviceId: "a".repeat(64) },
      cacheTtl: "5m",
      maxOutputTokens: 32000,
      streamIdleTimeoutMs: 600000,
    },
  };
  function model(
    placed: ReturnType<typeof placedCore>,
    responses: Array<() => Response>,
    provider: ResolvedModelProvider = claudeProvider,
  ) {
    let call = 0;
    let sequence = 0;
    const sent: Headers[] = [];
    const fetcher = instrumentedModelFetch(PROVIDER_ID, (async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      sent.push(new Headers(init?.headers));
      const next = responses[call++];
      if (!next) throw new Error("unexpected provider call");
      return next();
    }) as typeof fetch);
    const claude = new AnthropicMessagesModel(provider, "claude-sonnet-5", fetcher);
    const custody = <T>(fn: () => Promise<T>) =>
      withClaudeUsageObserver(
        () => undefined,
        fn,
        claudeCoreRequestPreparer({
          authorization: placed.authorization,
          lane: placed.core.requests!,
          mainLane: true,
          nextRequestId: () => `attempt-1:1:1:claude:${++sequence}`,
          providerIds: new Set([PROVIDER_ID]),
        }),
      );
    return { claude, custody, calls: () => call, sent };
  }

  test("an OAuth subscription request and its continuation leave with the live bearer, never the placeholder", async () => {
    const placed = placedCore();
    const { claude, custody, calls, sent } = model(
      placed,
      [
        () => Response.json(message("msg_1", "Searching.", "pause_turn")),
        () => Response.json(message("msg_2", "Done.", "end_turn")),
      ],
      oauthProvider,
    );
    await custody(() => claude.getResponse(modelRequest));
    expect(calls()).toBe(2);
    expect(sent).toHaveLength(2);
    for (const headers of sent) {
      expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-core");
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
      expect([...headers.values()].join("\n")).not.toContain(
        CLAUDE_CORE_SETTINGS_PLACEHOLDER_TOKEN,
      );
    }
  });

  test("a paused search continues as its own reservation; both settle once at the checkpoint", async () => {
    const placed = placedCore();
    const { claude, custody, calls } = model(placed, [
      () => Response.json(message("msg_1", "Searching.", "pause_turn")),
      () => Response.json(message("msg_2", "Done.", "end_turn")),
    ]);
    await custody(() => claude.getResponse(modelRequest));
    expect(calls()).toBe(2);
    expect(placed.order).toEqual([
      "fence",
      "reserve:attempt-1:1:1:claude:1:1",
      "fence",
      "reserve:attempt-1:1:1:claude:2:1",
    ]);
    expect(placed.core.requests!.canRecover()).toBe(false);
    await placed.core.requests!.checkpoint();
    expect(placed.order.slice(4)).toEqual([
      "settle:operation-1:response_received",
      "settle:operation-2:response_received",
    ]);
    expect(placed.core.requests!.canRecover()).toBe(true);
    expect(placed.core.requests!.hasUnknownOutcome()).toBe(false);
  });

  test("a streamed paused search continues the same way", async () => {
    const placed = placedCore();
    const { claude, custody, calls } = model(placed, [
      () => streamed("msg_1", "Searching.", "pause_turn"),
      () => streamed("msg_2", "Done.", "end_turn"),
    ]);
    await custody(async () => {
      for await (const _event of claude.getStreamedResponse(modelRequest));
    });
    expect(calls()).toBe(2);
    await placed.core.requests!.checkpoint();
    expect(placed.order.filter((step) => step.startsWith("settle:"))).toEqual([
      "settle:operation-1:response_received",
      "settle:operation-2:response_received",
    ]);
    expect(placed.core.requests!.canRecover()).toBe(true);
  });

  test("no further request is admitted after a response without its final event", async () => {
    const placed = placedCore();
    const first = send(placed, [
      () =>
        sse(
          ["message_start", { type: "message_start" }],
          ["content_block_start", { type: "content_block_start", index: 0 }],
        ),
    ]);
    await (await first.response).text();
    expect(placed.core.requests!.hasUnknownOutcome()).toBe(true);
    const second = send(placed, [answered], { prefix: "attempt-1:1:1:claude:next" });
    await expect(second.response).rejects.toMatchObject({
      code: "subscription_core_request_outcome_unknown",
    });
    expect(second.calls()).toBe(0);
  });

  // The continuation rule only admits a further reservation once every
  // pending request has its response: Claude's main lane stays sequential.
  test("a request still waiting for its response blocks the next reservation", async () => {
    const placed = placedCore();
    const lane = placed.core.requests!;
    await lane.reserve({ requestId: "attempt-1:1:1:claude:1", transportAttempt: 1 });
    await expect(
      lane.reserve({ requestId: "attempt-1:1:1:claude:2", transportAttempt: 1 }),
    ).rejects.toMatchObject({ code: "subscription_core_request_outcome_unknown" });
    expect(placed.order).toEqual(["reserve:attempt-1:1:1:claude:1:1"]);
  });

  test("after a response, a second request in flight blocks a third; the checkpoint settles both once", async () => {
    const placed = placedCore();
    const lane = placed.core.requests!;
    const first = { requestId: "attempt-1:1:1:claude:1", transportAttempt: 1 };
    const second = { requestId: "attempt-1:1:1:claude:2", transportAttempt: 1 };
    await lane.reserve(first);
    await lane.observe({ ...first, outcome: "response_received" });
    await lane.reserve(second);
    await expect(
      lane.reserve({ requestId: "attempt-1:1:1:claude:3", transportAttempt: 1 }),
    ).rejects.toMatchObject({ code: "subscription_core_request_outcome_unknown" });
    expect(placed.order.filter((step) => step.startsWith("reserve:"))).toHaveLength(2);
    await lane.observe({ ...second, outcome: "response_received" });
    await lane.checkpoint();
    await lane.checkpoint();
    expect(placed.order.filter((step) => step.startsWith("settle:"))).toEqual([
      "settle:operation-1:response_received",
      "settle:operation-2:response_received",
    ]);
    expect(lane.canRecover()).toBe(true);
  });

  test("the session-title lane never continues after a response", async () => {
    const placed = placedCore();
    const lane = placed.core.titleRequests!;
    const first = { requestId: "attempt-1:1:1:claude:title:1", transportAttempt: 1 };
    await lane.reserve(first);
    await lane.observe({ ...first, outcome: "response_received" });
    await expect(
      lane.reserve({ requestId: "attempt-1:1:1:claude:title:2", transportAttempt: 1 }),
    ).rejects.toMatchObject({ code: "subscription_core_request_outcome_unknown" });
  });

  test("a refused request whose settle write failed blocks the next reservation", async () => {
    const lane = createCoreSubscriptionRequests({
      reserve: async () => ({ operationId: "operation-1" }),
      settle: async () => {
        throw new Error("settle write failed");
      },
      displayName: "Claude",
      outcomeUnknown: () =>
        Object.assign(new Error("unknown"), { code: "subscription_core_request_outcome_unknown" }),
      isOutcomeUnknown: () => false,
      continuesAfterResponse: true,
    });
    const refused = { requestId: "attempt-1:1:1:claude:1", transportAttempt: 1 };
    await lane.reserve(refused);
    await expect(lane.observe({ ...refused, outcome: "refused" })).rejects.toThrow(
      "settle write failed",
    );
    await expect(
      lane.reserve({ requestId: "attempt-1:1:1:claude:2", transportAttempt: 1 }),
    ).rejects.toMatchObject({ code: "subscription_core_request_outcome_unknown" });
    expect(lane.canRecover()).toBe(false);
  });

  test("a body cancelled before its final event, or a read error, settles unknown", async () => {
    const cancelled = placedCore();
    const sent = send(cancelled, [
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ]);
    const body = (await sent.response).body!.getReader();
    await body.read();
    await body.cancel();
    expect(cancelled.order.at(-1)).toBe("settle:operation-1:unknown");
    expect(cancelled.core.requests!.hasUnknownOutcome()).toBe(true);

    const broken = placedCore();
    const failing = send(broken, [
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"));
              controller.error(new Error("socket reset"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ]);
    await expect((await failing.response).text()).rejects.toThrow("socket reset");
    expect(broken.order.at(-1)).toBe("settle:operation-1:unknown");
  });

  test("a renewal that fails cancels the refused body, surfaces the error and reserves nothing more", async () => {
    const placed = placedCore();
    spyOn(placed.authorization, "renewAfterUnauthorized").mockRejectedValue(
      new Error("refresh failed"),
    );
    let cancelled = false;
    const sent = send(placed, [
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 401 },
        ),
    ]);
    await expect(sent.response).rejects.toThrow("refresh failed");
    expect(cancelled).toBe(true);
    expect(sent.calls()).toBe(1);
    expect(placed.order).toEqual([
      "fence",
      "reserve:attempt-1:1:1:claude:1:1",
      "settle:operation-1:refused",
    ]);
  });
});
