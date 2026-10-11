/**
 * Operations outside chat on the shared subscription core, for any provider:
 * image generation, realtime and transcription, plus the connection-level
 * credential reads behind live usage and reset credits.
 *
 * Dormant until an organization's cutover row for the provider is enabled:
 * every read, lease and refresh re-checks the enabled cutover in its own
 * transaction (the credential routines return nothing otherwise), so
 * switch-off fails closed mid-operation. Nothing here writes the chat
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
 * shared with chat refresh.
 */
import { sql } from "drizzle-orm";

import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";

import {
  applyQuotaObservation,
  quotaCapacity,
  subscriptionCoreCredentialRefresher,
  type SubscriptionQuota,
} from "@opengeni/subscriptions";

import { rawRows, withRlsContext, withSessionRlsActorContext, type Database } from "../database";

import { decryptEnvironmentValue, encryptEnvironmentValue } from "../environment-crypto";

import { withSubscriptionCoreAcceptedTurn } from "../subscription-core-placement-world";

import { subscriptionCoreTurns, type SubscriptionCoreTurnIdentity } from "./turns";

import { subscriptionCoreRequests } from "./requests";

import {
  memoByProvider,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./provider";

import {
  acquireSubscriptionOperationLease,
  decodeSubscriptionQuota,
  readSubscriptionProviderCutoverState,
  releaseSubscriptionOperationLease,
  renewSubscriptionOperationLease,
  resolveSubscriptionConnectionId,
  type SubscriptionOperationKind,
  type SubscriptionOperationLeaseIdentity,
} from "../subscription-core-repository";

const CORE_SUBSCRIPTION_SUBJECT = "service:subscription-core";

/** A provider HTTP call (the global `fetch` shape the provider clients accept). */
export type SubscriptionCoreFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

type SubscriptionCoreRequests = ReturnType<typeof subscriptionCoreRequests>;

/** Default lease for one operation; renewed before each provider dispatch. */
export const SUBSCRIPTION_CORE_OPERATION_LEASE_TTL_MS = 5 * 60 * 1000;

// These adapters return finite JSON/SDP, never model/SSE streams. In particular,
// do not bypass realtime's bounded SDP reader with an unbounded eager buffer.
const OPERATION_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

export type SubscriptionCoreOperationScope =
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
export type SubscriptionCoreOperationLeaseRef = {
  operationId: string;
  attemptId: string;
  operationKind: SubscriptionOperationKind;
  connectionId: string;
  holderId: string;
  generation: number;
};

function scopeTenant(scope: SubscriptionCoreOperationScope): {
  accountId: string;
  workspaceId: string;
} {
  return scope.kind === "turn"
    ? { accountId: scope.identity.accountId, workspaceId: scope.identity.workspaceId }
    : { accountId: scope.accountId, workspaceId: scope.workspaceId };
}

function isRlsRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "42501" || causeCode === "42501";
}

export type SubscriptionCoreOperationLeaseResult =
  | { kind: "acquired"; leasedUntil: Date }
  /** Another live holder or generation owns this operation id. */
  | { kind: "busy" }
  /** The cutover is not enabled, or the turn is no longer the accepted turn. */
  | { kind: "not_enabled" }
  /** The database refused the connection for this operation's authority. */
  | { kind: "refused" };

export type SubscriptionCoreConnectionCredential<Credential = unknown> = {
  connectionId: string;
  refreshGeneration: number;
  /** The decoded secret (the adapter's credential codec). */
  credential: Credential;
  providerAccountId: string | null;
  /** Provider-owned connection facts; only the provider's adapter interprets them. */
  providerState: Record<string, unknown>;
  planType: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
};

export type SubscriptionCoreConnectionCredentialLoad =
  | { kind: "loaded"; credential: SubscriptionCoreConnectionCredential }
  /** No live operation lease, no enabled cutover, or the connection is out of scope. */
  | { kind: "not_visible" }
  | { kind: "needs_relogin" }
  | { kind: "unavailable" };

export type SubscriptionCoreConnectionRefreshOutcome =
  | { kind: "refreshed"; credential: unknown; refreshGeneration: number }
  | { kind: "superseded" }
  | { kind: "relogin"; message: string; marked: boolean }
  | { kind: "refused" }
  | { kind: "error"; error: unknown };

export type SubscriptionCoreConnectionRefreshDeps = {
  now?: () => Date;
};

export const SUBSCRIPTION_MODEL_CATALOG_TTL_MS = 60_000;

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

