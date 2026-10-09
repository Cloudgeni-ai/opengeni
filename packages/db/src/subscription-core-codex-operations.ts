/**
 * Codex operations outside chat on the shared subscription core (M3 PR 2c):
 * image generation, realtime and transcription, plus the connection-level
 * credential reads behind live usage and reset credits.
 *
 * Dormant until an organization's Codex cutover row is enabled: every read,
 * lease and refresh re-checks the enabled cutover in its own transaction
 * (the 0671 routines return nothing otherwise), so switch-off fails closed
 * mid-operation. Nothing here reads a legacy Codex table or writes the chat
 * session binding.
 *
 * Three caller contexts exist, each with an explicit owner/workspace tuple:
 * - `turn`: an operation inside an exact accepted chat turn (image). It runs
 *   under that turn's accepted authority, so a personal connection is
 *   usable only under the turn's frozen v2 entry, exactly as for chat.
 * - `session`: a session-bound operation with no turn (realtime). The actor
 *   is the core service with the session's recorded owner as its human
 *   (none for an ownerless session); it may use only shared organization- or
 *   workspace-scoped connections in the workspace's scope.
 * - `workspace`: a sessionless operation or connection read for the
 *   authenticated caller (transcription, usage, reset credits). It borrows
 *   no caller or creator personal authority: shared organization- or
 *   workspace-scoped connections only.
 *
 * Each operation holds its own `subscription_operation_leases` row, fenced on
 * the exact operation id, attempt, holder and generation; it never touches
 * the chat-turn lease. Every refresh takes the per-connection advisory key
 * shared with chat and Apps refresh.
 */
import { sql } from "drizzle-orm";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  accessTokenExpiry,
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
import {
  applyQuotaObservation,
  quotaCapacity,
  type SubscriptionQuota,
} from "@opengeni/subscriptions";
import { withCodexTokenDeadline, type CodexCredentialTokenSnapshot } from "./codex-token-resolver";
import { rawRows, withRlsContext, withSessionRlsActorContext, type Database } from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import {
  authorizeSubscriptionCoreFrozenPersonalCodex,
  type SubscriptionCoreTurnIdentity,
} from "./subscription-core-codex";
import { projectSubscriptionCoreCodexWorkspace } from "./subscription-core-codex-compat";
import { withSubscriptionCoreAcceptedTurn } from "./subscription-core-placement-world";
import {
  acquireSubscriptionOperationLease,
  decodeSubscriptionQuota,
  readSubscriptionProviderCutoverState,
  readSubscriptionSessionBinding,
  releaseSubscriptionOperationLease,
  renewSubscriptionOperationLease,
  resolveSubscriptionConnectionId,
  type SubscriptionOperationKind,
  type SubscriptionOperationLeaseIdentity,
} from "./subscription-core-repository";

const CORE_SUBSCRIPTION_SUBJECT = "service:subscription-core";

/** Default lease for one Codex operation; renewed before each provider dispatch. */
export const SUBSCRIPTION_CORE_CODEX_OPERATION_LEASE_TTL_MS = 5 * 60 * 1000;

export type SubscriptionCoreCodexOperationScope =
  | { kind: "turn"; identity: SubscriptionCoreTurnIdentity }
  | {
      kind: "session";
      accountId: string;
      workspaceId: string;
      sessionId: string;
      /** The session's recorded owner; null for an ownerless session. */
      sessionOwnerSubjectId: string | null;
    }
  | { kind: "workspace"; accountId: string; workspaceId: string; subjectId: string };

/** The exact operation lease that authorizes credential reads and refreshes. */
export type SubscriptionCoreCodexOperationLeaseRef = {
  operationId: string;
  attemptId: string;
  operationKind: SubscriptionOperationKind;
  connectionId: string;
  holderId: string;
  generation: number;
};

function scopeTenant(scope: SubscriptionCoreCodexOperationScope): {
  accountId: string;
  workspaceId: string;
} {
  return scope.kind === "turn"
    ? { accountId: scope.identity.accountId, workspaceId: scope.identity.workspaceId }
    : { accountId: scope.accountId, workspaceId: scope.workspaceId };
}

