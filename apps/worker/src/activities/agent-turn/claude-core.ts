/**
 * Claude on the shared subscription core (design 5.3, Claude track C1a): the
 * provider-neutral chat placement and request custody bound to Claude, and
 * the turn's route between the legacy Claude path and the core. Dormant: the
 * route is `core` only after the Claude drained cutover commits its receipt
 * (C3), and the binding is unregistered until then, so every core entry
 * point fails closed.
 */
import {
  buildSubscriptionCoreClaudeTokenResolver,
  CLAUDE_CREDENTIAL_LEASE_TTL_MS,
  CodexCredentialLeaseAttemptFencedError,
  decodeSubscriptionCoreClaudeQuota,
  readSubscriptionCoreProviderRoute,
  SUBSCRIPTION_CORE_CLAUDE,
  SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES,
  SubscriptionCoreError,
  subscriptionCoreClaudeModelPolicyProviderId,
  subscriptionCoreRequests,
  subscriptionCoreTurns,
  withRlsContext,
  type Database,
  type SubscriptionCoreClaudeTokenSnapshot,
  type SubscriptionCoreProvider,
} from "@opengeni/db";
import { parseClaudeUsageHeaders, parseModelProvidersJson, type Settings } from "@opengeni/config";
import type { PreparedUsageRequest } from "@opengeni/runtime";
import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";
import { subscriptionCoreCutoverDisabledFailure } from "./codex-core-errors";
import type { ClaudeTurnLease } from "./credential-leases";
import { classifyClaudeProviderError } from "./errors";
import {
  assertCoreSourceConnected,
  coreLeaseRef,
  guardCoreTokenResolver,
  parkCoreSubscriptionTurn,
  selectCoreSubscriptionTurnCapacity,
  type CoreTurnPlacementProvider,
} from "./subscription-core-capacity";
import {
  SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT,
  subscriptionCoreFailoverMetrics,
} from "./subscription-core-failover";
import {
  coreRequestOutcomeUnknownFailure,
  createCoreSubscriptionRequests,
  settleCoreResponse,
  type CoreResponseInspector,
  type CoreSubscriptionRequests,
} from "./subscription-core-requests";
import {
  finalizeCoreSubscriptionTurn,
  type CoreRefusalBinding,
} from "./subscription-core-settlement";
import type { SubscriptionCoreTurn } from "./turn-context";
import { subscriptionTurnLeaseHolderId } from "./subscription-lease";
import { selectClaudeTurnCapacity } from "./xai-capacity";
import {
  recoverCoreHealthAndWake,
  wakeSubscriptionCoreWaitersAndDeliver,
  type CoreCodexWakeServices,
} from "../subscription-core-codex-waits";
import { CLAUDE_CORE_WAIT_BINDING } from "../subscription-core-claude-waits";

const CLAUDE = SUBSCRIPTION_CORE_CLAUDE as SubscriptionCoreProvider;
const DISPLAY_NAME = "Claude";

const hasCoreCode = (error: unknown, code: string): boolean =>
  error instanceof SubscriptionCoreError && error.code === code;

/** Claude's chat placement on the shared core. */
export const CLAUDE_CORE_TURN_PROVIDER: CoreTurnPlacementProvider = {
  id: "claude",
  displayName: DISPLAY_NAME,
  startupPhaseProvider: "claude-subscription",
  leaseTtlMs: CLAUDE_CREDENTIAL_LEASE_TTL_MS,
  lease: (deps) => deps.leases.claude,
  place: (db, request) => subscriptionCoreTurns(CLAUDE).placeSubscriptionCoreTurn(db, request),
  // A recovery wakes the account's other Claude waiters too.
  recoverHealth: async ({ db, signalCodexCapacityWorkflow }, identity) => {
    await recoverCoreHealthAndWake(
      { db, signalCodexCapacityWorkflow },
      CLAUDE_CORE_WAIT_BINDING,
      identity,
    );
  },
  adopt: ({ providerTurn, turnExecutionPolicy }, core, placement) => {
    // A Claude rate limit cools the accepted model of the connection.
    core.productModelId = turnExecutionPolicy.productModelId;
    providerTurn.claudeSubscriptionCore = core;
    providerTurn.effectiveClaudeCredentialId = placement.connectionId;
    providerTurn.claudeUpstreamModelId = turnExecutionPolicy.upstreamModelId;
    // Rotation is the core's placement policy, never the legacy rotation,
    // and no legacy authority or credential version applies to the turn.
    providerTurn.claudeRotationEnabled = false;
    providerTurn.claudeAuthoritySnapshot = null;
    providerTurn.effectiveClaudeCredentialVersion = null;
  },
  // A wait parks the same turn on the durable core waiter (EP-T09).
  park: (deps, wait) =>
    parkCoreSubscriptionTurn(deps, wait, CLAUDE_CORE_WAIT_BINDING, DISPLAY_NAME),
  isSourceDisconnected: (db, identity, connectionId) =>
    subscriptionCoreRequests(CLAUDE).isSubscriptionCoreSourceDisconnected(
      db,
      identity,
      connectionId,
    ),
  sourceDisconnectedError: () => CLAUDE.errors.sourceDisconnected(),
  isAttemptFenced: (error) => error instanceof CodexCredentialLeaseAttemptFencedError,
};

