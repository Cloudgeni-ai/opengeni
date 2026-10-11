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
  readSubscriptionCoreProviderRoute,
  SUBSCRIPTION_CORE_CLAUDE,
  SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES,
  SubscriptionCoreError,
  subscriptionCoreRequests,
  subscriptionCoreTurns,
  withRlsContext,
  type Database,
  type SubscriptionCoreClaudeTokenSnapshot,
  type SubscriptionCoreProvider,
} from "@opengeni/db";
import { parseModelProvidersJson, type Settings } from "@opengeni/config";
import type { PreparedUsageRequest } from "@opengeni/runtime";
import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";
import { subscriptionCoreCutoverDisabledFailure } from "./codex-core-errors";
import type { ClaudeTurnLease } from "./credential-leases";
import {
  assertCoreSourceConnected,
  coreLeaseRef,
  guardCoreTokenResolver,
  selectCoreSubscriptionTurnCapacity,
  type CoreTurnPlacementProvider,
} from "./subscription-core-capacity";
import {
  coreRequestOutcomeUnknownFailure,
  createCoreSubscriptionRequests,
  settleCoreResponse,
  type CoreResponseInspector,
  type CoreSubscriptionRequests,
} from "./subscription-core-requests";
import type { SubscriptionCoreTurn } from "./turn-context";
import { subscriptionTurnLeaseHolderId } from "./subscription-lease";
import { selectClaudeTurnCapacity } from "./xai-capacity";

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
  // Waiter wakes after a recovery arrive with the Claude waits (C1b).
  recoverHealth: async ({ db }, identity) => {
    await subscriptionCoreTurns(CLAUDE)
      .recoverSubscriptionCoreConnectionHealth(db, identity)
      .catch(() => 0);
  },
  adopt: ({ providerTurn, turnExecutionPolicy }, core, placement) => {
    providerTurn.claudeSubscriptionCore = core;
    providerTurn.effectiveClaudeCredentialId = placement.connectionId;
    providerTurn.claudeUpstreamModelId = turnExecutionPolicy.upstreamModelId;
    // Rotation is the core's placement policy, never the legacy rotation,
    // and no legacy authority or credential version applies to the turn.
    providerTurn.claudeRotationEnabled = false;
    providerTurn.claudeAuthoritySnapshot = null;
    providerTurn.effectiveClaudeCredentialVersion = null;
  },
  // No `park` until C1b: a core wait is a terminal capacity failure.
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
    // A paused web search continues the same model call with a new request
    // after a complete response (`pause_turn`).
    continuesAfterResponse: true,
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
   * A main-lane request with a bearer of `generation` was admitted: the
   * refusal settlement fences its health write on that generation. Main-lane
   * requests are sequential, so at settlement it is the refused request's;
   * session-title requests (their own lane) never move it.
   */
  mainLaneAdmitted: (generation: number) => void;
};

/**
 * Materialization and refresh for a core-placed Claude turn: the bearer comes
 * from the shared core resolver under the exact accepted turn and this
 * attempt's live core lease, and both request lanes (the agent's and the
 * session title's) are created on the turn.
 */