/**
 * Run `operation` in the scope's exact RLS context. `null` means the turn is
 * no longer the accepted turn it claims to be (or is not visible).
 */
async function withOperationScope<T>(
  db: Database,
  scope: SubscriptionCoreCodexOperationScope,
  operation: (tx: Database) => Promise<T>,
): Promise<{ value: T } | null> {
  if (scope.kind === "turn") {
    const access = await withSubscriptionCoreAcceptedTurn(db, scope.identity, async (tx) => {
      await authorizeSubscriptionCoreFrozenPersonalCodex(tx, scope.identity);
      return await operation(tx);
    });
    return access.status === "completed" ? { value: access.value } : null;
  }
  const actor =
    scope.kind === "session"
      ? {
          subjectId: CORE_SUBSCRIPTION_SUBJECT,
          initiatingHumanSubjectId: scope.sessionOwnerSubjectId,
        }
      : { subjectId: scope.subjectId, initiatingHumanSubjectId: scope.subjectId };
  return {
    value: await withSessionRlsActorContext(actor, async () =>
      withRlsContext(db, scopeTenant(scope), operation),
    ),
  };
}

async function codexCutoverEnabled(tx: Database, accountId: string): Promise<boolean> {
  return (
    (await readSubscriptionProviderCutoverState(tx, { accountId, provider: "codex" })) === "enabled"
  );
}

function leaseIdentity(
  scope: SubscriptionCoreCodexOperationScope,
  ref: SubscriptionCoreCodexOperationLeaseRef,
): SubscriptionOperationLeaseIdentity {
  const tenant = scopeTenant(scope);
  return {
    ...tenant,
    operationId: ref.operationId,
    attemptId: ref.attemptId,
    operationKind: ref.operationKind,
    sessionId:
      scope.kind === "turn"
        ? scope.identity.sessionId
        : scope.kind === "session"
          ? scope.sessionId
          : null,
    turnId: scope.kind === "turn" ? scope.identity.turnId : null,
    provider: "codex",
    connectionId: ref.connectionId,
    holderId: ref.holderId,
    generation: ref.generation,
  };
}

function isRlsRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "42501" || causeCode === "42501";
}

export type SubscriptionCoreCodexOperationLeaseResult =
  | { kind: "acquired"; leasedUntil: Date }
  /** Another live holder or generation owns this operation id. */
  | { kind: "busy" }
  /** The cutover is not enabled, or the turn is no longer the accepted turn. */
  | { kind: "not_enabled" }
  /** The database refused the connection for this operation's authority. */
  | { kind: "refused" };

/**
 * Take the per-operation lease. A retry of the same attempt, holder and
 * generation is idempotent; a newer generation replaces only an expired
 * lease. The chat-turn lease is never read or written.
 */
export async function acquireSubscriptionCoreCodexOperationLease(
  db: Database,
  scope: SubscriptionCoreCodexOperationScope,
  ref: SubscriptionCoreCodexOperationLeaseRef,
  ttlMs = SUBSCRIPTION_CORE_CODEX_OPERATION_LEASE_TTL_MS,
): Promise<SubscriptionCoreCodexOperationLeaseResult> {
  try {
    const access = await withOperationScope(
      db,
      scope,
      async (tx): Promise<SubscriptionCoreCodexOperationLeaseResult> => {
        if (!(await codexCutoverEnabled(tx, scopeTenant(scope).accountId))) {
          return { kind: "not_enabled" };
        }
        const lease = await acquireSubscriptionOperationLease(tx, {
          ...leaseIdentity(scope, ref),
          ttlMs,
        });
        return lease ? { kind: "acquired", leasedUntil: lease.leasedUntil } : { kind: "busy" };
      },
    );
    return access?.value ?? { kind: "not_enabled" };
  } catch (error) {
    if (isRlsRefusal(error)) return { kind: "refused" };
    throw error;
  }
}