/**
 * The Claude capacity phase by the organization's Claude route: `legacy`
 * runs the legacy selection unchanged (one added route read), `maintenance`
 * fails closed, `core` places on the shared core.
 */
export async function selectClaudeTurnCapacityByRoute(
  deps: CapacityPhaseDeps,
): Promise<CapacityPhaseOutcome> {
  if (!deps.billingState.isClaudeTurn) return { ok: true };
  const { input } = deps;
  const route = await withRlsContext(
    deps.db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    (scoped) =>
      readSubscriptionCoreProviderRoute(scoped, { accountId: input.accountId, provider: "claude" }),
  );
  if (route === "legacy") return await selectClaudeTurnCapacity(deps);
  if (route === "maintenance") throw subscriptionCoreCutoverDisabledFailure(DISPLAY_NAME);
  const turnId = deps.attempt.turnId;
  if (!turnId) throw new Error("Turn id was not initialized");
  deps.leases.claude.holderId ??= subscriptionTurnLeaseHolderId(
    "claude",
    DISPLAY_NAME,
    input,
    turnId,
  );
  return await selectCoreSubscriptionTurnCapacity(deps, CLAUDE_CORE_TURN_PROVIDER);
}

/** One attempt's Claude request custody on the core (unknown outcomes are never replayed). */
export function createCoreClaudeRequests(
  db: Database,
  core: SubscriptionCoreTurn,
  ref: { connectionId: string; holderId: string; generation: number },
  execution: { attemptId: string; executionGeneration: number },
) {
  const requests = subscriptionCoreRequests(CLAUDE);
  return createCoreSubscriptionRequests({
    reserve: (request) =>
      requests.reserveSubscriptionCoreRequest(db, core.identity, ref, { ...request, ...execution }),
    settle: (request) =>
      requests.settleSubscriptionCoreRequest(db, core.identity, ref, { ...request, ...execution }),
    displayName: DISPLAY_NAME,
    outcomeUnknown: () => CLAUDE.errors.requestOutcomeUnknown(),
    isOutcomeUnknown: (error) => hasCoreCode(error, "subscription_core_request_outcome_unknown"),
  });
}

export type ClaudeCoreRequestAuthorization = {
  /** The current bearer (the shared resolver refreshes a stale one first). */
  getToken: () => Promise<SubscriptionCoreClaudeTokenSnapshot>;
  /**
   * After a 401 on a bearer of `generation`: the turn's one forced refresh
   * under the connection's refresh lock, shared by every request of the
   * attempt, and its bearer only when the generation advanced past the
   * refused one (null: surface the refusal).
   */
  renewAfterUnauthorized: (
    generation: number,
  ) => Promise<SubscriptionCoreClaudeTokenSnapshot | null>;
  /** The dispatch fence every physical request passes before its reservation. */
  assertDispatch: () => Promise<void>;
  /**
   * A response's usage headers, made with a bearer of `generation`, as a
   * quota observation of the leased connection (`decodeQuota`), recorded in
   * order and best effort; `core.quota` joins them.
   */
  observeResponse: (response: Response, generation: number, upstreamModelId?: string) => void;
};

/**
 * Materialization and refresh for a core-placed Claude turn: the bearer comes
 * from the shared core resolver under the exact accepted turn and this
 * attempt's live core lease, and both request lanes (the agent's and the
 * session title's) are created on the turn. `upstreamModelIds` lists the
 * deployment's Claude models, so a family limit in a response's usage
 * headers cools each of them.
 */
