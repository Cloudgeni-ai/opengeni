/**
 * Codex operations outside chat on the shared subscription core: the
 * provider-neutral operations runtime (`./subscription-core/operations` and
 * `./subscription-core/operation-connections`) bound to Codex under the
 * names M3 shipped, plus what is genuinely Codex: the token snapshot
 * (ChatGPT account id and FedRAMP flag), the legacy usage payload, and the
 * plan's voice entitlement. The `/wham/usage` read and its quota decoding
 * are the Codex adapter's `fetchUsage` and `decodeQuota`.
 */
import type { Settings } from "@opengeni/config";
import {
  CodexReloginRequired,
  codexPlanKey,
  refreshCodexToken,
  type CodexFetch,
  type CodexUsagePayload,
} from "@opengeni/codex";
import type { CodexCredentialTokenSnapshot } from "./codex-token-resolver";
import { type Database } from "./database";
import {
  subscriptionCoreOperationConnections,
  type SubscriptionCoreConnectionResolverDeps,
  type SubscriptionCoreConnectionToken,
  type SubscriptionCoreOperationCandidate,
} from "./subscription-core/operation-connections";
import {
  subscriptionCoreOperations,
  type SubscriptionCoreConnectionCredential,
  type SubscriptionCoreConnectionCredentialLoad,
  type SubscriptionCoreConnectionRefreshDeps,
  type SubscriptionCoreOperationLeaseRef,
  type SubscriptionCoreOperationLeaseResult,
  type SubscriptionCoreOperationScope,
} from "./subscription-core/operations";
import {
  SUBSCRIPTION_CORE_CODEX,
  subscriptionCoreCodexProvider,
  type SubscriptionCoreCodexTokens,
} from "./subscription-core-codex-adapter";
import {
  reserveSubscriptionCoreCodexOperationRequest,
  settleSubscriptionCoreCodexOperationRequest,
} from "./subscription-core-codex-requests";

export { SubscriptionCoreCodexOperationUnavailableError } from "./subscription-core-codex-errors";
export {
  readSubscriptionCoreSessionOwner,
  SUBSCRIPTION_CORE_OPERATION_LEASE_TTL_MS as SUBSCRIPTION_CORE_CODEX_OPERATION_LEASE_TTL_MS,
  SUBSCRIPTION_MODEL_CATALOG_TTL_MS,
} from "./subscription-core/operations";

export type SubscriptionCoreCodexOperationScope = SubscriptionCoreOperationScope;
export type SubscriptionCoreCodexOperationLeaseRef = SubscriptionCoreOperationLeaseRef;
export type SubscriptionCoreCodexOperationLeaseResult = SubscriptionCoreOperationLeaseResult;

const core = subscriptionCoreOperations(SUBSCRIPTION_CORE_CODEX);

export const withOperationScope = core.withOperationScope;

/**
 * Physical request custody for Codex's finite JSON/SDP operations (the
 * core's custody fetch), reserving and settling through the exported Codex
 * request functions unless the caller supplies its own.
 */
export function buildSubscriptionCoreCodexOperationFetch(
  db: Database,
  scope: SubscriptionCoreCodexOperationScope,
  ref: SubscriptionCoreCodexOperationLeaseRef | null,
  connectionId: string,
  fetchImpl: CodexFetch = fetch,
  deps: NonNullable<Parameters<typeof core.buildSubscriptionCoreOperationFetch>[5]> = {},
): CodexFetch {
  return core.buildSubscriptionCoreOperationFetch(db, scope, ref, connectionId, fetchImpl, {
    ...deps,
    reserve: deps.reserve ?? ((...args) => reserveSubscriptionCoreCodexOperationRequest(...args)),
    settle: deps.settle ?? ((...args) => settleSubscriptionCoreCodexOperationRequest(...args)),
  });
}

export const acquireSubscriptionCoreCodexOperationLease =
  core.acquireSubscriptionCoreOperationLease;
export const renewSubscriptionCoreCodexOperationLease = core.renewSubscriptionCoreOperationLease;
export const releaseSubscriptionCoreCodexOperationLease =
  core.releaseSubscriptionCoreOperationLease;
export const recordSubscriptionCoreCodexModelCatalog = core.recordSubscriptionCoreModelCatalog;
export const recordSubscriptionCoreCodexUsageObservation =
  core.recordSubscriptionCoreUsageObservation;
export const resolveSubscriptionCoreCodexConnectionId = core.resolveSubscriptionCoreConnectionId;

export type SubscriptionCoreCodexConnectionCredential = {
  connectionId: string;
  refreshGeneration: number;
  tokens: SubscriptionCoreCodexTokens;
  chatgptAccountId: string | null;
  isFedramp: boolean;
  planType: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
};

export type SubscriptionCoreCodexConnectionCredentialLoad =
  | { kind: "loaded"; credential: SubscriptionCoreCodexConnectionCredential }
  | Exclude<SubscriptionCoreConnectionCredentialLoad, { kind: "loaded" }>;

