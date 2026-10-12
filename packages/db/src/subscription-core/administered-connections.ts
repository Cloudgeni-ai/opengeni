/**
 * Live usage reads of one connection outside a workspace pool, for any
 * provider (design 5.3, "Administered usage reads"): an organization administrator's read of an
 * organization-pool connection on the
 * organization route, and an owner's read of their own personal connection
 * in their own Personal workspace. The workspace connection seam
 * (`operation-connections`) refuses both: it needs a workspace context and
 * serves shared connections only.
 *
 * Two scopes, each with its own authority and nothing borrowed:
 * - `organization_administrator`: the organization context (no workspace),
 *   the organization membership lifecycle lock, the caller's subject and the
 *   organization administrator check (the predicate the connection policies
 *   use), in every transaction. Only a shared, organization-managed
 *   connection (not one a workspace manages) of the provider's registered
 *   kind, not disconnected, is read; credential, refresh and quota writes go
 *   through the administrator's row policies, as the organization usage
 *   inspection of the first core provider does. The membership lock is
 *   waited for at most five seconds (a longer wait refuses the read as not
 *   visible), and a provider request holding it has the same five-second
 *   budget as that inspection.
 * - `personal_owner`: the owner's own Personal workspace context and subject;
 *   every read and write goes through the owner-only routines of migration
 *   0731 (exact owner membership whose Personal workspace this is, current
 *   authority generation, the organization's effective personal-connections
 *   rule, writer context and enabled cutover), and a refresh persists through
 *   the 0707 refresh writers on the capability that routine mints. A shared
 *   workspace, another member and an ownerless caller never reach the
 *   credential.
 *
 * Request custody: these reads have no workspace operation ledger (the
 * organization route has no workspace; the ledger's credential check refuses
 * personal connections). Each provider request runs inside a transaction
 * that holds the per-connection refresh lock and rechecks the caller's
 * authority and the bearer's refresh generation first, with a fixed
 * deadline, `redirect: "error"` and a bounded body; the transaction ends
 * only after the response is buffered, or after an injected transport has
 * joined its aborted work (only native fetch, or a transport that can abort
 * and join, is accepted). A disconnect or refresh waits for the request (both
 * take the refresh lock), and so does an organization membership change on
 * the organization route (its transaction holds the membership lock). An
 * owner's membership or authority change does not wait for a personal
 * request, but no request starts after it, and the quota write rechecks both
 * and drops the reading.
 *
 * Quota writes are fenced on the refresh generation they read, not taken
 * under the refresh lock: a reconnect that commits between that read and the
 * write can let one older reading land, stamped with its own generation, as
 * on the workspace path.
 *
 * Every probe outcome is reported, never thrown, in the workspace seam's
 * shape (`SubscriptionCoreUsageProbe`). Nothing here changes allocation,
 * policies or assignments.
 */