export function buildClaudeCoreRequestAuthorization(input: {
  db: Database;
  settings: Settings;
  core: SubscriptionCoreTurn;
  lease: ClaudeTurnLease;
  execution: { attemptId: string; executionGeneration: number };
  upstreamModelIds: readonly string[];
}): ClaudeCoreRequestAuthorization {
  const { db, core, lease } = input;
  const ref = coreLeaseRef(lease, core, DISPLAY_NAME);
  core.requests = createCoreClaudeRequests(db, core, ref, input.execution);
  core.titleRequests = createCoreClaudeRequests(db, core, ref, input.execution);
  const resolver = guardCoreTokenResolver(
    db,
    CLAUDE_CORE_TURN_PROVIDER,
    core,
    lease,
    buildSubscriptionCoreClaudeTokenResolver(db, input.settings, core.identity, ref),
    (error) => hasCoreCode(error, "subscription_core_lease_lost"),
  );
  // The refusal settlement fences its quota write on the generation the
  // refused bearer carried.
  const carried = (token: SubscriptionCoreClaudeTokenSnapshot) => {
    core.credentialVersion = token.credentialVersion;
    return token;
  };
  let forced: Promise<SubscriptionCoreClaudeTokenSnapshot> | null = null;
  let observed: Promise<boolean> = Promise.resolve(false);
  core.quota = { settled: () => observed };
  return {
    getToken: async () => carried(await resolver.getToken()),
    renewAfterUnauthorized: async (generation) => {
      forced ??= resolver.refresh();
      const token = await forced;
      return token.credentialVersion > generation ? carried(token) : null;
    },
    assertDispatch: async () => {
      await assertCoreSourceConnected(db, CLAUDE_CORE_TURN_PROVIDER, core);
      await lease.assertCurrentForDispatch();
    },
    observeResponse: (response, generation, upstreamModelId) => {
      const observation = parseClaudeUsageHeaders(response.headers, new Date(), upstreamModelId);
      if (!observation) return;
      const quota = {
        ...decodeSubscriptionCoreClaudeQuota({
          observation,
          refreshGeneration: generation,
          upstreamModelIds: input.upstreamModelIds,
        }),
        revision: 0,
      };
      observed = observed.then(async (recovered) => {
        const applied = await subscriptionCoreTurns(CLAUDE)
          .applySubscriptionCoreQuotaObservation(db, core.identity, ref, quota)
          .catch(() => ({ applied: false, recovered: false }));
        return recovered || applied.recovered;
      });
    },
  };
}

/** The scope a Claude product model id names (its prefix). */
export function claudeCoreModelScope(productModelId: string): "organization" | "workspace" {
  return subscriptionCoreClaudeModelPolicyProviderId(productModelId) ===
    SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES[0]
    ? "organization"
    : "workspace";
}

/** The upstream model ids of the deployment's Claude subscription catalog. */
export function claudeSubscriptionUpstreamModelIds(
  settings: Pick<Settings, "modelProvidersJson">,
): string[] {
  return [
    ...new Set(
      parseModelProvidersJson(settings.modelProvidersJson)
        .filter(
          (provider) =>
            provider.kind === "claude-subscription-workspace" ||
            provider.kind === "claude-subscription-organization",
        )
        .flatMap((provider) => provider.models.map((model) => model.upstreamModelId ?? model.id)),
    ),
  ];
}

/** The Claude subscription provider ids of the deployment's catalog. */
export function claudeSubscriptionProviderIds(
  settings: Pick<Settings, "modelProvidersJson">,
): ReadonlySet<string> {
  return new Set(
    parseModelProvidersJson(settings.modelProvidersJson)
      .filter(
        (provider) =>
          provider.kind === "claude-subscription-workspace" ||
          provider.kind === "claude-subscription-organization",
      )
      .map((provider) => provider.id),
  );
}

const SSE_EVENT = /^event:\s*(\S+)/;

/**
 * The outcome of a streamed Claude response, read from its event names as
 * the body passes: a `message_delta` (the model's final stop reason) or
 * `message_stop` means the model answered, even when the reader stops right
 * after it; an `error` event before any content block is a refusal (an
 * overload or limit the provider reported with HTTP 200); anything else
 * that ends or stops early is unknown. A body that is not a stream is a
 * response once it ends.
 */
export function claudeResponseInspector(response: Response): CoreResponseInspector {
  const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const decoder = new TextDecoder();
  let pending = "";
  let content = false;
  let answered = false;
  let failed = false;
  return {
    chunk(bytes) {
      if (!streamed || answered) return;
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const event = SSE_EVENT.exec(line.trim())?.[1];
        if (!event) continue;
        if (event === "message_delta" || event === "message_stop") answered = true;
        else if (event.startsWith("content_block_")) content = true;
        else if (event === "error") failed = true;
      }
    },
    outcome(ended) {
      if (!streamed) return ended ? "response_received" : "unknown";
      if (answered) return "response_received";
      return failed && !content ? "refused" : "unknown";
    },
  };
}