function codexConnectionCredential(
  credential: SubscriptionCoreConnectionCredential<unknown>,
): SubscriptionCoreCodexConnectionCredential {
  return {
    connectionId: credential.connectionId,
    refreshGeneration: credential.refreshGeneration,
    tokens: credential.credential as SubscriptionCoreCodexTokens,
    chatgptAccountId: credential.providerAccountId,
    isFedramp: credential.providerState.isFedramp === true,
    planType: credential.planType,
    expiresAt: credential.expiresAt,
    lastRefreshAt: credential.lastRefreshAt,
  };
}

/**
 * Read one connection's credential for an exact operation lease (or, with
 * `ref = null`, for a `workspace`-scope connection read such as usage or
 * reset credits). Never reads a legacy table.
 */
export async function loadSubscriptionCoreCodexConnectionCredential(
  db: Database,
  settings: Settings,
  scope: SubscriptionCoreCodexOperationScope,
  connectionId: string,
  ref: SubscriptionCoreCodexOperationLeaseRef | null,
): Promise<SubscriptionCoreCodexConnectionCredentialLoad> {
  const loaded = await core.loadSubscriptionCoreConnectionCredential(
    db,
    settings,
    scope,
    connectionId,
    ref,
  );
  return loaded.kind === "loaded"
    ? { kind: "loaded", credential: codexConnectionCredential(loaded.credential) }
    : loaded;
}

export type SubscriptionCoreCodexConnectionRefreshOutcome =
  | { kind: "refreshed"; accessToken: string; refreshGeneration: number }
  | { kind: "superseded" }
  | { kind: "relogin"; message: string; marked: boolean }
  | { kind: "refused" }
  | { kind: "error"; error: unknown };

export type SubscriptionCoreCodexConnectionRefreshDeps = SubscriptionCoreConnectionRefreshDeps & {
  refresh?: typeof refreshCodexToken;
};

/**
 * Rotate the connection's refresh token under the per-connection advisory
 * key. Authorization (live operation lease, scope, enabled cutover) happens
 * in begin, before the provider call; the rotated token is persisted
 * immediately after it returns.
 */
export async function refreshSubscriptionCoreCodexConnectionCredential(
  db: Database,
  settings: Settings,
  scope: SubscriptionCoreCodexOperationScope,
  connectionId: string,
  ref: SubscriptionCoreCodexOperationLeaseRef | null,
  observedRefreshGeneration: number,
  deps: SubscriptionCoreCodexConnectionRefreshDeps = {},
): Promise<SubscriptionCoreCodexConnectionRefreshOutcome> {
  const operations = deps.refresh
    ? subscriptionCoreOperations(subscriptionCoreCodexProvider({ refresh: deps.refresh }))
    : core;
  const outcome = await operations.refreshSubscriptionCoreConnectionCredential(
    db,
    settings,
    scope,
    connectionId,
    ref,
    observedRefreshGeneration,
    deps,
  );
  if (outcome.kind !== "refreshed") return outcome;
  return {
    kind: "refreshed",
    accessToken: (outcome.credential as SubscriptionCoreCodexTokens).accessToken,
    refreshGeneration: outcome.refreshGeneration,
  };
}

export type SubscriptionCoreCodexConnectionResolverDeps =
  SubscriptionCoreCodexConnectionRefreshDeps & {
    load?: typeof loadSubscriptionCoreCodexConnectionCredential;
    refreshCredential?: typeof refreshSubscriptionCoreCodexConnectionCredential;
  };

/** The core connection credential behind a Codex-shaped one (test seams). */
function coreConnectionCredential(
  credential: SubscriptionCoreCodexConnectionCredential,
): SubscriptionCoreConnectionCredential {
  return {
    connectionId: credential.connectionId,
    refreshGeneration: credential.refreshGeneration,
    credential: credential.tokens,
    providerAccountId: credential.chatgptAccountId,
    providerState: credential.isFedramp ? { isFedramp: true } : {},
    planType: credential.planType,
    expiresAt: credential.expiresAt,
    lastRefreshAt: credential.lastRefreshAt,
  };
}

/** The Codex binding and generic resolver seams for Codex-shaped deps. */
function coreResolver(deps: SubscriptionCoreCodexConnectionResolverDeps): {
  connections: ReturnType<typeof subscriptionCoreOperationConnections>;
  deps: SubscriptionCoreConnectionResolverDeps;
} {
  const { load, refreshCredential, refresh: _refresh, ...rest } = deps;
  return {
    connections: subscriptionCoreOperationConnections(
      deps.refresh
        ? subscriptionCoreCodexProvider({ refresh: deps.refresh })
        : SUBSCRIPTION_CORE_CODEX,
    ),
    deps: {
      ...rest,
      ...(load
        ? {
            load: async (db, settings, scope, connectionId, ref) => {
              const loaded = await load(db, settings, scope, connectionId, ref);
              return loaded.kind === "loaded"
                ? { kind: "loaded", credential: coreConnectionCredential(loaded.credential) }
                : loaded;
            },
          }
        : {}),
      ...(refreshCredential
        ? {
            refreshCredential: async (db, settings, scope, connectionId, ref, generation) => {
              const outcome = await refreshCredential(
                db,
                settings,
                scope,
                connectionId,
                ref,
                generation,
                deps,
              );
              // The Codex snapshot reads only the rotated access token.
              return outcome.kind === "refreshed"
                ? {
                    kind: "refreshed",
                    credential: { accessToken: outcome.accessToken },
                    refreshGeneration: outcome.refreshGeneration,
                  }
                : outcome;
            },
          }
        : {}),
      relogin: (message) =>
        new CodexReloginRequired(message ?? "The Codex subscription needs a new sign-in."),
    },
  };
}

