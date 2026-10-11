/**
 * Connection-level pieces of the operations runtime, for any provider:
 * which shared connections may serve an operation outside chat (candidate
 * ordering), a refreshing bearer resolver for one connection under an
 * operation lease or a workspace connection read, running an operation on
 * the first candidate whose lease is granted, and the out-of-turn usage and
 * live-catalog probes that the provider's adapter implements
 * (`fetchUsage`, `decodeQuota`, `liveModels`).
 *
 * Shared-only by construction: candidates are organization- or
 * workspace-scoped shared connections in the workspace's effective pool, and
 * the credential seam refuses every other connection outside an exact
 * accepted turn. Nothing here writes the chat session binding.
 */
import { sql } from "drizzle-orm";
import type { Settings } from "@opengeni/config";
import type {
  SubscriptionCoreConnectionBearer,
  SubscriptionCoreConnectionRead,
  SubscriptionQuota,
} from "@opengeni/subscriptions";
import { rawRows, type Database } from "../database";
import { readSubscriptionCoreWorkspacePool } from "./administration";
import {
  buildSubscriptionCoreCredentialResolver,
  subscriptionCoreRefreshPolicy,
} from "./credential-resolver";
import { SubscriptionCoreError } from "./errors";
import {
  subscriptionCoreOperations,
  type SubscriptionCoreConnectionCredential,
  type SubscriptionCoreConnectionCredentialLoad,
  type SubscriptionCoreConnectionRefreshDeps,
  type SubscriptionCoreConnectionRefreshOutcome,
  type SubscriptionCoreFetch,
  type SubscriptionCoreOperationLeaseRef,
  type SubscriptionCoreOperationScope,
} from "./operations";
import {
  memoByProvider,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./provider";
import {
  readSubscriptionProviderCutoverState,
  readSubscriptionSessionBinding,
  type SubscriptionOperationKind,
} from "../subscription-core-repository";

export type SubscriptionCoreOperationCandidate = {
  connectionId: string;
  planType: string | null;
  /** The session's explicit choice (session scope only). */
  explicit: boolean;
  /** The connection's model allowlist (null: every model). */
  allowedModelIds: string[] | null;
};

/** One connection's bearer for an operation, with the generation that minted it. */
export type SubscriptionCoreConnectionToken<Credential = unknown> =
  SubscriptionCoreConnectionBearer<Credential> & {
    planType: string | null;
    /** The refresh generation of this bearer (fences quota observations). */
    credentialVersion: number;
  };

export type SubscriptionCoreConnectionResolverDeps = SubscriptionCoreConnectionRefreshDeps & {
  /** Test seams for the credential read and the refresh under the core lock. */
  load?: (
    db: Database,
    settings: Settings,
    scope: SubscriptionCoreOperationScope,
    connectionId: string,
    ref: SubscriptionCoreOperationLeaseRef | null,
  ) => Promise<SubscriptionCoreConnectionCredentialLoad>;
  refreshCredential?: (
    db: Database,
    settings: Settings,
    scope: SubscriptionCoreOperationScope,
    connectionId: string,
    ref: SubscriptionCoreOperationLeaseRef | null,
    observedRefreshGeneration: number,
    deps: SubscriptionCoreConnectionRefreshDeps,
  ) => Promise<SubscriptionCoreConnectionRefreshOutcome>;
  /** The caller's relogin error (default: a core error with the adapter's text). */
  relogin?: (message: string | null) => Error;
  /** The caller's lost-operation error (default: the binding's `operationUnavailable`). */
  unavailable?: () => Error;
};

/** What a probe reports; provider and refresh failures never throw. */
export type SubscriptionCoreUsageProbe =
  /** The adapter has no usage probe. */
  | { kind: "unsupported" }
  /** Not readable in this workspace context (for example a personal connection). */
  | { kind: "not_visible" }
  | { kind: "relogin" }
  | { kind: "token_error"; error: unknown }
  | { kind: "fetch_error"; error: unknown }
  | {
      kind: "read";
      /** The adapter's decoded-or-raw usage response. */
      response: unknown;
      /** The recorded observation, or null when the response carried none. */
      quota: SubscriptionQuota | null;
      /** The observation ended a stored exhaustion (the caller wakes waiters). */
      recovered: boolean;
    };

export type SubscriptionCoreLiveModelsProbe =
  | { kind: "unsupported" }
  | { kind: "not_visible" }
  | { kind: "relogin" }
  | { kind: "error"; error: unknown }
  | { kind: "read"; modelIds: readonly string[] };

export type SubscriptionCoreConnectionProbeDeps = {
  /** The physical transport under request custody (default: global fetch). */
  fetchImpl?: SubscriptionCoreFetch;
  /** A caller-built custody fetch (replaces the core's for this read). */
  requestFetch?: SubscriptionCoreFetch;
  resolver?: SubscriptionCoreConnectionResolverDeps;
};

class ProbeUnavailable extends Error {}
class ProbeRelogin extends Error {}

/** The connection-level operations runtime bound to one provider (memoized per binding). */
export const subscriptionCoreOperationConnections = memoByProvider(
  (provider: SubscriptionCoreProvider) => {
    const providerId = subscriptionCoreProviderId(provider);
    const operations = () => subscriptionCoreOperations(provider);

    /**
     * Shared organization- or workspace-scoped connections that can serve an
     * operation in this workspace, in placement order: the session's explicit
     * choice (session scope only), then the effective primary, then pool
     * order. Only active, allocatable connections in the effective inference
     * pool qualify. Empty when the cutover is not enabled.
     */
    async function listSubscriptionCoreOperationCandidates(
      db: Database,
      scope: Exclude<SubscriptionCoreOperationScope, { kind: "turn" }>,
    ): Promise<SubscriptionCoreOperationCandidate[]> {
      const access = await operations().withOperationScope(db, scope, async (tx) => {
        if (
          (await readSubscriptionProviderCutoverState(tx, {
            accountId: scope.accountId,
            provider: providerId,
          })) !== "enabled"
        )
          return [];
        const pool = await readSubscriptionCoreWorkspacePool(tx, provider, scope);
        const effective = pool.source.effectiveSource;
        if (effective === "disabled") return [];
        const eligible = pool.connections.filter(
          (entry) =>
            entry.row.status === "active" &&
            entry.row.allocator_enabled &&
            entry.poolAllocatorEnabled &&
            entry.source === effective,
        );
        // A workspace-scoped connection listed only because personal
        // workspaces may use it is not assigned here: operations refuse it.
        const assigned = await assignedConnectionIds(
          tx,
          scope,
          eligible.map((entry) => entry.row.id),
        );
        let explicitId: string | null = null;
        if (scope.kind === "session") {
          const binding = await readSubscriptionSessionBinding(tx, scope).catch(() => null);
          if (binding?.provider === providerId && binding.choice === "explicit") {
            explicitId = binding.connectionId;
          }
        }
        const rank = (id: string) =>
          id === explicitId ? 0 : id === pool.primaryConnectionId ? 1 : 2;
        return eligible
          .filter((entry) => assigned.has(entry.row.id))
          .map((entry, index) => ({ entry, index }))
          .sort((a, b) => rank(a.entry.row.id) - rank(b.entry.row.id) || a.index - b.index)
          .map(({ entry }) => ({
            connectionId: entry.row.id,
            planType: entry.row.plan_type,
            explicit: entry.row.id === explicitId,
            allowedModelIds: entry.row.allowed_model_ids ?? null,
          }));
      });
      return access?.value ?? [];
    }

    /**
     * The workspace's shared pool of this provider as a status probe sees it
     * (no credential material): its connections in the effective pool and
     * the effective primary, if it is one of them. Empty without an enabled
     * cutover. Personal connections are never listed.
     */
    async function readSubscriptionCoreWorkspaceConnections(
      db: Database,
      scope: Extract<SubscriptionCoreOperationScope, { kind: "workspace" }>,
    ): Promise<{
      connections: Array<{
        connectionId: string;
        label: string | null;
        providerAccountId: string | null;
        source: "workspace" | "organization";
        status: string;
      }>;
      primaryConnectionId: string | null;
    }> {
      const access = await operations().withOperationScope(db, scope, async (tx) => {
        if (
          (await readSubscriptionProviderCutoverState(tx, {
            accountId: scope.accountId,
            provider: providerId,
          })) !== "enabled"
        )
          return { connections: [], primaryConnectionId: null };
        const pool = await readSubscriptionCoreWorkspacePool(tx, provider, scope);
        const connections = pool.connections.map((entry) => ({
          connectionId: entry.row.id,
          label: entry.row.label,
          providerAccountId: entry.row.provider_account_id,
          source: entry.source,
          status: entry.row.status,
        }));
        return {
          connections,
          primaryConnectionId: connections.some(
            (connection) => connection.connectionId === pool.primaryConnectionId,
          )
            ? pool.primaryConnectionId
            : null,
        };
      });
      return access?.value ?? { connections: [], primaryConnectionId: null };
    }

    /**
     * Bearer resolver for one operation (or connection read): the same
     * staleness refresh as chat, with process-wide single-flight per
     * connection and generation (the shared core resolver, in its own flight
     * namespace). Only connection-level outcomes are shared; a refused
     * authorization belongs to the operation that hit it.
     */
    function buildSubscriptionCoreConnectionTokenResolver(
      db: Database,
      settings: Settings,
      scope: SubscriptionCoreOperationScope,
      connectionId: string,
      ref: SubscriptionCoreOperationLeaseRef | null,
      deps: SubscriptionCoreConnectionResolverDeps = {},
    ): {
      getToken: () => Promise<SubscriptionCoreConnectionToken>;
      refresh: () => Promise<SubscriptionCoreConnectionToken>;
    } {
      const load = deps.load ?? operations().loadSubscriptionCoreConnectionCredential;
      const refreshCredential =
        deps.refreshCredential ?? operations().refreshSubscriptionCoreConnectionCredential;
      const unavailable = deps.unavailable ?? (() => provider.errors.operationUnavailable());
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
      return buildSubscriptionCoreCredentialResolver<
        SubscriptionCoreConnectionCredential,
        Extract<SubscriptionCoreConnectionRefreshOutcome, { kind: "refreshed" }>,
        SubscriptionCoreConnectionToken
      >({
        flightNamespace: "connection",
        connectionId,
        holderKey: ref
          ? `${ref.operationId}:${ref.holderId}:${ref.generation}`
          : `connection:${connectionId}`,
        policy: (loaded) => subscriptionCoreRefreshPolicy(provider.adapter, loaded.credential),
        load: () => load(db, settings, scope, connectionId, ref),
        embeddedExpiry: (loaded) => provider.adapter.credential.expiry(loaded.credential),
        refresh: (loaded) =>
          refreshCredential(db, settings, scope, connectionId, ref, loaded.refreshGeneration, deps),
        snapshot: (loaded) => snapshot(loaded),
        refreshedSnapshot: (outcome, loaded) =>
          snapshot(loaded, outcome.credential, outcome.refreshGeneration),
        errors: {
          relogin: (message) =>
            deps.relogin?.(message) ??
            new SubscriptionCoreError(
              "subscription_core_relogin_required",
              provider.adapter.reloginText(message ?? ""),
            ),
          leaseLost: unavailable,
          accessLost: unavailable,
        },
      });
    }

    /**
     * Run one operation on the first candidate whose operation lease is
     * granted: take the lease, hand `run` a resolver, a custody fetch and a
     * pre-dispatch fence on that exact lease, and release the lease after
     * `run` settles (its result already parsed). `unavailable` when no
     * candidate's lease was granted; failures inside `run` are final for
     * the operation (never retried on another connection).
     */
    async function runSubscriptionCoreOperation<T>(
      db: Database,
      settings: Settings,
      scope: SubscriptionCoreOperationScope,
      input: {
        candidates: readonly string[];
        operationKind: SubscriptionOperationKind;
        holderId: string;
        /** Defaults to a fresh operation id; the lease row is keyed by it. */
        operationId?: string;
        attemptId?: string;
        generation?: number;
        /** A durable logical request identity for custody (default: random). */
        requestId?: string;
        fetchImpl?: SubscriptionCoreFetch;
      },
      run: (operation: {
        connectionId: string;
        ref: SubscriptionCoreOperationLeaseRef;
        resolver: ReturnType<typeof buildSubscriptionCoreConnectionTokenResolver>;
        fetch: SubscriptionCoreFetch;
        /** True while the exact operation lease is still live (renews it). */
        fence: () => Promise<boolean>;
      }) => Promise<T>,
    ): Promise<{ kind: "ran"; value: T } | { kind: "unavailable" }> {
      const operationId = input.operationId ?? crypto.randomUUID();
      const attemptId = input.attemptId ?? crypto.randomUUID();
      for (const connectionId of input.candidates) {
        const ref: SubscriptionCoreOperationLeaseRef = {
          operationId,
          attemptId,
          operationKind: input.operationKind,
          connectionId,
          holderId: input.holderId.slice(0, 256),
          generation: input.generation ?? 1,
        };
        const lease = await operations().acquireSubscriptionCoreOperationLease(db, scope, ref);
        if (lease.kind !== "acquired") continue;
        try {
          return {
            kind: "ran",
            value: await run({
              connectionId,
              ref,
              resolver: buildSubscriptionCoreConnectionTokenResolver(
                db,
                settings,
                scope,
                connectionId,
                ref,
              ),
              fetch: operations().buildSubscriptionCoreOperationFetch(
                db,
                scope,
                ref,
                connectionId,
                input.fetchImpl ?? fetch,
                input.requestId ? { requestId: input.requestId } : {},
              ),
              fence: async () =>
                (await operations().renewSubscriptionCoreOperationLease(db, scope, ref)) !== null,
            }),
          };
        } finally {
          await operations()
            .releaseSubscriptionCoreOperationLease(db, scope, ref)
            .catch(() => false);
        }
      }
      return { kind: "unavailable" };
    }

    /**
     * A connection read for the provider's adapter (usage, live catalog) in a
     * workspace context: a refreshing bearer through the core seam and a
     * custody fetch. The first bearer is resolved before the adapter runs, so
     * an unreadable connection never reaches the provider.
     */
    async function connectionRead(
      db: Database,
      settings: Settings,
      scope: Extract<SubscriptionCoreOperationScope, { kind: "workspace" }>,
      connectionId: string,
      deps: SubscriptionCoreConnectionProbeDeps,
    ): Promise<
      | {
          kind: "ready";
          read: SubscriptionCoreConnectionRead<unknown>;
          current: () => SubscriptionCoreConnectionToken;
        }
      | { kind: "not_visible" }
      | { kind: "relogin" }
      | { kind: "token_error"; error: unknown }
    > {
      const resolver = buildSubscriptionCoreConnectionTokenResolver(
        db,
        settings,
        scope,
        connectionId,
        null,
        {
          ...deps.resolver,
          relogin: () => new ProbeRelogin(),
          unavailable: () => new ProbeUnavailable(),
        },
      );
      let token: SubscriptionCoreConnectionToken;
      try {
        token = await resolver.getToken();
      } catch (error) {
        if (error instanceof ProbeUnavailable) return { kind: "not_visible" };
        if (error instanceof ProbeRelogin) return { kind: "relogin" };
        return { kind: "token_error", error };
      }
      const requestFetch =
        deps.requestFetch ??
        operations().buildSubscriptionCoreOperationFetch(
          db,
          scope,
          null,
          connectionId,
          deps.fetchImpl ?? fetch,
        );
      return {
        kind: "ready",
        current: () => token,
        read: {
          // The bearer resolved above serves the first request.
          getToken: async () => token,
          refresh: async () => {
            token = await resolver.refresh();
            return token;
          },
          fetch: requestFetch,
        },
      };
    }

    /**
     * Live usage for one shared connection in the caller's workspace scope
     * (design 5.3, the core quota probe): read the provider's usage endpoint
     * through the adapter, decode it, and record it as a generation-fenced
     * quota observation. Provider and refresh failures are reported, never
     * thrown; a relogin is recorded on the connection by the refresh seam.
     */
    async function probeSubscriptionCoreConnectionUsage(
      db: Database,
      settings: Settings,
      scope: Extract<SubscriptionCoreOperationScope, { kind: "workspace" }>,
      connectionId: string,
      deps: SubscriptionCoreConnectionProbeDeps = {},
    ): Promise<SubscriptionCoreUsageProbe> {
      const { fetchUsage, decodeQuota } = provider.adapter;
      if (!fetchUsage || !decodeQuota) return { kind: "unsupported" };
      const prepared = await connectionRead(db, settings, scope, connectionId, deps);
      if (prepared.kind !== "ready") return prepared;
      let response: unknown;
      try {
        response = await fetchUsage.call(provider.adapter, prepared.read);
      } catch (error) {
        return { kind: "fetch_error", error };
      }
      const quota = decodeQuota.call(provider.adapter, {
        response,
        observedAt: Date.now(),
        refreshGeneration: prepared.current().credentialVersion,
      });
      if (!quota) return { kind: "read", response, quota: null, recovered: false };
      const applied = await operations()
        .recordSubscriptionCoreUsageObservation(db, scope, connectionId, quota)
        .catch(() => ({ applied: false, recovered: false }));
      return { kind: "read", response, quota, recovered: applied.recovered };
    }

    /** The live model catalog of one shared connection through the adapter. */
    async function probeSubscriptionCoreConnectionLiveModels(
      db: Database,
      settings: Settings,
      scope: Extract<SubscriptionCoreOperationScope, { kind: "workspace" }>,
      connectionId: string,
      deps: SubscriptionCoreConnectionProbeDeps = {},
    ): Promise<SubscriptionCoreLiveModelsProbe> {
      const { liveModels } = provider.adapter;
      if (!liveModels) return { kind: "unsupported" };
      const prepared = await connectionRead(db, settings, scope, connectionId, deps);
      if (prepared.kind === "token_error") return { kind: "error", error: prepared.error };
      if (prepared.kind !== "ready") return prepared;
      try {
        return { kind: "read", modelIds: await liveModels.call(provider.adapter, prepared.read) };
      } catch (error) {
        return { kind: "error", error };
      }
    }

    return {
      listSubscriptionCoreOperationCandidates,
      readSubscriptionCoreWorkspaceConnections,
      buildSubscriptionCoreConnectionTokenResolver,
      runSubscriptionCoreOperation,
      probeSubscriptionCoreConnectionUsage,
      probeSubscriptionCoreConnectionLiveModels,
    };
  },
);

/** Assigned (not merely personal-workspace-visible) connections among `ids`. */
async function assignedConnectionIds(
  tx: Database,
  scope: { accountId: string; workspaceId: string },
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await rawRows<{ id: string }>(
    tx,
    sql`select connection.id::text as id from subscription_connections connection
      where connection.account_id = ${scope.accountId}::uuid
        and connection.id = any(${`{${ids.join(",")}}`}::uuid[])
        and connection.ownership = 'shared' and connection.status = 'active'
        and (connection.scope_kind = 'organization'
          or (connection.scope_kind = 'workspaces' and exists (
            select 1 from subscription_connection_workspaces assignment
            where assignment.account_id = connection.account_id
              and assignment.connection_id = connection.id
              and assignment.workspace_id = ${scope.workspaceId}::uuid)))`,
  );
  return new Set(rows.map((row) => row.id));
}