export function buildClaudeCoreRequestAuthorization(input: {
  db: Database;
  settings: Settings;
  core: SubscriptionCoreTurn;
  lease: ClaudeTurnLease;
  execution: { attemptId: string; executionGeneration: number };
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
  let forced: Promise<SubscriptionCoreClaudeTokenSnapshot> | null = null;
  return {
    getToken: () => resolver.getToken(),
    // One forced refresh per attempt, shared by both lanes: a refresh that
    // failed stays failed for the rest of the attempt (no second refresh).
    renewAfterUnauthorized: async (generation) => {
      forced ??= resolver.refresh();
      const token = await forced;
      return token.credentialVersion > generation ? token : null;
    },
    assertDispatch: async () => {
      await assertCoreSourceConnected(db, CLAUDE_CORE_TURN_PROVIDER, core);
      await lease.assertCurrentForDispatch();
    },
    mainLaneAdmitted: (generation) => {
      core.credentialVersion = generation;
    },
  };
}

/**
 * The bearer a core-placed Claude turn's capability settings carry instead of
 * the live one: each core request's custody sets the real bearer, so a
 * request that bypasses custody is refused upstream rather than spending the
 * account unreserved.
 */
export const CLAUDE_CORE_SETTINGS_PLACEHOLDER_TOKEN = "sk-ant-oat01-opengeni-core-custody-only";

/**
 * The Claude credential a core-placed turn's capability settings carry: the
 * account identity with the placeholder bearer, never the live token or any
 * refresh material.
 */
export function claudeCoreSettingsCredential(token: SubscriptionCoreClaudeTokenSnapshot): string {
  return JSON.stringify({
    version: token.credential.version,
    token: CLAUDE_CORE_SETTINGS_PLACEHOLDER_TOKEN,
    identity: token.credential.identity,
  });
}

/** The scope a Claude product model id names (its prefix). */
export function claudeCoreModelScope(productModelId: string): "organization" | "workspace" {
  return productModelId.startsWith(`${SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES[1]}/`)
    ? "workspace"
    : "organization";
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
const SSE_DATA = /^data:\s*(.*)$/;
/** Stream error types that are a refusal (the provider did no model work). */
const CLAUDE_REFUSAL_ERROR_TYPES = new Set(["overloaded_error", "rate_limit_error"]);

/**
 * The outcome of a streamed Claude response, read from its event names as
 * the body passes: a `message_delta` (the model's final stop reason) or
 * `message_stop` means the model answered, even when the reader stops right
 * after it; an `error` event before any content block whose type is an
 * overload or rate limit is a refusal (reported with HTTP 200); any other
 * stream error (a timeout or conflict, as their HTTP statuses) and anything
 * else that ends or stops early is unknown. A body that is not a stream is
 * a response once it ends.
 */
export function claudeResponseInspector(response: Response): CoreResponseInspector {
  const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const decoder = new TextDecoder();
  let pending = "";
  let content = false;
  let answered = false;
  let inError = false;
  let refused = false;
  return {
    chunk(bytes) {
      if (!streamed || answered) return;
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        const data = inError ? SSE_DATA.exec(trimmed)?.[1] : undefined;
        if (data !== undefined) {
          inError = false;
          refused ||= CLAUDE_REFUSAL_ERROR_TYPES.has(claudeStreamErrorType(data) ?? "");
          continue;
        }
        const event = SSE_EVENT.exec(trimmed)?.[1];
        if (!event) continue;
        inError = event === "error";
        if (event === "message_delta" || event === "message_stop") answered = true;
        else if (event.startsWith("content_block_")) content = true;
      }
    },
    outcome(ended) {
      if (!streamed) return ended ? "response_received" : "unknown";
      if (answered) return "response_received";
      return refused && !content ? "refused" : "unknown";
    },
  };
}

function claudeStreamErrorType(data: string): string | null {
  try {
    const value = JSON.parse(data) as { error?: { type?: unknown } } | null;
    return typeof value?.error?.type === "string" ? value.error.type : null;
  } catch {
    return null;
  }
}

/**
 * The Anthropic transport's per-request preparation for a core-placed Claude
 * turn (through `withClaudeUsageObserver`): each physical request carries the
 * core bearer, is fenced and reserved on its lane as the last step before the
 * fetch, and settles from its response. A 401 renews the bearer through the
 * turn's one forced refresh and retries the same request on the same
 * connection as a new reservation, only when the generation advanced.
 * `observe` receives every response with the generation of the bearer that
 * made it (usage headers become quota observations in C1b).
 */
export function claudeCoreRequestPreparer(input: {
  authorization: ClaudeCoreRequestAuthorization;
  lane: CoreSubscriptionRequests;
  /** The agent's lane (not the session title's): admissions move the refusal fence. */
  mainLane: boolean;
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
            if (input.mainLane) input.authorization.mainLaneAdmitted(token.credentialVersion);
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