function codexTokenSnapshot(token: SubscriptionCoreConnectionToken): CodexCredentialTokenSnapshot {
  return {
    accessToken: (token.credential as Pick<SubscriptionCoreCodexTokens, "accessToken">).accessToken,
    chatgptAccountId: token.providerAccountId,
    isFedramp: token.providerState.isFedramp === true,
    credentialVersion: token.credentialVersion,
    planType: token.planType,
  };
}

/**
 * Bearer resolver for one operation (or connection read): the core
 * connection resolver with Codex's snapshot shape and relogin error.
 */
export function buildSubscriptionCoreCodexConnectionTokenResolver(
  db: Database,
  settings: Settings,
  scope: SubscriptionCoreCodexOperationScope,
  connectionId: string,
  ref: SubscriptionCoreCodexOperationLeaseRef | null,
  deps: SubscriptionCoreCodexConnectionResolverDeps = {},
): {
  getToken: () => Promise<CodexCredentialTokenSnapshot>;
  refresh: () => Promise<CodexCredentialTokenSnapshot>;
} {
  const core = coreResolver(deps);
  const resolver = core.connections.buildSubscriptionCoreConnectionTokenResolver(
    db,
    settings,
    scope,
    connectionId,
    ref,
    core.deps,
  );
  return {
    getToken: async () => codexTokenSnapshot(await resolver.getToken()),
    refresh: async () => codexTokenSnapshot(await resolver.refresh()),
  };
}

export type SubscriptionCoreCodexOperationCandidate = SubscriptionCoreOperationCandidate;

/**
 * Shared organization- or workspace-scoped Codex connections that can serve
 * an operation in this workspace, in placement order (the core's operation
 * candidates).
 */
export async function listSubscriptionCoreCodexOperationCandidates(
  db: Database,
  scope: Exclude<SubscriptionCoreCodexOperationScope, { kind: "turn" }>,
): Promise<SubscriptionCoreCodexOperationCandidate[]> {
  return await subscriptionCoreOperationConnections(
    SUBSCRIPTION_CORE_CODEX,
  ).listSubscriptionCoreOperationCandidates(db, scope);
}

/** ChatGPT Free has no voice: its realtime calls are refused. */
export function subscriptionCoreCodexPlanHasVoice(planType: string | null): boolean {
  return codexPlanKey(planType) !== "free";
}

function errorUsagePayload(reason?: "needs_relogin"): CodexUsagePayload {
  return {
    status: "error",
    planType: null,
    fiveHour: null,
    weekly: null,
    limitReached: false,
    fetchedAt: new Date().toISOString(),
    rateLimitResetCredits: null,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Live usage for one shared connection in the caller's workspace scope: the
 * core quota probe with the Codex adapter's `/wham/usage` read, as the
 * legacy route payload. `recovered` reports an ended exhaustion (the caller
 * wakes the account's core waiters). Provider and refresh failures become an
 * error payload, never a thrown route error.
 */
export async function fetchSubscriptionCoreCodexUsage(
  db: Database,
  settings: Settings,
  scope: Extract<SubscriptionCoreCodexOperationScope, { kind: "workspace" }>,
  connectionId: string,
  fetchImpl: CodexFetch = fetch,
  deps: SubscriptionCoreCodexConnectionResolverDeps = {},
): Promise<{ usage: CodexUsagePayload; recovered: boolean }> {
  const core = coreResolver(deps);
  const probe = await core.connections.probeSubscriptionCoreConnectionUsage(
    db,
    settings,
    scope,
    connectionId,
    {
      requestFetch: buildSubscriptionCoreCodexOperationFetch(
        db,
        scope,
        null,
        connectionId,
        fetchImpl,
      ),
      resolver: core.deps,
    },
  );
  switch (probe.kind) {
    case "read":
      return { usage: probe.response as CodexUsagePayload, recovered: probe.recovered };
    case "not_visible":
      // Not readable in this workspace context (for example a personal or
      // people-scoped connection, which only its owner's turns may read):
      // "no data here", not an error.
      return { usage: { ...errorUsagePayload(), status: "no-data" }, recovered: false };
    case "relogin":
      return { usage: errorUsagePayload("needs_relogin"), recovered: false };
    case "token_error":
      return {
        usage: errorUsagePayload(
          probe.error instanceof CodexReloginRequired ? "needs_relogin" : undefined,
        ),
        recovered: false,
      };
    default:
      return { usage: errorUsagePayload(), recovered: false };
  }
}