/** Renew only the exact, still-live operation lease (and only with the cutover on). */
export async function renewSubscriptionCoreCodexOperationLease(
  db: Database,
  scope: SubscriptionCoreCodexOperationScope,
  ref: SubscriptionCoreCodexOperationLeaseRef,
  ttlMs = SUBSCRIPTION_CORE_CODEX_OPERATION_LEASE_TTL_MS,
): Promise<Date | null> {
  const access = await withOperationScope(db, scope, async (tx) => {
    if (!(await codexCutoverEnabled(tx, scopeTenant(scope).accountId))) return null;
    // Renewal touches only the expiry, so the lease guard does not rerun:
    // re-check the full operation authority (live turn attempt and chat
    // lease, scope, personal authority and settings) before extending it.
    const [current] = await rawRows<{ status: string }>(
      tx,
      sql`select status from opengeni_private.read_subscription_codex_connection_credential(
          ${routineArgs(scope, ref.connectionId, ref)}
        )`,
    );
    if (!current || current.status !== "active") return null;
    return await renewSubscriptionOperationLease(tx, { ...leaseIdentity(scope, ref), ttlMs });
  });
  return access?.value ?? null;
}

/** Release is fenced by operation, attempt, holder and generation. */
export async function releaseSubscriptionCoreCodexOperationLease(
  db: Database,
  scope: SubscriptionCoreCodexOperationScope,
  ref: SubscriptionCoreCodexOperationLeaseRef,
): Promise<boolean> {
  const access = await withOperationScope(db, scope, (tx) =>
    releaseSubscriptionOperationLease(tx, leaseIdentity(scope, ref)),
  );
  return access?.value === true;
}

export type SubscriptionCoreCodexConnectionCredential = {
  connectionId: string;
  refreshGeneration: number;
  tokens: { accessToken: string; refreshToken: string; idToken: string };
  chatgptAccountId: string | null;
  isFedramp: boolean;
  planType: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
};

export type SubscriptionCoreCodexConnectionCredentialLoad =
  | { kind: "loaded"; credential: SubscriptionCoreCodexConnectionCredential }
  /** No live operation lease, no enabled cutover, or the connection is out of scope. */
  | { kind: "not_visible" }
  | { kind: "needs_relogin" }
  | { kind: "unavailable" };

function encryptionKey(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error(
      "core Codex credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
    );
  }
  return key;
}

function decodeTokens(
  key: Uint8Array,
  encrypted: string,
): SubscriptionCoreCodexConnectionCredential["tokens"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptEnvironmentValue(key, encrypted));
  } catch {
    // Fixed text and no cause: a parse message would quote the plaintext.
    throw new Error("A core Codex credential could not be decrypted");
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    !record ||
    typeof record.access_token !== "string" ||
    typeof record.refresh_token !== "string" ||
    typeof record.id_token !== "string"
  ) {
    throw new Error("A core Codex credential does not hold the expected token object");
  }
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    idToken: record.id_token,
  };
}

function routineArgs(
  scope: SubscriptionCoreCodexOperationScope,
  connectionId: string,
  ref: SubscriptionCoreCodexOperationLeaseRef | null,
) {
  const tenant = scopeTenant(scope);
  return sql`${tenant.accountId}::uuid, ${tenant.workspaceId}::uuid, ${connectionId}::uuid,
    ${ref?.operationId ?? null}::uuid, ${ref?.attemptId ?? null}::uuid,
    ${ref?.holderId ?? null}::text, ${ref?.generation ?? null}::bigint`;
}

