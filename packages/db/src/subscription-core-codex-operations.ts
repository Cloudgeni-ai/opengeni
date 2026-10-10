/**
 * Codex operations outside chat on the shared subscription core: the
 * provider-neutral operations runtime (`./subscription-core/operations`)
 * bound to Codex under the names M3 shipped, plus what is genuinely Codex:
 * the token snapshot (ChatGPT account id and FedRAMP flag), live usage from
 * `/wham/usage` and its quota decoding, the plan's voice entitlement, and
 * operation candidates over the Codex workspace projection.
 */
import { sql } from "drizzle-orm";
import type { Settings } from "@opengeni/config";
import {
  CODEX_CLIENT_VERSION,
  CODEX_REFRESH_FALLBACK_MS,
  CODEX_REFRESH_WINDOW_MS,
  CodexReloginRequired,
  codexPlanKey,
  fetchCodexUsage,
  normalizeCodexUsage,
  refreshCodexToken,
  type CodexFetch,
  type CodexUsagePayload,
} from "@opengeni/codex";
import type { SubscriptionQuota } from "@opengeni/subscriptions";
import type { CodexCredentialTokenSnapshot } from "./codex-token-resolver";
import { rawRows, type Database } from "./database";
import { buildSubscriptionCoreCredentialResolver } from "./subscription-core/credential-resolver";
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
import { projectSubscriptionCoreCodexWorkspace } from "./subscription-core-codex-compat";
import { SubscriptionCoreCodexOperationUnavailableError } from "./subscription-core-codex-errors";
import {
  reserveSubscriptionCoreCodexOperationRequest,
  settleSubscriptionCoreCodexOperationRequest,
} from "./subscription-core-codex-requests";
import {
  readSubscriptionProviderCutoverState,
  readSubscriptionSessionBinding,
} from "./subscription-core-repository";

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

/**
 * Bearer resolver for one operation (or connection read): the same snapshot
 * shape and staleness refresh as chat, with process-wide single-flight per
 * connection and generation (the shared core resolver, in its own flight
 * namespace). Only connection-level outcomes are shared; a refused
 * authorization belongs to the operation that hit it.
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
  const loadCredential = deps.load ?? loadSubscriptionCoreCodexConnectionCredential;
  const refreshCredential =
    deps.refreshCredential ?? refreshSubscriptionCoreCodexConnectionCredential;
  const snapshot = (
    credential: SubscriptionCoreCodexConnectionCredential,
    accessToken = credential.tokens.accessToken,
    credentialVersion = credential.refreshGeneration,
  ): CodexCredentialTokenSnapshot => ({
    accessToken,
    chatgptAccountId: credential.chatgptAccountId,
    isFedramp: credential.isFedramp,
    credentialVersion,
    planType: credential.planType,
  });
  return buildSubscriptionCoreCredentialResolver<
    SubscriptionCoreCodexConnectionCredential,
    Extract<SubscriptionCoreCodexConnectionRefreshOutcome, { kind: "refreshed" }>,
    CodexCredentialTokenSnapshot
  >({
    flightNamespace: "connection",
    connectionId,
    holderKey: ref
      ? `${ref.operationId}:${ref.holderId}:${ref.generation}`
      : `connection:${connectionId}`,
    policy: { windowMs: CODEX_REFRESH_WINDOW_MS, fallbackMs: CODEX_REFRESH_FALLBACK_MS },
    load: () => loadCredential(db, settings, scope, connectionId, ref),
    embeddedExpiry: (credential) =>
      SUBSCRIPTION_CORE_CODEX.adapter.credential.expiry(credential.tokens),
    refresh: (credential) =>
      refreshCredential(db, settings, scope, connectionId, ref, credential.refreshGeneration, deps),
    snapshot: (credential) => snapshot(credential),
    refreshedSnapshot: (outcome, credential) =>
      snapshot(credential, outcome.accessToken, outcome.refreshGeneration),
    errors: {
      relogin: (message) =>
        new CodexReloginRequired(message ?? "The Codex subscription needs a new sign-in."),
      leaseLost: () => new SubscriptionCoreCodexOperationUnavailableError(),
      accessLost: () => new SubscriptionCoreCodexOperationUnavailableError(),
    },
  });
}

export type SubscriptionCoreCodexOperationCandidate = {
  connectionId: string;
  planType: string | null;
  /** The session's explicit choice (realtime only). */
  explicit: boolean;
  /** The connection's model allowlist (null: every model). */
  allowedModelIds: string[] | null;
};

/**
 * Shared organization- or workspace-scoped Codex connections that can serve
 * an operation in this workspace, in placement order: the session's
 * explicit choice (session scope only), then the effective primary, then
 * pool order. Only active, allocatable connections in the effective
 * inference pool qualify. Empty when the cutover is not enabled.
 */