/**
 * The Anthropic transport's per-request preparation for a core-placed Claude
 * turn (through `withClaudeUsageObserver`): each physical request carries the
 * core bearer, is fenced and reserved on its lane as the last step before the
 * fetch, and settles from its response. A 401 renews the bearer through the
 * turn's one forced refresh and retries the same request on the same
 * connection as a new reservation, only when the generation advanced.
 * `observe` receives every response with the generation of the bearer that
 * made it (its usage headers become quota observations of the connection).
 */
export function claudeCoreRequestPreparer(input: {
  authorization: ClaudeCoreRequestAuthorization;
  lane: CoreSubscriptionRequests;
  nextRequestId: () => string;
  providerIds: ReadonlySet<string>;
  observe?: (response: Response, generation: number, upstreamModelId?: string) => void;
}) {
  return async (providerId: string, headers: Headers): Promise<Headers | PreparedUsageRequest> => {
    if (!input.providerIds.has(providerId)) return headers;
    const requestId = input.nextRequestId();
    const prepare = (
      token: SubscriptionCoreClaudeTokenSnapshot,
      transportAttempt: number,
    ): PreparedUsageRequest => {
      const request = { requestId, transportAttempt };
      const bearer = new Headers(headers);
      bearer.set("authorization", `Bearer ${token.credential.token}`);
      bearer.delete("x-api-key");
      return {
        headers: bearer,
        observe: (_provider, response, upstreamModelId) =>
          input.observe?.(response, token.credentialVersion, upstreamModelId),
        custody: {
          admit: async () => {
            await input.authorization.assertDispatch();
            await input.lane.reserve(request);
          },
          responded: (response) =>
            settleCoreResponse(input.lane, request, response, claudeResponseInspector(response)),
          failed: () => input.lane.observe({ ...request, outcome: "unknown" }),
          ...(transportAttempt === 1
            ? {
                renew: async () => {
                  const renewed = await input.authorization.renewAfterUnauthorized(
                    token.credentialVersion,
                  );
                  return renewed ? prepare(renewed, transportAttempt + 1) : null;
                },
              }
            : {}),
        },
      };
    };
    return prepare(await input.authorization.getToken(), 1);
  };
}

/**
 * The terminal unknown-outcome failure of a core Claude turn, or null: an
 * earlier or own request whose outcome is unknown is never replayed
 * automatically.
 */
export function claudeCoreRequestOutcomeUnknown(
  error: unknown,
  core: Pick<SubscriptionCoreTurn, "requests" | "titleRequests">,
): (Error & { code: string }) | null {
  return coreRequestOutcomeUnknownFailure(error, core, () => CLAUDE.errors.requestOutcomeUnknown());
}

/**
 * Claude's in-turn failover and refusal settlement on the core (C1b) for a
 * turn of `productModelId`: a 401 after the turn's one forced refresh is a
 * sign-in quarantine, a 429 cools that model of the connection, and both
 * re-place the same turn within the shared bound; 529 (overload) and 403
 * (fatal) record nothing and never move the turn to another account.
 */
export function claudeCoreRefusal(productModelId: string | undefined): CoreRefusalBinding {
  return {
    provider: CLAUDE,
    displayName: DISPLAY_NAME,
    classify: (error) => classifyClaudeProviderError(error, productModelId),
    lease: (deps) => deps.leases.claude,
    isSourceDisconnected: CLAUDE_CORE_TURN_PROVIDER.isSourceDisconnected,
    failover: {
      displayName: DISPLAY_NAME,
      lease: (deps) => deps.leases.claude,
      countRefusals: (db, identity) =>
        subscriptionCoreTurns(CLAUDE).countSubscriptionCoreTurnRefusals(db, identity),
      refusalLimit: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT,
      recoveryReason: "claude_credential_failover",
      recoveryProvider: "claude-subscription",
      metrics: subscriptionCoreFailoverMetrics("claude"),
    },
  };
}

/**
 * Finalization of a core Claude turn before its lease is released: the
 * turn's usage-header observations are joined first (one that ended a stored
 * exhaustion is a capacity change for the account's Claude waiters), then
 * the shared step moves the binding's cache clock. Best effort.
 */
export async function finalizeCoreClaudeTurn(
  input: CoreCodexWakeServices & {
    core: SubscriptionCoreTurn;
    lease: ClaudeTurnLease;
  },
): Promise<void> {
  const recovered = await (input.core.quota?.settled() ?? false);
  if (recovered) {
    await wakeSubscriptionCoreWaitersAndDeliver(input, CLAUDE_CORE_WAIT_BINDING, {
      accountId: input.core.identity.accountId,
      reason: "quota_observed_available",
    });
  }
  await finalizeCoreSubscriptionTurn({
    db: input.db,
    provider: CLAUDE,
    core: input.core,
    lease: input.lease,
  });
}