function assertRefMatches(
  connectionId: string,
  ref: SubscriptionCoreCodexOperationLeaseRef | null,
): void {
  if (ref && ref.connectionId !== connectionId) {
    throw new Error("A core Codex operation lease does not hold the requested connection");
  }
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
  assertRefMatches(connectionId, ref);
  const key = encryptionKey(settings);
  const access = await withOperationScope(db, scope, async (tx) => {
    const [row] = await rawRows<{
      status: string;
      refresh_generation: number | string;
      credential_encrypted: string | null;
      expires_at: Date | string | null;
      last_refresh_at: Date | string | null;
      provider_account_id: string | null;
      plan_type: string | null;
      is_fedramp: boolean;
    }>(
      tx,
      sql`select status, refresh_generation, credential_encrypted, expires_at, last_refresh_at,
          provider_account_id, plan_type, is_fedramp
        from opengeni_private.read_subscription_codex_connection_credential(
          ${routineArgs(scope, connectionId, ref)}
        )`,
    );
    return row ?? null;
  });
  const row = access?.value;
  if (!row) return { kind: "not_visible" };
  if (row.status === "needs_relogin") return { kind: "needs_relogin" };
  if (row.status !== "active" || !row.credential_encrypted) return { kind: "unavailable" };
  return {
    kind: "loaded",
    credential: {
      connectionId,
      refreshGeneration: Number(row.refresh_generation),
      tokens: decodeTokens(key, row.credential_encrypted),
      chatgptAccountId: row.provider_account_id,
      isFedramp: row.is_fedramp === true,
      planType: row.plan_type,
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
      lastRefreshAt: row.last_refresh_at === null ? null : new Date(row.last_refresh_at),
    },
  };
}

export type SubscriptionCoreCodexConnectionRefreshOutcome =
  | { kind: "refreshed"; accessToken: string; refreshGeneration: number }
  | { kind: "superseded" }
  | { kind: "relogin"; message: string; marked: boolean }
  | { kind: "refused" }
  | { kind: "error"; error: unknown };

export type SubscriptionCoreCodexConnectionRefreshDeps = {
  refresh?: typeof refreshCodexToken;
  now?: () => Date;
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
  assertRefMatches(connectionId, ref);
  const key = encryptionKey(settings);
  const refresh = deps.refresh ?? refreshCodexToken;
  const now = deps.now ?? (() => new Date());
  const tenant = scopeTenant(scope);
  const access = await withOperationScope(
    db,
    scope,
    async (tx): Promise<SubscriptionCoreCodexConnectionRefreshOutcome> => {
      await tx.execute(sql`set local lock_timeout = '30s'`);
      const [credential] = await rawRows<{
        refresh_generation: number | string;
        credential_encrypted: string;
      }>(
        tx,
        sql`select refresh_generation, credential_encrypted
          from opengeni_private.begin_subscription_codex_connection_refresh(
            ${routineArgs(scope, connectionId, ref)}
          )`,
      );
      if (!credential) return { kind: "refused" };
      const generation = Number(credential.refresh_generation);
      if (generation !== observedRefreshGeneration) return { kind: "superseded" };
      try {
        const tokens = decodeTokens(key, credential.credential_encrypted);
        const next = await withCodexTokenDeadline(refresh(tokens.refreshToken));
        const rotated = {
          access_token: next.accessToken ?? tokens.accessToken,
          refresh_token: next.refreshToken ?? tokens.refreshToken,
          id_token: next.idToken ?? tokens.idToken,
        };
        // Persist before any other fallible work: a rolled-back transaction
        // would discard the only valid refresh token.
        const [persisted] = await rawRows<{ persisted: boolean }>(
          tx,
          sql`select opengeni_private.persist_subscription_codex_connection_refresh(
              ${tenant.accountId}::uuid, ${tenant.workspaceId}::uuid, ${connectionId}::uuid,
              ${generation}::bigint,
              ${encryptEnvironmentValue(key, JSON.stringify(rotated))},
              ${accessTokenExpiry(rotated.access_token)?.toISOString() ?? null}::timestamptz,
              ${now().toISOString()}::timestamptz
            ) as persisted`,
        );
        if (persisted?.persisted !== true) return { kind: "superseded" };
        return {
          kind: "refreshed",
          accessToken: rotated.access_token,
          refreshGeneration: generation + 1,
        };
      } catch (error) {
        if (error instanceof CodexReloginRequired) {
          const [marked] = await rawRows<{ marked: boolean }>(
            tx,
            sql`select opengeni_private.fail_subscription_codex_connection_refresh(
                ${tenant.accountId}::uuid, ${tenant.workspaceId}::uuid, ${connectionId}::uuid,
                ${generation}::bigint, ${error.message}
              ) as marked`,
          );
          return { kind: "relogin", message: error.message, marked: marked?.marked === true };
        }
        return { kind: "error", error };
      }
    },
  );
  return access?.value ?? { kind: "refused" };
}