/** The operations runtime bound to one provider (memoized per binding). */
export const subscriptionCoreOperations = memoByProvider((provider: SubscriptionCoreProvider) => {
  const providerId = subscriptionCoreProviderId(provider);
  /**
   * Run `operation` in the scope's exact RLS context. `null` means the turn is
   * no longer the accepted turn it claims to be (or is not visible).
   */
  async function withOperationScope<T>(
    db: Database,
    scope: SubscriptionCoreOperationScope,
    operation: (tx: Database) => Promise<T>,
  ): Promise<{ value: T } | null> {
    if (scope.kind === "turn") {
      const access = await withSubscriptionCoreAcceptedTurn(db, scope.identity, async (tx) => {
        await subscriptionCoreTurns(provider).authorizeSubscriptionCoreFrozenPersonal(
          tx,
          scope.identity,
        );
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

  /**
   * Physical request custody for the finite JSON/SDP non-chat transports. An
   * operation lease is access authority, never permission to send another HTTP
   * request after disconnect. Each invocation commits a fresh native reservation
   * before fetch, and retains the already-loaded bearer only for that request.
   *
   * Buffer the complete response before returning it: headers, cancellation and
   * lease release are not EOF. Existing provider deadlines still bound the call;
   * a fetch implementation that ignores abort may finish later, but its aborted
   * reservation remains unknown and is never replayed here. Not for chat/SSE.
   */
  function buildSubscriptionCoreOperationFetch(
    db: Database,
    scope: SubscriptionCoreOperationScope,
    ref: SubscriptionCoreOperationLeaseRef | null,
    connectionId: string,
    fetchImpl: SubscriptionCoreFetch = fetch,
    deps: {
      /** Reuse a durable logical identity when the caller has one (transcription). */
      requestId?: string;
      reserve?: SubscriptionCoreRequests["reserveSubscriptionCoreOperationRequest"];
      settle?: SubscriptionCoreRequests["settleSubscriptionCoreOperationRequest"];
    } = {},
  ): SubscriptionCoreFetch {
    const requestId = deps.requestId ?? crypto.randomUUID();
    let transportAttempt = 0;
    const reserve =
      deps.reserve ?? subscriptionCoreRequests(provider).reserveSubscriptionCoreOperationRequest;
    const settle =
      deps.settle ?? subscriptionCoreRequests(provider).settleSubscriptionCoreOperationRequest;
    return async (url, init) => {
      const signal = init?.signal;
      signal?.throwIfAborted();
      const { operationId } = await reserve(db, scope, ref, connectionId, {
        requestId,
        transportAttempt: ++transportAttempt,
      });
      let settled = false;
      const finish = async (outcome: "response_received" | "refused" | "unknown") => {
        if (settled) return;
        settled = true;
        // Settlement failure leaves the native nonsecret reservation unresolved;
        // it must not turn an observed response into a retry of the provider call.
        await settle(db, scope, { operationId, outcome }).catch(() => undefined);
      };
      if (signal?.aborted) {
        await finish("refused");
        signal.throwIfAborted();
      }
      const onAbort = () => void finish("unknown");
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Native redirect following would perform another physical request
        // without a reservation. These fixed provider endpoints do not redirect.
        const response = await fetchImpl(url, { ...init, redirect: "error" });
        const body = await readOperationResponse(response);
        await finish("response_received");
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        await finish("unknown");
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    };
  }

  async function readOperationResponse(
    response: Response,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > OPERATION_RESPONSE_MAX_BYTES) {
          // Cancelling an oversized body is not remote completion. The caller
          // records unknown, and the provider operation is never replayed.
          void reader.cancel().catch(() => undefined);
          throw new Error(
            `${provider.adapter.displayName} operation response exceeded its byte limit`,
          );
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async function cutoverEnabled(tx: Database, accountId: string): Promise<boolean> {
    return (
      (await readSubscriptionProviderCutoverState(tx, { accountId, provider: providerId })) ===
      "enabled"
    );
  }

  function leaseIdentity(
    scope: SubscriptionCoreOperationScope,
    ref: SubscriptionCoreOperationLeaseRef,
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
      provider: providerId,
      connectionId: ref.connectionId,
      holderId: ref.holderId,
      generation: ref.generation,
    };
  }

  /**
   * Take the per-operation lease. A retry of the same attempt, holder and
   * generation is idempotent; a newer generation replaces only an expired
   * lease. The chat-turn lease is never read or written.
   */
  async function acquireSubscriptionCoreOperationLease(
    db: Database,
    scope: SubscriptionCoreOperationScope,
    ref: SubscriptionCoreOperationLeaseRef,
    ttlMs = SUBSCRIPTION_CORE_OPERATION_LEASE_TTL_MS,
  ): Promise<SubscriptionCoreOperationLeaseResult> {
    try {
      const access = await withOperationScope(
        db,
        scope,
        async (tx): Promise<SubscriptionCoreOperationLeaseResult> => {
          if (!(await cutoverEnabled(tx, scopeTenant(scope).accountId))) {
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
  async function renewSubscriptionCoreOperationLease(
    db: Database,
    scope: SubscriptionCoreOperationScope,
    ref: SubscriptionCoreOperationLeaseRef,
    ttlMs = SUBSCRIPTION_CORE_OPERATION_LEASE_TTL_MS,
  ): Promise<Date | null> {
    const access = await withOperationScope(db, scope, async (tx) => {
      if (!(await cutoverEnabled(tx, scopeTenant(scope).accountId))) return null;
      // Renewal touches only the expiry, so the lease guard does not rerun:
      // re-check the full operation authority (live turn attempt and chat
      // lease, scope, personal authority and settings) before extending it.
      const [current] = await rawRows<{ status: string }>(
        tx,
        sql`select status from opengeni_private.read_subscription_core_connection_credential(${providerId},
          ${routineArgs(scope, ref.connectionId, ref)}
        )`,
      );
      if (!current || current.status !== "active") return null;
      return await renewSubscriptionOperationLease(tx, { ...leaseIdentity(scope, ref), ttlMs });
    });
    return access?.value ?? null;
  }

  /** Release is fenced by operation, attempt, holder and generation. */
  async function releaseSubscriptionCoreOperationLease(
    db: Database,
    scope: SubscriptionCoreOperationScope,
    ref: SubscriptionCoreOperationLeaseRef,
  ): Promise<boolean> {
    const access = await withOperationScope(db, scope, (tx) =>
      releaseSubscriptionOperationLease(tx, leaseIdentity(scope, ref)),
    );
    return access?.value === true;
  }

  function encryptionKey(settings: Settings): Uint8Array {
    const key = environmentsEncryptionKeyBytes(settings);
    if (!key) {
      throw new Error(
        `core ${provider.adapter.displayName} credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured`,
      );
    }
    return key;
  }

  function decodeCredential(key: Uint8Array, encrypted: string): unknown {
    let plaintext: string;
    try {
      plaintext = decryptEnvironmentValue(key, encrypted);
    } catch {
      // Fixed text and no cause: never echo ciphertext or key material.
      throw new Error(`A core ${provider.adapter.displayName} credential could not be decrypted`);
    }
    return provider.adapter.credential.decode(plaintext);
  }

  function routineArgs(
    scope: SubscriptionCoreOperationScope,
    connectionId: string,
    ref: SubscriptionCoreOperationLeaseRef | null,
  ) {
    const tenant = scopeTenant(scope);
    return sql`${tenant.accountId}::uuid, ${tenant.workspaceId}::uuid, ${connectionId}::uuid,
    ${ref?.operationId ?? null}::uuid, ${ref?.attemptId ?? null}::uuid,
    ${ref?.holderId ?? null}::text, ${ref?.generation ?? null}::bigint`;
  }

  function assertRefMatches(
    connectionId: string,
    ref: SubscriptionCoreOperationLeaseRef | null,
  ): void {
    if (ref && ref.connectionId !== connectionId) {
      throw new Error(
        `A core ${provider.adapter.displayName} operation lease does not hold the requested connection`,
      );
    }
  }

  /**
   * Read one connection's credential for an exact operation lease (or, with
   * `ref = null`, for a `workspace`-scope connection read such as usage or
   * reset credits). Never reads a legacy table.
   */
  async function loadSubscriptionCoreConnectionCredential(
    db: Database,
    settings: Settings,
    scope: SubscriptionCoreOperationScope,
    connectionId: string,
    ref: SubscriptionCoreOperationLeaseRef | null,
  ): Promise<SubscriptionCoreConnectionCredentialLoad> {
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
        provider_state: Record<string, unknown> | null;
      }>(
        tx,
        sql`select status, refresh_generation, credential_encrypted, expires_at, last_refresh_at,
          provider_account_id, plan_type, provider_state
        from opengeni_private.read_subscription_core_connection_credential(${providerId},
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
        credential: decodeCredential(key, row.credential_encrypted),
        providerAccountId: row.provider_account_id,
        providerState: row.provider_state ?? {},
        planType: row.plan_type,
        expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
        lastRefreshAt: row.last_refresh_at === null ? null : new Date(row.last_refresh_at),
      },
    };
  }

  /**
   * Rotate the connection's refresh token under the per-connection advisory
   * key. Authorization (live operation lease, scope, enabled cutover) happens
   * in begin, before the provider call; the rotated token is persisted
   * immediately after it returns.
   */
  async function refreshSubscriptionCoreConnectionCredential(
    db: Database,
    settings: Settings,
    scope: SubscriptionCoreOperationScope,
    connectionId: string,
    ref: SubscriptionCoreOperationLeaseRef | null,
    observedRefreshGeneration: number,
    deps: SubscriptionCoreConnectionRefreshDeps = {},
  ): Promise<SubscriptionCoreConnectionRefreshOutcome> {
    assertRefMatches(connectionId, ref);
    const key = encryptionKey(settings);
    const now = deps.now ?? (() => new Date());
    const tenant = scopeTenant(scope);
    const access = await withOperationScope(
      db,
      scope,
      async (tx): Promise<SubscriptionCoreConnectionRefreshOutcome> => {
        await tx.execute(sql`set local lock_timeout = '30s'`);
        const [credential] = await rawRows<{
          refresh_generation: number | string;
          credential_encrypted: string;
        }>(
          tx,
          sql`select refresh_generation, credential_encrypted
          from opengeni_private.begin_subscription_core_connection_refresh(${providerId},
            ${routineArgs(scope, connectionId, ref)}
          )`,
        );
        if (!credential) return { kind: "refused" };
        const generation = Number(credential.refresh_generation);
        if (generation !== observedRefreshGeneration) return { kind: "superseded" };
        let current: unknown;
        try {
          current = decodeCredential(key, credential.credential_encrypted);
        } catch (error) {
          return { kind: "error", error };
        }
        // Renewal depends on the credential's format, never on the provider.
        const refresher = subscriptionCoreCredentialRefresher(provider.adapter, current);
        if (!refresher) {
          // A credential that never renews is refreshed only when it expired
          // or the provider refused it: only a new sign-in recovers.
          const message = provider.adapter.reloginText("");
          const [marked] = await rawRows<{ marked: boolean }>(
            tx,
            sql`select opengeni_private.fail_subscription_core_connection_refresh(${providerId},
              ${tenant.accountId}::uuid, ${tenant.workspaceId}::uuid, ${connectionId}::uuid,
              ${generation}::bigint, ${message}
            ) as marked`,
          );
          return { kind: "relogin", message, marked: marked?.marked === true };
        }
        try {
          const rotated = await refresher.rotate(current);
          // Persist before any other fallible work: a rolled-back transaction
          // would discard the only valid refresh token.
          const [persisted] = await rawRows<{ persisted: boolean }>(
            tx,
            sql`select opengeni_private.persist_subscription_core_connection_refresh(${providerId},
              ${tenant.accountId}::uuid, ${tenant.workspaceId}::uuid, ${connectionId}::uuid,
              ${generation}::bigint,
              ${encryptEnvironmentValue(key, provider.adapter.credential.encode(rotated.credential))},
              ${rotated.expiresAt?.toISOString() ?? null}::timestamptz,
              ${now().toISOString()}::timestamptz
            ) as persisted`,
          );
          if (persisted?.persisted !== true) return { kind: "superseded" };
          return {
            kind: "refreshed",
            credential: rotated.credential,
            refreshGeneration: generation + 1,
          };
        } catch (error) {
          const relogin = refresher.reloginMessage(error);
          if (relogin !== null) {
            const [marked] = await rawRows<{ marked: boolean }>(
              tx,
              sql`select opengeni_private.fail_subscription_core_connection_refresh(${providerId},
                ${tenant.accountId}::uuid, ${tenant.workspaceId}::uuid, ${connectionId}::uuid,
                ${generation}::bigint, ${provider.adapter.reloginText(relogin)}
              ) as marked`,
            );
            return { kind: "relogin", message: relogin, marked: marked?.marked === true };
          }
          return { kind: "error", error };
        }
      },
    );
    return access?.value ?? { kind: "refused" };
  }

  /** Store a shared connection's successful catalog read without altering quota or admin policy. */
  async function recordSubscriptionCoreModelCatalog(
    db: Database,
    scope: Extract<SubscriptionCoreOperationScope, { kind: "workspace" }>,
    connectionId: string,
    observation: { slugs: readonly string[]; refreshGeneration: number; observedAt: number },
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(observation.refreshGeneration) ||
      observation.refreshGeneration < 1 ||
      !Number.isFinite(observation.observedAt)
    )
      return false;
    const access = await withOperationScope(db, scope, async (tx) => {
      if (!(await cutoverEnabled(tx, scope.accountId))) return false;
      // The existing credential seam rechecks live connection scope and refuses
      // personal accounts outside an exact accepted turn.
      const [connection] = await rawRows<{ refresh_generation: number | string }>(
        tx,
        sql`select refresh_generation from opengeni_private.read_subscription_core_connection_credential(${providerId},
        ${routineArgs(scope, connectionId, null)})`,
      );
      if (!connection || Number(connection.refresh_generation) !== observation.refreshGeneration)
        return false;
      const [written] = await rawRows<{ connection_id: string }>(
        tx,
        sql`insert into subscription_connection_quota (account_id, connection_id,
        model_catalog_slugs, model_catalog_refresh_generation, model_catalog_observed_at, model_catalog_expires_at)
        values (${scope.accountId}::uuid, ${connectionId}::uuid, ARRAY[${sql.join(
          observation.slugs.map((slug) => sql`${slug}`),
          sql`, `,
        )}]::text[],
          ${observation.refreshGeneration}, ${new Date(observation.observedAt).toISOString()}::timestamptz,
          ${new Date(observation.observedAt + SUBSCRIPTION_MODEL_CATALOG_TTL_MS).toISOString()}::timestamptz)
        on conflict (connection_id) do update set
          model_catalog_slugs = excluded.model_catalog_slugs,
          model_catalog_refresh_generation = excluded.model_catalog_refresh_generation,
          model_catalog_observed_at = excluded.model_catalog_observed_at,
          model_catalog_expires_at = excluded.model_catalog_expires_at
        where subscription_connection_quota.account_id = excluded.account_id and
          (subscription_connection_quota.model_catalog_refresh_generation is null
            or subscription_connection_quota.model_catalog_refresh_generation < excluded.model_catalog_refresh_generation
            or (subscription_connection_quota.model_catalog_refresh_generation = excluded.model_catalog_refresh_generation
              and subscription_connection_quota.model_catalog_observed_at < excluded.model_catalog_observed_at))
        returning connection_id::text`,
      );
      return !!written;
    });
    return access?.value ?? false;
  }

  /**
   * Record a live usage reading on the connection's quota, fenced on the
   * refresh generation of the bearer that read it (design 2.2). Reports
   * whether it ended a stored exhaustion, which the caller turns into a wake.
   */
  async function recordSubscriptionCoreUsageObservation(
    db: Database,
    scope: Extract<SubscriptionCoreOperationScope, { kind: "workspace" }>,
    connectionId: string,
    observation: SubscriptionQuota,
  ): Promise<{ applied: boolean; recovered: boolean }> {
    const access = await withOperationScope(db, scope, async (tx) => {
      if (!(await cutoverEnabled(tx, scope.accountId))) return { applied: false, recovered: false };
      const [connection] = await rawRows<{ refresh_generation: number | string }>(
        tx,
        sql`select refresh_generation from opengeni_private.read_subscription_core_connection_credential(${providerId},
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
      const observed = applyQuotaObservation({ refreshGeneration, quota: current }, observation);
      if (!observed || observed === current) return { applied: false, recovered: false };
      // An authoritative usage read below the limit ends a quota exhaustion
      // (adapter opt-in; this row is locked, and the write bumps its revision).
      const next =
        provider.adapter.usageReadEndsQuotaExhaustion === true &&
        observation.source === "usage_endpoint" &&
        observation.exhaustedUntil === null &&
        observed.exhaustedKind === "quota"
          ? { ...observed, exhaustedUntil: null, exhaustedKind: null }
          : observed;
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

  /**
   * A route's account id (canonical, or a legacy id kept as an alias by
   * the drained migration) as the canonical core connection id visible in the
   * workspace context; null when neither resolves.
   */
  async function resolveSubscriptionCoreConnectionId(
    db: Database,
    input: { accountId: string; workspaceId: string; connectionId: string },
  ): Promise<string | null> {
    return await withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (tx) =>
        await resolveSubscriptionConnectionId(tx, {
          accountId: input.accountId,
          provider: providerId,
          connectionId: input.connectionId,
        }),
    );
  }

  return {
    withOperationScope,
    buildSubscriptionCoreOperationFetch,
    acquireSubscriptionCoreOperationLease,
    renewSubscriptionCoreOperationLease,
    releaseSubscriptionCoreOperationLease,
    loadSubscriptionCoreConnectionCredential,
    refreshSubscriptionCoreConnectionCredential,
    recordSubscriptionCoreModelCatalog,
    recordSubscriptionCoreUsageObservation,
    resolveSubscriptionCoreConnectionId,
  };
});