export async function listSubscriptionCoreCodexOperationCandidates(
  db: Database,
  scope: Exclude<SubscriptionCoreCodexOperationScope, { kind: "turn" }>,
): Promise<SubscriptionCoreCodexOperationCandidate[]> {
  const access = await withOperationScope(db, scope, async (tx) => {
    if (
      (await readSubscriptionProviderCutoverState(tx, {
        accountId: scope.accountId,
        provider: "codex",
      })) !== "enabled"
    )
      return [];
    const projection = await projectSubscriptionCoreCodexWorkspace(tx, scope);
    const effective = projection.source.effectiveSource;
    if (effective === "disabled") return [];
    const scoped = await rawRows<{ id: string }>(
      tx,
      sql`select connection.id::text as id from subscription_connections connection
        where connection.account_id = ${scope.accountId}::uuid
          and connection.provider = 'codex' and connection.kind = 'subscription'
          and connection.ownership = 'shared' and connection.status = 'active'
          and (connection.scope_kind = 'organization'
            or (connection.scope_kind = 'workspaces' and exists (
              select 1 from subscription_connection_workspaces assignment
              where assignment.account_id = connection.account_id
                and assignment.connection_id = connection.id
                and assignment.workspace_id = ${scope.workspaceId}::uuid)))`,
    );
    const inScope = new Set(scoped.map((row) => row.id));
    const eligible = projection.accounts.filter(
      (account) =>
        inScope.has(account.id) &&
        account.status === "active" &&
        account.allocatorEnabled &&
        account.source === effective,
    );
    let explicitId: string | null = null;
    if (scope.kind === "session") {
      const binding = await readSubscriptionSessionBinding(tx, scope).catch(() => null);
      if (binding?.provider === "codex" && binding.choice === "explicit") {
        explicitId = binding.connectionId;
      }
    }
    const rank = (id: string, isActive: boolean) => (id === explicitId ? 0 : isActive ? 1 : 2);
    return eligible
      .map((account, index) => ({ account, index }))
      .sort(
        (a, b) =>
          rank(a.account.id, a.account.isActive) - rank(b.account.id, b.account.isActive) ||
          a.index - b.index,
      )
      .map(({ account }) => ({
        connectionId: account.id,
        planType: account.planType,
        explicit: account.id === explicitId,
        allowedModelIds: account.allowedModelIds ?? null,
      }));
  });
  return access?.value ?? [];
}

/** ChatGPT Free has no voice: its realtime calls are refused. */
export function subscriptionCoreCodexPlanHasVoice(planType: string | null): boolean {
  return codexPlanKey(planType) !== "free";
}

function usageWindow(id: string, percent: number, resetAt: string | null) {
  return {
    id,
    usedPercent: percent,
    resetsAt: resetAt ? new Date(resetAt).getTime() : null,
    status:
      percent >= 100
        ? ("exhausted" as const)
        : percent >= 90
          ? ("warning" as const)
          : ("ok" as const),
  };
}

function usageQuotaObservation(
  usage: CodexUsagePayload,
  observedRefreshGeneration: number,
  observedAt: number,
): SubscriptionQuota | null {
  const windows = [
    ...(usage.fiveHour
      ? [usageWindow("primary", usage.fiveHour.percent, usage.fiveHour.resetAt)]
      : []),
    ...(usage.weekly ? [usageWindow("secondary", usage.weekly.percent, usage.weekly.resetAt)] : []),
  ];
  if (windows.length === 0) return null;
  return {
    windows,
    modelCooldowns: {},
    exhaustedUntil: null,
    exhaustedKind: null,
    revision: 0,
    observedAt,
    observedRefreshGeneration,
    source: "usage_endpoint",
  };
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
 * Live usage for one shared connection in the caller's workspace scope:
 * resolve a refreshing bearer through the core seam, read /wham/usage,
 * normalize, and record the windows as a generation-fenced quota
 * observation. `recovered` reports an ended exhaustion (the caller wakes
 * the account's core waiters). Provider and refresh failures become an
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
  const resolver = buildSubscriptionCoreCodexConnectionTokenResolver(
    db,
    settings,
    scope,
    connectionId,
    null,
    deps,
  );
  let token: CodexCredentialTokenSnapshot;
  try {
    token = await resolver.getToken();
  } catch (error) {
    if (error instanceof SubscriptionCoreCodexOperationUnavailableError) {
      // Not readable in this workspace context (for example a personal or
      // people-scoped connection, which only its owner's turns may read):
      // "no data here", not an error.
      return { usage: { ...errorUsagePayload(), status: "no-data" }, recovered: false };
    }
    return {
      usage: errorUsagePayload(error instanceof CodexReloginRequired ? "needs_relogin" : undefined),
      recovered: false,
    };
  }
  let usage: CodexUsagePayload;
  try {
    const response = await fetchCodexUsage(
      {
        accessToken: token.accessToken,
        chatgptAccountId: token.chatgptAccountId,
        isFedramp: token.isFedramp,
        clientVersion: CODEX_CLIENT_VERSION,
      },
      buildSubscriptionCoreCodexOperationFetch(db, scope, null, connectionId, fetchImpl),
    );
    usage = normalizeCodexUsage(response.status, response.payload);
  } catch {
    return { usage: errorUsagePayload(), recovered: false };
  }
  if (usage.status === "error" || token.credentialVersion === null) {
    return { usage, recovered: false };
  }
  const observation = usageQuotaObservation(usage, token.credentialVersion, Date.now());
  if (!observation) return { usage, recovered: false };
  const applied = await recordSubscriptionCoreCodexUsageObservation(
    db,
    scope,
    connectionId,
    observation,
  ).catch(() => ({ applied: false, recovered: false }));
  return { usage, recovered: applied.recovered };
}