/** The operation lost its lease, its scope or the enabled cutover. */
export class SubscriptionCoreCodexOperationUnavailableError extends Error {
  readonly code = "subscription_core_operation_unavailable";
  constructor() {
    super("This Codex operation can no longer use its subscription");
    this.name = "SubscriptionCoreCodexOperationUnavailableError";
  }
}

type ConnectionFlight = {
  holderKey: string;
  promise: Promise<SubscriptionCoreCodexConnectionRefreshOutcome>;
};
const connectionInflight = new Map<string, ConnectionFlight>();

export type SubscriptionCoreCodexConnectionResolverDeps =
  SubscriptionCoreCodexConnectionRefreshDeps & {
    load?: typeof loadSubscriptionCoreCodexConnectionCredential;
    refreshCredential?: typeof refreshSubscriptionCoreCodexConnectionCredential;
  };

/**
 * Bearer resolver for one operation (or connection read): the same snapshot
 * shape and staleness refresh as chat, with process-wide single-flight per
 * connection and generation. Only connection-level outcomes are shared; a
 * refused authorization belongs to the operation that hit it.
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
  const holderKey = ref
    ? `${ref.operationId}:${ref.holderId}:${ref.generation}`
    : `connection:${connectionId}`;
  const load = async (): Promise<SubscriptionCoreCodexConnectionCredential> => {
    const loaded = await loadCredential(db, settings, scope, connectionId, ref);
    if (loaded.kind === "loaded") return loaded.credential;
    if (loaded.kind === "needs_relogin") {
      throw new CodexReloginRequired("The Codex subscription needs a new sign-in.");
    }
    throw new SubscriptionCoreCodexOperationUnavailableError();
  };
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
  const runOwn = (credential: SubscriptionCoreCodexConnectionCredential) =>
    refreshCredential(db, settings, scope, connectionId, ref, credential.refreshGeneration, deps);
  const shared = async (credential: SubscriptionCoreCodexConnectionCredential) => {
    const key = `${connectionId}:${credential.refreshGeneration}`;
    const existing = connectionInflight.get(key);
    if (existing) {
      const outcome = await existing.promise;
      return existing.holderKey === holderKey || outcome.kind !== "refused"
        ? outcome
        : await runOwn(credential);
    }
    const flight: ConnectionFlight = {
      holderKey,
      promise:
        Promise.resolve() as unknown as Promise<SubscriptionCoreCodexConnectionRefreshOutcome>,
    };
    flight.promise = runOwn(credential).finally(() => {
      if (connectionInflight.get(key) === flight) connectionInflight.delete(key);
    });
    connectionInflight.set(key, flight);
    return await flight.promise;
  };
  const resolve = async (force: boolean): Promise<CodexCredentialTokenSnapshot> => {
    const credential = await load();
    const expiry = credential.expiresAt ?? accessTokenExpiry(credential.tokens.accessToken);
    const stale =
      force ||
      (expiry
        ? expiry.getTime() <= Date.now() + CODEX_REFRESH_WINDOW_MS
        : credential.lastRefreshAt
          ? credential.lastRefreshAt.getTime() < Date.now() - CODEX_REFRESH_FALLBACK_MS
          : true);
    if (!stale) return snapshot(credential);
    const outcome = await shared(credential);
    switch (outcome.kind) {
      case "refreshed":
        return snapshot(credential, outcome.accessToken, outcome.refreshGeneration);
      case "superseded":
        return snapshot(await load());
      case "relogin":
        throw new CodexReloginRequired(outcome.message);
      case "error":
        throw outcome.error;
      default:
        throw new SubscriptionCoreCodexOperationUnavailableError();
    }
  };
  return { getToken: () => resolve(false), refresh: () => resolve(true) };
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
    if (!(await codexCutoverEnabled(tx, scope.accountId))) return [];
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

/**
 * Record a live usage reading on the connection's quota, fenced on the
 * refresh generation of the bearer that read it (design 2.2). Reports
 * whether it ended a stored exhaustion, which the caller turns into a wake.
 */