import { sql } from "drizzle-orm";
import type { Settings } from "@opengeni/config";
import type { SubscriptionCoreConnectionRead, SubscriptionQuota } from "@opengeni/subscriptions";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "../database";
import { nestedPostgresSqlState } from "../persistence-errors";
import {
  buildSubscriptionCoreCredentialResolver,
  subscriptionCoreRefreshPolicy,
} from "./credential-resolver";
import type {
  SubscriptionCoreConnectionToken,
  SubscriptionCoreUsageProbe,
} from "./operation-connections";
import {
  subscriptionCoreOperations,
  type SubscriptionCoreConnectionCredential,
  type SubscriptionCoreConnectionCredentialRow,
  type SubscriptionCoreConnectionRefreshDeps,
  type SubscriptionCoreConnectionRefreshOutcome,
  type SubscriptionCoreCredentialRefreshWriter,
  type SubscriptionCoreFetch,
  type SubscriptionCoreStoredQuotaRow,
} from "./operations";
import {
  memoByProvider,
  subscriptionCoreConnectionKind,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./provider";
import { readSubscriptionProviderCutoverState } from "../subscription-core-repository";

/** Who reads the connection, and in which context. */
export type SubscriptionCoreAdministeredScope =
  | {
      /** An organization administrator on the organization route (no workspace). */
      kind: "organization_administrator";
      accountId: string;
      subjectId: string;
    }
  | {
      /** The owner of a personal connection, in their own Personal workspace. */
      kind: "personal_owner";
      accountId: string;
      workspaceId: string;
      subjectId: string;
    };

export type SubscriptionCoreAdministeredProbeDeps = {
  /**
   * The physical transport (default: global fetch). Anything other than
   * native fetch must abort and join its local work for a signal
   * (`SubscriptionCoreAdministeredJoinedFetch`); any other transport is
   * refused before a credential is loaded.
   */
  fetchImpl?: SubscriptionCoreFetch | SubscriptionCoreAdministeredJoinedFetch;
  /** As for the workspace probe: the product models the connection can serve. */
  modelIds?: readonly string[];
  refresh?: SubscriptionCoreConnectionRefreshDeps;
};

/**
 * An injected transport must cancel and join its local work for this exact
 * signal before the returned promise resolves, as for the organization usage
 * inspection of the first core provider: the custody transaction awaits it,
 * so no request outlives the transaction that rechecked its authority.
 */
export type SubscriptionCoreAdministeredJoinedFetch = SubscriptionCoreFetch & {
  abortAndJoin: (signal: AbortSignal) => Promise<void>;
};

/**
 * The request deadline, including the locks and recheck before it: on the
 * organization route (which holds the organization membership lock for the
 * request) the five seconds of the first core provider's organization
 * inspection, and ten seconds for an owner's personal read.
 */
export const SUBSCRIPTION_CORE_ADMINISTERED_READ_TIMEOUT_MS = {
  organization_administrator: 5_000,
  personal_owner: 10_000,
} as const;
/** The longest wait for the organization membership lock before refusing. */
const ORGANIZATION_MEMBERSHIP_LOCK_TIMEOUT = "5s";
const ADMINISTERED_READ_MAX_BYTES = 1024 * 1024;
const nativeFetch: SubscriptionCoreFetch = fetch;

/** The join of an injected transport; null for native fetch; throws for any other. */
function joinedTransport(fetchImpl: SubscriptionCoreFetch) {
  if (fetchImpl === nativeFetch) return null;
  const candidate = fetchImpl as Partial<SubscriptionCoreAdministeredJoinedFetch>;
  if (typeof candidate.abortAndJoin !== "function")
    throw new Error("An administered usage read requires an abort-and-join transport");
  return candidate.abortAndJoin.bind(fetchImpl);
}

class NotVisible extends Error {}
class Relogin extends Error {}

/** The reads and writes of one scope for one connection. */
type Access = {
  /** Run `use` under the scope's authority; null when it no longer holds. */
  scoped<T>(db: Database, use: (tx: Database) => Promise<T>): Promise<{ value: T } | null>;
  /** The connection's credential row (null: not visible to this scope). */
  credentialRow(tx: Database): Promise<SubscriptionCoreConnectionCredentialRow | null>;
  writer: SubscriptionCoreCredentialRefreshWriter;
  /** Record one usage observation, fenced on the refresh generation. */
  record(
    tx: Database,
    observation: SubscriptionQuota,
  ): Promise<{ applied: boolean; recovered: boolean }>;
};

/** Administered connection reads bound to one provider (memoized per binding). */
export const subscriptionCoreAdministeredConnections = memoByProvider(
  (provider: SubscriptionCoreProvider) => {
    const providerId = subscriptionCoreProviderId(provider);
    const operations = () => subscriptionCoreOperations(provider);

    function organizationAccess(
      scope: Extract<SubscriptionCoreAdministeredScope, { kind: "organization_administrator" }>,
      connectionId: string,
    ): Access {
      const target = sql`connection.account_id = ${scope.accountId}::uuid
        and connection.id = ${connectionId}::uuid and connection.provider = ${providerId}
        and connection.kind = ${subscriptionCoreConnectionKind(provider)}
        and connection.ownership = 'shared' and connection.managed_by_workspace_id is null
        and connection.disconnected_at is null`;
      const credentialRow = async (tx: Database) => {
        const [row] = await rawRows<SubscriptionCoreConnectionCredentialRow>(
          tx,
          sql`select connection.status, connection.refresh_generation,
            connection.credential_encrypted, connection.expires_at, connection.last_refresh_at,
            connection.provider_account_id, connection.plan_type, connection.provider_state
          from subscription_connections connection where ${target}`,
        );
        return row ?? null;
      };
      return {
        async scoped(db, use) {
          try {
            return await withRlsContext(
              db,
              { accountId: scope.accountId, workspaceId: null },
              async (tx) => {
                // The organization membership lifecycle key, before the
                // administrator check, so a demotion cannot commit while
                // this transaction acts on its result. A bounded wait: a
                // busy organization refuses the read rather than queueing.
                await tx.execute(
                  sql`select set_config('lock_timeout', ${ORGANIZATION_MEMBERSHIP_LOCK_TIMEOUT}, true)`,
                );
                try {
                  await tx.execute(
                    sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${scope.accountId}`}, 0))`,
                  );
                } catch (error) {
                  if (nestedPostgresSqlState(error) === "55P03") throw new NotVisible();
                  throw error;
                }
                await setSubjectRlsContext(tx, scope.subjectId);
                const [admin] = await rawRows<{ admin: boolean }>(
                  tx,
                  sql`select opengeni_private.subscription_organization_admin(${scope.accountId}::uuid) as admin`,
                );
                if (admin?.admin !== true) throw new NotVisible();
                if (
                  (await readSubscriptionProviderCutoverState(tx, {
                    accountId: scope.accountId,
                    provider: providerId,
                  })) !== "enabled"
                )
                  throw new NotVisible();
                return { value: await use(tx) };
              },
            );
          } catch (error) {
            if (error instanceof NotVisible) return null;
            throw error;
          }
        },
        credentialRow,
        writer: {
          async begin(tx) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`subscription-refresh:${connectionId}`}, 0))`,
            );
            const row = await credentialRow(tx);
            return row?.status === "active" && row.credential_encrypted
              ? {
                  refreshGeneration: Number(row.refresh_generation),
                  credentialEncrypted: row.credential_encrypted,
                }
              : null;
          },
          async persist(tx, input) {
            const rows = await rawRows<{ id: string }>(
              tx,
              sql`update subscription_connections as connection
              set credential_encrypted = ${input.credentialEncrypted},
                credential_format = split_part(${input.credentialEncrypted}, ':', 1),
                expires_at = ${input.expiresAt?.toISOString() ?? null}::timestamptz,
                last_refresh_at = ${input.refreshedAt.toISOString()}::timestamptz,
                refresh_generation = connection.refresh_generation + 1,
                updated_at = clock_timestamp()
              where ${target} and connection.refresh_generation = ${input.refreshGeneration}
              returning connection.id::text as id`,
            );
            return rows.length > 0;
          },
          async fail(tx, input) {
            const rows = await rawRows<{ id: string }>(
              tx,
              sql`update subscription_connections as connection
              set status = 'needs_relogin',
                last_error = left(coalesce(nullif(btrim(${input.message}), ''), 'Sign-in expired'), 512),
                version = connection.version + 1, updated_at = clock_timestamp()
              where ${target} and connection.status = 'active'
                and connection.refresh_generation = ${input.refreshGeneration}
              returning connection.id::text as id`,
            );
            return rows.length > 0;
          },
        },
        async record(tx, observation) {
          const connection = await credentialRow(tx);
          if (!connection) return { applied: false, recovered: false };
          const refreshGeneration = Number(connection.refresh_generation);
          const [row] = await rawRows<SubscriptionCoreStoredQuotaRow>(
            tx,
            sql`select quota, revision as quota_revision,
              observed_refresh_generation as quota_observed_refresh_generation,
              updated_at as quota_updated_at
            from subscription_connection_quota
            where account_id = ${scope.accountId}::uuid and connection_id = ${connectionId}::uuid
            for update`,
          );
          const write = operations().mergeSubscriptionCoreUsageObservation(
            row ?? null,
            refreshGeneration,
            observation,
          );
          if (!write) return { applied: false, recovered: false };
          await tx.execute(
            sql`insert into subscription_connection_quota (
              account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
            ) values (
              ${scope.accountId}::uuid, ${connectionId}::uuid, ${JSON.stringify(write.stored)}::jsonb,
              ${refreshGeneration}, 1, ${new Date(write.observedAt).toISOString()}::timestamptz
            )
            on conflict (connection_id) do update
              set quota = excluded.quota,
                  observed_refresh_generation = excluded.observed_refresh_generation,
                  revision = subscription_connection_quota.revision + 1,
                  updated_at = excluded.updated_at
              where subscription_connection_quota.account_id = excluded.account_id`,
          );
          return { applied: true, recovered: write.recovered };
        },
      };
    }

    function ownerAccess(
      scope: Extract<SubscriptionCoreAdministeredScope, { kind: "personal_owner" }>,
      connectionId: string,
    ): Access {
      const owner = sql`${providerId}, ${scope.accountId}::uuid, ${scope.workspaceId}::uuid,
        ${scope.subjectId}, ${connectionId}::uuid`;
      const ownedRow = async (tx: Database) => {
        const [row] = await rawRows<
          SubscriptionCoreConnectionCredentialRow & SubscriptionCoreStoredQuotaRow
        >(
          tx,
          sql`select status, refresh_generation, credential_encrypted, expires_at,
            last_refresh_at, provider_account_id, plan_type, provider_state, quota,
            quota_revision, quota_observed_refresh_generation, quota_updated_at
          from opengeni_private.read_subscription_core_owned_connection_credential(${owner})`,
        );
        return row ?? null;
      };
      const tenant = sql`${providerId}, ${scope.accountId}::uuid, ${scope.workspaceId}::uuid,
        ${connectionId}::uuid`;
      return {
        async scoped(db, use) {
          return {
            value: await withRlsContext(
              db,
              { accountId: scope.accountId, workspaceId: scope.workspaceId },
              async (tx) => {
                await setSubjectRlsContext(tx, scope.subjectId);
                return await use(tx);
              },
            ),
          };
        },
        credentialRow: ownedRow,
        writer: {
          async begin(tx) {
            const [row] = await rawRows<{
              refresh_generation: number | string;
              credential_encrypted: string;
            }>(
              tx,
              sql`select refresh_generation, credential_encrypted
              from opengeni_private.begin_subscription_core_owned_connection_refresh(${owner})`,
            );
            return row
              ? {
                  refreshGeneration: Number(row.refresh_generation),
                  credentialEncrypted: row.credential_encrypted,
                }
              : null;
          },
          // The 0707 refresh writers, on the capability `begin` minted.
          async persist(tx, input) {
            const [persisted] = await rawRows<{ persisted: boolean }>(
              tx,
              sql`select opengeni_private.persist_subscription_core_connection_refresh(${tenant},
                ${input.refreshGeneration}::bigint, ${input.credentialEncrypted},
                ${input.expiresAt?.toISOString() ?? null}::timestamptz,
                ${input.refreshedAt.toISOString()}::timestamptz
              ) as persisted`,
            );
            return persisted?.persisted === true;
          },
          async fail(tx, input) {
            const [marked] = await rawRows<{ marked: boolean }>(
              tx,
              sql`select opengeni_private.fail_subscription_core_connection_refresh(${tenant},
                ${input.refreshGeneration}::bigint, ${input.message}
              ) as marked`,
            );
            return marked?.marked === true;
          },
        },
        async record(tx, observation) {
          // Fenced on the generation and on the revision merged from. The
          // other paths merge under the quota row lock; this one merges from
          // the owner reader, so a reading that raced another quota write
          // (at the same generation) re-reads and re-merges once.
          let generation: number | null = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const row = await ownedRow(tx);
            if (!row) break;
            const refreshGeneration = Number(row.refresh_generation);
            if (generation !== null && refreshGeneration !== generation) break;
            generation = refreshGeneration;
            const write = operations().mergeSubscriptionCoreUsageObservation(
              row,
              refreshGeneration,
              observation,
            );
            if (!write) break;
            const [recorded] = await rawRows<{ recorded: boolean }>(
              tx,
              sql`select opengeni_private.record_subscription_core_owned_connection_quota(${owner},
                ${refreshGeneration}::bigint,
                ${row.quota_revision === null ? null : Number(row.quota_revision)}::bigint,
                ${JSON.stringify(write.stored)}::jsonb,
                ${new Date(write.observedAt).toISOString()}::timestamptz
              ) as recorded`,
            );
            if (recorded?.recorded === true) return { applied: true, recovered: write.recovered };
          }
          return { applied: false, recovered: false };
        },
      };
    }

    function access(scope: SubscriptionCoreAdministeredScope, connectionId: string): Access {
      return scope.kind === "organization_administrator"
        ? organizationAccess(scope, connectionId)
        : ownerAccess(scope, connectionId);
    }

    /**
     * The provider HTTP call of a read: in its own transaction, under the
     * per-connection refresh lock, after rechecking the scope's authority
     * and that the stored credential is still active at the bearer's refresh
     * generation. The response is buffered (bounded) before the transaction
     * ends.
     */
    function custodyFetch(
      db: Database,
      scoped: Access,
      connectionId: string,
      bearerGeneration: () => number,
      fetchImpl: SubscriptionCoreFetch,
      abortAndJoin: ((signal: AbortSignal) => Promise<void>) | null,
      deadlineMs: number,
    ): SubscriptionCoreFetch {
      return async (url, init) => {
        const callerSignal = init?.signal ?? undefined;
        callerSignal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () =>
          controller.abort(callerSignal?.reason ?? new Error("The provider read was aborted"));
        callerSignal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(
          () =>
            controller.abort(
              new Error(`${provider.adapter.displayName} read exceeded its deadline`),
            ),
          deadlineMs,
        );
        try {
          const result = await scoped.scoped(db, async (tx) => {
            await tx.execute(sql`set local idle_in_transaction_session_timeout = '15s'`);
            await tx.execute(sql`set local statement_timeout = '10s'`);
            await tx.execute(sql`set local lock_timeout = '5s'`);
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`subscription-refresh:${connectionId}`}, 0))`,
            );
            const row = await scoped.credentialRow(tx);
            if (
              row?.status !== "active" ||
              !row.credential_encrypted ||
              Number(row.refresh_generation) !== bearerGeneration()
            )
              throw new Error("The connection changed before its provider read");
            controller.signal.throwIfAborted();
            let complete = false;
            let teardown: Promise<void> = Promise.resolve();
            const onAbort = () => {
              teardown = Promise.resolve().then(() => abortAndJoin?.(controller.signal));
              // Observe immediately, but keep the original promise: rejection
              // is not quiescence and must reach the awaited custody exit.
              void teardown.catch(() => undefined);
            };
            controller.signal.addEventListener("abort", onAbort, { once: true });
            try {
              const response = await fetchImpl(url, {
                ...init,
                redirect: "error",
                signal: controller.signal,
              });
              const body = await readBounded(response, controller.signal);
              complete = true;
              return new Response(body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            } finally {
              if (!complete) {
                if (!controller.signal.aborted)
                  controller.abort(new Error("The provider read did not complete"));
                // The transaction ends only after an injected transport has
                // joined its local work for this request.
              }
              try {
                await teardown;
              } finally {
                controller.signal.removeEventListener("abort", onAbort);
              }
            }
          });
          if (!result) throw new Error("The connection is no longer readable here");
          return result.value;
        } finally {
          clearTimeout(timer);
          callerSignal?.removeEventListener("abort", abort);
        }
      };
    }

    async function readBounded(
      response: Response,
      signal: AbortSignal,
    ): Promise<Uint8Array<ArrayBuffer> | null> {
      if (!response.body) return null;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      const cancel = () => void reader.cancel().catch(() => undefined);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > ADMINISTERED_READ_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error(
              `${provider.adapter.displayName} read response exceeded its byte limit`,
            );
          }
          chunks.push(next.value);
        }
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", cancel);
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

    /**
     * Live usage of one connection in an administered scope: the same
     * staleness refresh, adapter `fetchUsage`/`decodeQuota` and
     * generation-fenced quota observation as the workspace probe, under the
     * scope's own authority. A relogin is recorded on the connection by the
     * refresh writer; nothing is thrown.
     */
    async function probeSubscriptionCoreAdministeredConnectionUsage(
      db: Database,
      settings: Settings,
      scope: SubscriptionCoreAdministeredScope,
      connectionId: string,
      deps: SubscriptionCoreAdministeredProbeDeps = {},
    ): Promise<SubscriptionCoreUsageProbe> {
      const { fetchUsage, decodeQuota } = provider.adapter;
      if (!fetchUsage || !decodeQuota) return { kind: "unsupported" };
      const fetchImpl = deps.fetchImpl ?? nativeFetch;
      let abortAndJoin: ((signal: AbortSignal) => Promise<void>) | null;
      try {
        // Before any credential is loaded.
        abortAndJoin = joinedTransport(fetchImpl);
      } catch (error) {
        return { kind: "fetch_error", error };
      }
      const scoped = access(scope, connectionId);
      const snapshot = (
        loaded: SubscriptionCoreConnectionCredential,
        credential: unknown = loaded.credential,
        credentialVersion = loaded.refreshGeneration,
      ): SubscriptionCoreConnectionToken => ({
        credential,
        providerAccountId: loaded.providerAccountId,
        providerState: loaded.providerState,
        planType: loaded.planType,
        credentialVersion,
      });
      const resolver = buildSubscriptionCoreCredentialResolver<
        SubscriptionCoreConnectionCredential,
        Extract<SubscriptionCoreConnectionRefreshOutcome, { kind: "refreshed" }>,
        SubscriptionCoreConnectionToken
      >({
        // Each scope refreshes in its own flights.
        flightNamespace: scope.kind,
        connectionId,
        holderKey: `${scope.kind}:${scope.subjectId}:${connectionId}`,
        policy: (loaded) => subscriptionCoreRefreshPolicy(provider.adapter, loaded.credential),
        load: async () => {
          const row = await scoped.scoped(db, (tx) => scoped.credentialRow(tx));
          return operations().subscriptionCoreConnectionCredentialLoad(
            settings,
            connectionId,
            row?.value ?? null,
          );
        },
        embeddedExpiry: (loaded) => provider.adapter.credential.expiry(loaded.credential),
        refresh: async (loaded) =>
          (
            await scoped.scoped(db, (tx) =>
              operations().rotateSubscriptionCoreConnectionCredential(
                tx,
                settings,
                scoped.writer,
                loaded.refreshGeneration,
                deps.refresh,
              ),
            )
          )?.value ?? { kind: "refused" },
        snapshot: (loaded) => snapshot(loaded),
        refreshedSnapshot: (outcome, loaded) =>
          snapshot(loaded, outcome.credential, outcome.refreshGeneration),
        errors: {
          relogin: () => new Relogin(),
          leaseLost: () => new NotVisible(),
          accessLost: () => new NotVisible(),
        },
      });
      let token: SubscriptionCoreConnectionToken;
      try {
        token = await resolver.getToken();
      } catch (error) {
        if (error instanceof NotVisible) return { kind: "not_visible" };
        if (error instanceof Relogin) return { kind: "relogin" };
        return { kind: "token_error", error };
      }
      const read: SubscriptionCoreConnectionRead<unknown> = {
        getToken: async () => token,
        refresh: async () => {
          token = await resolver.refresh();
          return token;
        },
        fetch: custodyFetch(
          db,
          scoped,
          connectionId,
          () => token.credentialVersion,
          fetchImpl,
          abortAndJoin,
          SUBSCRIPTION_CORE_ADMINISTERED_READ_TIMEOUT_MS[scope.kind],
        ),
      };
      let response: unknown;
      try {
        response = await fetchUsage.call(provider.adapter, read);
      } catch (error) {
        return { kind: "fetch_error", error };
      }
      const quota = decodeQuota.call(provider.adapter, {
        response,
        observedAt: Date.now(),
        refreshGeneration: token.credentialVersion,
        ...(deps.modelIds ? { modelIds: deps.modelIds } : {}),
      });
      if (!quota) return { kind: "read", response, quota: null, applied: false, recovered: false };
      const recorded = await scoped.scoped(db, (tx) => scoped.record(tx, quota)).catch(() => null);
      return {
        kind: "read",
        response,
        quota,
        applied: recorded?.value.applied === true,
        recovered: recorded?.value.recovered === true,
      };
    }

    return { probeSubscriptionCoreAdministeredConnectionUsage };
  },
);