export async function recordSubscriptionCoreCodexUsageObservation(
  db: Database,
  scope: Extract<SubscriptionCoreCodexOperationScope, { kind: "workspace" }>,
  connectionId: string,
  observation: SubscriptionQuota,
): Promise<{ applied: boolean; recovered: boolean }> {
  const access = await withOperationScope(db, scope, async (tx) => {
    if (!(await codexCutoverEnabled(tx, scope.accountId)))
      return { applied: false, recovered: false };
    const [connection] = await rawRows<{ refresh_generation: number | string }>(
      tx,
      sql`select refresh_generation from opengeni_private.read_subscription_codex_connection_credential(
          ${routineArgs(scope, connectionId, null)}
        )`,
    );
    if (!connection) return { applied: false, recovered: false };
    const refreshGeneration = Number(connection.refresh_generation);
    const [row] = await rawRows<{
      quota: unknown;
      quota_revision: number | string | null;
      quota_observed_refresh_generation: number | string | null;
      quota_updated_at: Date | string | null;
    }>(
      tx,
      sql`select quota, revision as quota_revision,
          observed_refresh_generation as quota_observed_refresh_generation,
          updated_at as quota_updated_at
        from subscription_connection_quota
        where account_id = ${scope.accountId}::uuid and connection_id = ${connectionId}::uuid
        for update`,
    );
    const current = row ? decodeSubscriptionQuota(row) : null;
    const next = applyQuotaObservation({ refreshGeneration, quota: current }, observation);
    if (!next || next === current) return { applied: false, recovered: false };
    const observedNow = observation.observedAt ?? Date.now();
    const recovered =
      current !== null &&
      quotaCapacity(current, observedNow).kind === "exhausted" &&
      quotaCapacity(next, observedNow).kind !== "exhausted";
    const stored = {
      windows: next.windows,
      modelCooldowns: next.modelCooldowns,
      exhaustedUntil: next.exhaustedUntil,
      exhaustedKind: next.exhaustedKind,
      source: next.source,
    };
    await tx.execute(
      sql`insert into subscription_connection_quota (
          account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
        ) values (
          ${scope.accountId}::uuid, ${connectionId}::uuid, ${JSON.stringify(stored)}::jsonb,
          ${refreshGeneration}, 1, ${new Date(observedNow).toISOString()}::timestamptz
        )
        on conflict (connection_id) do update
          set quota = excluded.quota,
              observed_refresh_generation = excluded.observed_refresh_generation,
              revision = subscription_connection_quota.revision + 1,
              updated_at = excluded.updated_at
          where subscription_connection_quota.account_id = excluded.account_id`,
    );
    return { applied: true, recovered };
  });
  return access?.value ?? { applied: false, recovered: false };
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
      fetchImpl,
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

/**
 * A route's Codex account id (canonical, or a legacy id kept as an alias by
 * the drained migration) as the canonical core connection id visible in the
 * workspace context; null when neither resolves.
 */
export async function resolveSubscriptionCoreCodexConnectionId(
  db: Database,
  input: { accountId: string; workspaceId: string; connectionId: string },
): Promise<string | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) =>
      await resolveSubscriptionConnectionId(tx, {
        accountId: input.accountId,
        provider: "codex",
        connectionId: input.connectionId,
      }),
  );
}

/**
 * The session's recorded owner for a session-bound operation (realtime):
 * never the viewer or creator. `undefined` when the session is not visible.
 */
export async function readSubscriptionCoreSessionOwner(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<{ ownerSubjectId: string | null } | undefined> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [row] = await rawRows<{ owner_subject_id: string | null }>(
        tx,
        sql`select owner_subject_id from sessions
          where account_id = ${input.accountId}::uuid
            and workspace_id = ${input.workspaceId}::uuid and id = ${input.sessionId}::uuid`,
      );
      return row ? { ownerSubjectId: row.owner_subject_id } : undefined;
    },
  );
}
