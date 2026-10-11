/**
 * Account administration on the shared subscription core, for any provider:
 * the workspace and organization pool projections, the provider's settings
 * (primary connection, rotation, workspace source) and the per-connection
 * writers (allocator, extra credits, rename).
 *
 * Every read and write runs under the caller's own row-level-security
 * context (organization, workspace and, for writes, the authenticated
 * subject), so the core tables' policies decide visibility and management
 * authority: an organization administrator, or a workspace administrator for
 * a connection or setting that workspace manages. Nothing here returns
 * credential material. Personal connections are read only through the
 * owner-only reader (`subscription_core_personal_connections`).
 *
 * The provider is data (the binding): its id selects rows and settings
 * keys, its registry column holds the primary connection, and its adapter's
 * display name fills operator-facing texts. Provider route shapes are
 * projected from the neutral rows here by the provider's own module.
 */
import { sql } from "drizzle-orm";
import { auditEvents } from "../schema";
import { withLosslessContentWriteVersion } from "../lossless-json";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "../database";
import {
  readSubscriptionEffectiveSettings,
  readSubscriptionProviderCutoverState,
  resolveSubscriptionConnectionId,
} from "../subscription-core-repository";
import {
  organizationAdministeredConnection,
  organizationAllocator,
  organizationAllocatorCopies,
  organizationModels,
} from "./access";
import { SubscriptionCoreError } from "./errors";
import { subscriptionCoreProviderId, type SubscriptionCoreProvider } from "./provider";

/**
 * `core`: the provider's cutover is enabled. `maintenance`: a missing or
 * disabled row; callers fail closed.
 */
export type SubscriptionCoreCutoverDisposition = "core" | "maintenance";

export async function readSubscriptionCoreCutoverDisposition(
  db: Database,
  provider: SubscriptionCoreProvider,
  accountId: string,
  /**
   * The caller's workspace, when it has one. The cutover row needs only the
   * account scope, but a caller inside a shared request transaction (whose
   * sibling queries run concurrently) must not have its workspace setting
   * changed underneath them, so the nested scope keeps the same workspace.
   */
  workspaceId: string | null = null,
): Promise<SubscriptionCoreCutoverDisposition> {
  const state = await withRlsContext(
    db,
    { accountId, workspaceId },
    async (tx) =>
      await readSubscriptionProviderCutoverState(tx, {
        accountId,
        provider: subscriptionCoreProviderId(provider),
      }),
  );
  return state === "enabled" ? "core" : "maintenance";
}

/** A wake the caller delivers after its mutation committed. */
export type SubscriptionCoreWake = {
  accountId: string;
  reason: string;
  workspaceIds?: readonly string[];
  /** Only these sessions' waiters (requires exactly one workspace). */
  sessionIds?: readonly string[];
};

/** The wake reason for an administration event of this provider. */
export function subscriptionCoreWakeReason(
  provider: SubscriptionCoreProvider,
  event: string,
): string {
  return `core_${subscriptionCoreProviderId(provider)}_${event}`;
}

/** One subscription connection as the administration projections read it. */
export type SubscriptionCoreConnectionRow = {
  id: string;
  label: string | null;
  account_email: string | null;
  plan_type: string | null;
  provider_account_id: string | null;
  status: string;
  last_error: string | null;
  extra_credits_enabled: boolean;
  extra_credits_version: number | string;
  extra_credits_updated_at: Date | string | null;
  allocator_enabled: boolean;
  allocator_version: number | string;
  allowed_model_ids: string[] | null;
  connected_by_subject_id: string | null;
  expires_at: Date | string | null;
  last_refresh_at: Date | string | null;
  managed_by_workspace_id: string | null;
  provider_state: Record<string, unknown> | null;
  updated_at: Date | string;
  quota: unknown;
  quota_revision: number | string | null;
  quota_observed_refresh_generation: number | string | null;
  quota_updated_at: Date | string | null;
};

const CONNECTION_COLUMNS = sql`connection.id::text as id, connection.label,
  connection.account_email, connection.plan_type, connection.provider_account_id,
  connection.status, connection.last_error, connection.allocator_enabled,
  connection.extra_credits_enabled, connection.extra_credits_version, connection.extra_credits_updated_at,
  connection.allocator_version, connection.allowed_model_ids,
  connection.connected_by_subject_id, connection.expires_at, connection.last_refresh_at,
  connection.managed_by_workspace_id::text as managed_by_workspace_id,
  connection.provider_state, connection.updated_at,
  quota.quota, quota.revision as quota_revision,
  quota.observed_refresh_generation as quota_observed_refresh_generation,
  quota.updated_at as quota_updated_at`;

function date(value: Date | string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

/** The provider's effective settings at one workspace. */
export type SubscriptionCoreProviderSettings = {
  enabled: boolean;
  inferenceSource: "automatic" | "workspace" | "organization";
  rotationMode: "spread" | "primary_first";
  rotationSource: "organization" | "workspace";
};

export function subscriptionCoreProviderSettings(
  provider: SubscriptionCoreProvider,
  effective: Awaited<ReturnType<typeof readSubscriptionEffectiveSettings>>,
): SubscriptionCoreProviderSettings {
  const id = subscriptionCoreProviderId(provider);
  const values = effective.values as unknown as {
    rotation?: Record<string, { mode?: unknown } | undefined>;
    providers?: Record<string, { enabled?: unknown; inferenceSource?: unknown } | undefined>;
  };
  const own = values.providers?.[id];
  const source = own?.inferenceSource;
  const rotationSources = effective.sources.rotation as Record<string, string | undefined>;
  return {
    enabled: own?.enabled !== false,
    inferenceSource: source === "workspace" || source === "organization" ? source : "automatic",
    rotationMode: values.rotation?.[id]?.mode === "primary_first" ? "primary_first" : "spread",
    rotationSource: rotationSources[id] === "workspace" ? "workspace" : "organization",
  };
}

/** The provider's primary column, or null for a provider without a primary setting. */
function primaryColumn(provider: SubscriptionCoreProvider) {
  const column = provider.settings.primaryColumn;
  return column === null ? null : sql.identifier(column);
}

/** Refusal of a primary write for a provider without a primary setting. */
function primaryUnsupported(provider: SubscriptionCoreProvider) {
  return new SubscriptionCoreError(
    "subscription_core_primary_unsupported",
    `${provider.adapter.displayName} has no primary connection setting`,
  );
}

/** The primary column as a select expression (NULL for a provider without one). */
function primarySelect(provider: SubscriptionCoreProvider) {
  return primaryColumn(provider) ?? sql`null`;
}

export async function readSubscriptionCorePrimaryConnectionId(
  tx: Database,
  provider: SubscriptionCoreProvider,
  accountId: string,
  workspaceId: string | null,
): Promise<string | null> {
  const [row] = await rawRows<{ primary_id: string | null }>(
    tx,
    sql`select ${primarySelect(provider)}::text as primary_id from subscription_settings
      where account_id = ${accountId}::uuid
        and workspace_id is not distinct from ${workspaceId}::uuid`,
  );
  return row?.primary_id ?? null;
}

export type SubscriptionCoreWorkspaceSourceMode =
  | "automatic"
  | "workspace"
  | "organization"
  | "disabled";
export type SubscriptionCoreEffectiveSource = "workspace" | "organization" | "disabled";

export type SubscriptionCoreWorkspaceSource = {
  accountId: string;
  workspaceId: string;
  workspaceKind: "personal" | "shared";
  mode: SubscriptionCoreWorkspaceSourceMode;
  effectiveSource: SubscriptionCoreEffectiveSource;
  workspaceAvailable: boolean;
  organizationAvailable: boolean;
};

/** One shared connection of a workspace's effective pool. */
export type SubscriptionCorePoolConnection = {
  row: SubscriptionCoreConnectionRow;
  /** The pool the connection belongs to for this workspace. */
  source: "workspace" | "organization";
  /** Whether the connection's assignment in the effective pool admits new allocations. */
  poolAllocatorEnabled: boolean;
};

export type SubscriptionCoreWorkspacePool = {
  connections: SubscriptionCorePoolConnection[];
  primaryConnectionId: string | null;
  rotationMode: "spread" | "primary_first";
  source: SubscriptionCoreWorkspaceSource;
};

/**
 * The workspace's shared pool of this provider: the connections of the
 * effective source, the primary connection and the source. Requires the
 * workspace RLS context on `tx`. Only shared subscription connections in the
 * workspace's scope are listed; an administrator's wider visibility is
 * filtered explicitly.
 */
export async function readSubscriptionCoreWorkspacePool(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: { accountId: string; workspaceId: string },
): Promise<SubscriptionCoreWorkspacePool> {
  const providerId = subscriptionCoreProviderId(provider);
  const [workspace] = await rawRows<{ workspace_kind: "personal" | "shared" }>(
    tx,
    sql`select get_workspace_kind(${input.accountId}::uuid, ${input.workspaceId}::uuid)
      as workspace_kind`,
  );
  const workspaceKind = workspace?.workspace_kind === "personal" ? "personal" : "shared";
  const settings = subscriptionCoreProviderSettings(
    provider,
    await readSubscriptionEffectiveSettings(tx, input.accountId, input.workspaceId),
  );
  const rows = await rawRows<SubscriptionCoreConnectionRow & { pools: string[] | null }>(
    tx,
    sql`select ${CONNECTION_COLUMNS},
      (select array_agg(policy.inference_pool || ':' || policy.allocator_enabled::text
          order by policy.inference_pool)
        from subscription_connection_assignment_policies policy
        where policy.account_id = connection.account_id
          and policy.connection_id = connection.id
          and policy.workspace_id = ${input.workspaceId}::uuid) as pools
    from subscription_connections connection
    left join subscription_connection_quota quota
      on quota.account_id = connection.account_id and quota.connection_id = connection.id
    where connection.account_id = ${input.accountId}::uuid
      and connection.provider = ${providerId} and connection.kind = 'subscription'
      and connection.disconnected_at is null
      and connection.ownership = 'shared'
      and (connection.scope_kind = 'organization'
        or (connection.scope_kind = 'workspaces' and (
          exists (select 1 from subscription_connection_workspaces assignment
            where assignment.account_id = connection.account_id
              and assignment.connection_id = connection.id
              and assignment.workspace_id = ${input.workspaceId}::uuid)
          or (connection.allow_personal_workspaces and ${workspaceKind} = 'personal'))))
    order by connection.created_at, connection.id`,
  );
  const pools = rows.map((row) => {
    const entries = (row.pools ?? []).map((entry) => {
      const [pool, allocator] = entry.split(":");
      return { pool: pool as "workspace" | "organization", allocator: allocator === "true" };
    });
    // M2 worlds without the assignment relation classify by management.
    const local =
      entries.length > 0
        ? entries.some((entry) => entry.pool === "workspace")
        : row.managed_by_workspace_id === input.workspaceId;
    return { row, entries, local };
  });
  const workspaceAvailable = pools.some((entry) => entry.local);
  const organizationAvailable = pools.some((entry) =>
    entry.entries.length > 0
      ? entry.entries.some((policy) => policy.pool === "organization")
      : !entry.local,
  );
  const mode: SubscriptionCoreWorkspaceSourceMode = await (async () => {
    const [row] = await rawRows<{
      own: { enabled?: unknown; inferenceSource?: unknown } | null;
    }>(
      tx,
      sql`select providers->(${providerId}::text) as own from subscription_settings
        where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
    );
    if (row?.own?.enabled === false) return "disabled";
    if (row?.own?.inferenceSource === "workspace") return "workspace";
    if (row?.own?.inferenceSource === "organization") return "organization";
    return "automatic";
  })();
  const effectiveSource: SubscriptionCoreEffectiveSource = !settings.enabled
    ? "disabled"
    : settings.inferenceSource !== "automatic"
      ? settings.inferenceSource
      : workspaceAvailable
        ? "workspace"
        : "organization";
  let primaryConnectionId = await readSubscriptionCorePrimaryConnectionId(
    tx,
    provider,
    input.accountId,
    settings.rotationSource === "workspace" ? input.workspaceId : null,
  );
  // Shared rows were already filtered for lifecycle and workspace scope above.
  // Personal primaries are checked only after the owner-only reader joins.
  if (workspaceKind === "shared" && !rows.some((row) => row.id === primaryConnectionId)) {
    primaryConnectionId = null;
  }
  // Only the effective pool is listed (legacy parity): nothing while the
  // provider is disabled here, only workspace-classified connections for the
  // workspace source and only organization-classified ones for the
  // organization source. Automatic admits both shared pools on the core, so
  // both are listed. Callers with mere workspace read access must not see
  // accounts that cannot serve this workspace.
  const inEffectiveSource = (entry: (typeof pools)[number]) =>
    effectiveSource === "disabled"
      ? false
      : settings.inferenceSource === "automatic"
        ? true
        : effectiveSource === "workspace"
          ? entry.local
          : entry.entries.length > 0
            ? entry.entries.some((policy) => policy.pool === "organization")
            : !entry.local;
  const connections = pools.filter(inEffectiveSource).map(({ row, entries, local }) => {
    // The switch placement reads: under the automatic source any enabled
    // copy in this workspace serves (both pools are admitted), otherwise the
    // effective pool's copy.
    const shown =
      settings.inferenceSource === "automatic"
        ? entries
        : entries.filter((entry) => entry.pool === effectiveSource);
    return {
      row,
      source: local ? ("workspace" as const) : ("organization" as const),
      poolAllocatorEnabled:
        entries.length === 0 ||
        (shown.length > 0 ? shown : entries).some((entry) => entry.allocator),
    };
  });
  return {
    connections,
    primaryConnectionId,
    rotationMode: settings.rotationMode,
    source: {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      workspaceKind,
      mode,
      effectiveSource,
      workspaceAvailable,
      organizationAvailable,
    },
  };
}

/**
 * The viewing person's own personal connections of this provider (no
 * credential material), through the owner-only reader. Requires the
 * workspace RLS context on `tx`; sets the subject. Empty for anyone else, for
 * a workspace the person may not use, or without an enabled cutover.
 */
export async function listSubscriptionCorePersonalConnectionRowsInTransaction(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<SubscriptionCoreConnectionRow[]> {
  if (!input.subjectId.startsWith("user:")) return [];
  await setSubjectRlsContext(tx, input.subjectId);
  return await rawRows<SubscriptionCoreConnectionRow>(
    tx,
    sql`select personal.id::text as id, personal.label, personal.account_email,
        personal.plan_type, personal.provider_account_id, personal.status, personal.last_error,
        personal.allocator_enabled, personal.allocator_version, personal.allowed_model_ids,
        personal.connected_by_subject_id, personal.expires_at, personal.last_refresh_at,
        null::text as managed_by_workspace_id, personal.provider_state, personal.updated_at,
        personal.quota, personal.quota_revision, personal.quota_observed_refresh_generation,
        personal.quota_updated_at, personal.extra_credits_enabled,
        personal.extra_credits_version, personal.extra_credits_updated_at
      from opengeni_private.subscription_core_personal_connections(${subscriptionCoreProviderId(provider)},
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId}
      ) personal`,
  );
}

/**
 * The organization's own connections of this provider (shared connections
 * no workspace manages) and its rotation, for an organization administrator.
 * `null` for anyone else: the connection policy hides every row.
 */
export async function readSubscriptionCoreOrganizationPool(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: {
    organizationId: string;
    subjectId: string;
    /**
     * Read only this connection, any organization account (also one a shared
     * workspace manages), for a route that just changed it.
     */
    connectionId?: string;
  },
): Promise<{
  rows: SubscriptionCoreConnectionRow[];
  primaryConnectionId: string | null;
  rotationMode: "spread" | "primary_first";
} | null> {
  const providerId = subscriptionCoreProviderId(provider);
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      const [admin] = await rawRows<{ admin: boolean }>(
        tx,
        sql`select opengeni_private.subscription_organization_admin(${input.organizationId}::uuid) as admin`,
      );
      if (admin?.admin !== true) return null;
      const [org] = await rawRows<{ mode: string | null; primary_id: string | null }>(
        tx,
        sql`select rotation->(${providerId}::text)->>'mode' as mode,
          ${primarySelect(provider)}::text as primary_id
        from subscription_settings
        where account_id = ${input.organizationId}::uuid and workspace_id is null`,
      );
      let primaryConnectionId = org?.primary_id ?? null;
      const rows = await rawRows<SubscriptionCoreConnectionRow>(
        tx,
        sql`select ${CONNECTION_COLUMNS}
      from subscription_connections connection
      left join subscription_connection_quota quota
        on quota.account_id = connection.account_id and quota.connection_id = connection.id
      where connection.account_id = ${input.organizationId}::uuid
        and connection.provider = ${providerId} and connection.kind = 'subscription'
        and connection.disconnected_at is null
        and connection.ownership = 'shared' and ${
          input.connectionId === undefined
            ? sql`connection.managed_by_workspace_id is null`
            : sql`connection.id = ${input.connectionId}::uuid
              and ${organizationAdministeredConnection("connection")}`
        }
      order by connection.created_at, connection.id`,
      );
      if (!rows.some((row) => row.id === primaryConnectionId)) primaryConnectionId = null;
      // A workspace-managed account's delegated manager writes the
      // connection's own switch and list; the organization's are its own
      // copies' (what the organization route shows and flips).
      for (const row of rows) {
        if (row.managed_by_workspace_id === null) continue;
        row.allocator_enabled =
          row.allocator_enabled &&
          (await organizationAllocator(tx, provider, input.organizationId, row.id, true));
        row.allowed_model_ids = await organizationModels(tx, provider, input.organizationId, row);
      }
      return {
        rows,
        primaryConnectionId,
        rotationMode: (org?.mode ?? "spread") === "primary_first" ? "primary_first" : "spread",
      };
    },
  );
}

export function isSubscriptionCoreRlsRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "42501" || causeCode === "42501";
}

export type SubscriptionCoreAdministration = {
  accountId: string;
  /** null: the organization route. */
  workspaceId: string | null;
  subjectId: string;
};

export type SubscriptionCoreAllocatorResult =
  | {
      kind: "updated" | "unchanged" | "conflict";
      allocatorEnabled: boolean;
      allocatorVersion: number;
      allocatorUpdatedAt: Date | null;
    }
  | { kind: "not_found" };

export type SubscriptionCoreExtraCreditsResult =
  | {
      kind: "updated" | "unchanged" | "conflict";
      extraCreditsEnabled: boolean;
      extraCreditsVersion: number;
      extraCreditsUpdatedAt: Date | null;
    }
  | { kind: "not_found" };

async function managePersonalConnection(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration & { connectionId: string },
  action: "rename" | "allocator" | "primary",
  label: string | null = null,
  enabled: boolean | null = null,
  expectedVersion: number | null = null,
): Promise<
  ({ id: string } & Exclude<SubscriptionCoreAllocatorResult, { kind: "not_found" }>) | null
> {
  if (!input.workspaceId) return null;
  const [row] = await rawRows<{
    result:
      | ({ id: string } & Exclude<SubscriptionCoreAllocatorResult, { kind: "not_found" }>)
      | null;
  }>(
    tx,
    sql`select opengeni_private.manage_subscription_core_personal(${subscriptionCoreProviderId(provider)},
      ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId}, ${input.connectionId}::uuid,
      ${action}, ${label}, ${enabled}::boolean, ${expectedVersion}::integer) as result`,
  );
  return row?.result ?? null;
}

async function withAdministration<T>(
  db: Database,
  input: SubscriptionCoreAdministration,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      return await fn(tx);
    },
  );
}

/**
 * Resolve a legacy or canonical id to a shared subscription connection of
 * this provider the route may manage, checked before anything is written. A
 * workspace route may name only a connection in the workspace's projected
 * pool (`readSubscriptionCoreWorkspacePool`), as legacy did; an organization
 * route any organization account (shared, managed by no workspace or by a
 * shared workspace, design 5.4). `organizationPoolOnly` keeps the organization
 * route to accounts no workspace manages, for settings that belong to the
 * organization pool itself (its primary).
 * Management authority itself is still the core tables' write policies.
 */
async function visibleSharedConnection(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration,
  rawId: string,
  options: { organizationPoolOnly?: boolean } = {},
): Promise<{
  id: string;
  allocatorEnabled: boolean;
  allocatorVersion: number;
  managedByWorkspaceId: string | null;
  /** On a workspace route, the switch its page shows for this workspace's copies. */
  poolAllocatorEnabled: boolean;
} | null> {
  const providerId = subscriptionCoreProviderId(provider);
  const connectionId = await resolveSubscriptionConnectionId(tx, {
    accountId: input.accountId,
    provider: subscriptionCoreProviderId(provider),
    connectionId: rawId,
  });
  if (!connectionId) return null;
  // Management must not accept a stale primary/allocator target after removal.
  // Use the same lifecycle order as disconnect before reading its current row.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`subscription-refresh:${connectionId}`}, 0))`);
  const [row] = await rawRows<{
    allocator_enabled: boolean;
    allocator_version: number | string;
    managed_by_workspace_id: string | null;
  }>(
    tx,
    sql`select allocator_enabled, allocator_version, managed_by_workspace_id::text
      from subscription_connections
      where account_id = ${input.accountId}::uuid and provider = ${providerId} and kind = 'subscription'
        and ownership = 'shared' and id = ${connectionId}::uuid
        and disconnected_at is null
        and ${
          input.workspaceId !== null
            ? sql`true`
            : options.organizationPoolOnly
              ? sql`managed_by_workspace_id is null`
              : organizationAdministeredConnection()
        }`,
  );
  if (!row) return null;
  let poolAllocatorEnabled = true;
  if (input.workspaceId !== null) {
    const pool = await readSubscriptionCoreWorkspacePool(tx, provider, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
    });
    const entry = pool.connections.find((candidate) => candidate.row.id === connectionId);
    if (!entry) return null;
    poolAllocatorEnabled = entry.poolAllocatorEnabled;
  }
  return {
    id: connectionId,
    allocatorEnabled: row.allocator_enabled,
    allocatorVersion: Number(row.allocator_version),
    managedByWorkspaceId: row.managed_by_workspace_id,
    poolAllocatorEnabled,
  };
}

/** The managing workspace's own copy's switch: none, or its one row's. */
async function workspaceOwnAllocator(
  tx: Database,
  accountId: string,
  workspaceId: string,
  connectionId: string,
): Promise<boolean[]> {
  const rows = await rawRows<{ allocator_enabled: boolean }>(
    tx,
    sql`select allocator_enabled from subscription_connection_assignment_policies
      where account_id = ${accountId}::uuid and connection_id = ${connectionId}::uuid
        and workspace_id = ${workspaceId}::uuid and inference_pool = 'workspace'
        and managed_by_workspace_id = ${workspaceId}::uuid`,
  );
  return rows.map((row) => row.allocator_enabled);
}

function wakeFor(
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration,
  event: string,
): SubscriptionCoreWake {
  const reason = subscriptionCoreWakeReason(provider, event);
  return input.workspaceId
    ? { accountId: input.accountId, reason, workspaceIds: [input.workspaceId] }
    : { accountId: input.accountId, reason };
}

/**
 * New-allocation eligibility of one connection, with the legacy optimistic
 * concurrency: the same state is idempotent even with a stale version; a
 * conflicting stale version returns the current one. Organization
 * administrators and the connection's delegated manager may toggle it.
 */
export async function setSubscriptionCoreAllocator(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration & {
    connectionId: string;
    enabled: boolean;
    expectedVersion: number;
  },
): Promise<{ result: SubscriptionCoreAllocatorResult; wake: SubscriptionCoreWake | null }> {
  return await withAdministration(db, input, async (tx) => {
    const personal = await managePersonalConnection(
      tx,
      provider,
      input,
      "allocator",
      null,
      input.enabled,
      input.expectedVersion,
    );
    if (personal)
      return {
        result: { ...personal, allocatorUpdatedAt: date(personal.allocatorUpdatedAt) },
        wake: personal.kind === "updated" ? wakeFor(provider, input, "allocator_changed") : null,
      };
    const current = await visibleSharedConnection(tx, provider, input, input.connectionId);
    if (!current) return { result: { kind: "not_found" }, wake: null };
    const projection = (
      kind: "updated" | "unchanged" | "conflict",
      enabled: boolean,
      version: number,
      updatedAt: Date | string | null,
    ) => ({
      kind,
      allocatorEnabled: enabled,
      allocatorVersion: version,
      allocatorUpdatedAt: date(updatedAt),
    });
    const [stamp] = await rawRows<{ updated_at: Date | string }>(
      tx,
      sql`select updated_at from subscription_connections
        where account_id = ${input.accountId}::uuid and id = ${current.id}::uuid`,
    );
    // Each route shows and flips its own switch: the connection's switch with
    // the organization's own copies (organization route: its organization-pool
    // rows and the reach for workspaces created later) or with the managing
    // workspace's own copy (workspace route). The connection's switch gates
    // every copy, so either side can turn the account off everywhere, but
    // turning it on reaches only that side's copies: a delegated manager never
    // re-enables what the organization switched off for other workspaces.
    // "Unchanged" means every part this route writes already has the value,
    // so a switch the other side already turned off still records this side's
    // "off". An account no workspace manages is the organization's alone: its
    // route shows the connection's switch, as the shipped page does, and
    // writes every part.
    const copies =
      input.workspaceId === null
        ? await organizationAllocatorCopies(tx, provider, input.accountId, current.id)
        : await workspaceOwnAllocator(tx, input.accountId, input.workspaceId, current.id);
    // What the route's page shows: the workspace page's switch for this
    // workspace (placement's rule for its source), or on the organization
    // route the organization's copies (the connection's alone for an account
    // no workspace manages).
    const shown =
      current.allocatorEnabled &&
      (input.workspaceId !== null
        ? current.poolAllocatorEnabled
        : current.managedByWorkspaceId === null || copies.length === 0 || copies.every(Boolean));
    if (
      current.allocatorEnabled === input.enabled &&
      copies.every((copy) => copy === input.enabled)
    ) {
      return {
        result: projection("unchanged", shown, current.allocatorVersion, stamp?.updated_at ?? null),
        wake: null,
      };
    }
    if (current.allocatorVersion !== input.expectedVersion) {
      return {
        result: projection("conflict", shown, current.allocatorVersion, stamp?.updated_at ?? null),
        wake: null,
      };
    }
    let updated: { allocator_version: number | string; updated_at: Date | string } | undefined;
    try {
      updated = await tx.transaction(async (savepoint) => {
        const [row] = await rawRows<{
          allocator_version: number | string;
          updated_at: Date | string;
        }>(
          savepoint as unknown as Database,
          sql`update subscription_connections
            set allocator_enabled = ${input.enabled},
                allocator_version = allocator_version + 1,
                updated_at = clock_timestamp()
            where account_id = ${input.accountId}::uuid and id = ${current.id}::uuid
              and allocator_version = ${input.expectedVersion}
            returning allocator_version, updated_at`,
        );
        if (row) {
          // The pool rows and the reach for workspaces created later carry
          // their own allocator copy, which placement also requires.
          if (input.workspaceId === null) {
            await savepoint.execute(sql`update subscription_connection_assignment_policies
              set allocator_enabled = ${input.enabled}, updated_at = clock_timestamp()
              where account_id = ${input.accountId}::uuid and connection_id = ${current.id}::uuid
                and inference_pool = 'organization' and managed_by_workspace_id is null`);
            // The reach row's switch alone: its model list stays the
            // organization's.
            await savepoint.execute(sql`select opengeni_private.set_subscription_core_reach_allocator(
              ${subscriptionCoreProviderId(provider)}, ${input.accountId}::uuid,
              ${current.id}::uuid, ${input.enabled}::boolean)`);
          } else {
            await savepoint.execute(sql`update subscription_connection_assignment_policies
              set allocator_enabled = ${input.enabled}, updated_at = clock_timestamp()
              where account_id = ${input.accountId}::uuid and connection_id = ${current.id}::uuid
                and workspace_id = ${input.workspaceId}::uuid and inference_pool = 'workspace'
                and managed_by_workspace_id = ${input.workspaceId}::uuid`);
          }
        }
        return row;
      });
    } catch (error) {
      if (isSubscriptionCoreRlsRefusal(error)) return { result: { kind: "not_found" }, wake: null };
      throw error;
    }
    // The update policy hides a connection this subject may not manage.
    if (!updated) return { result: { kind: "not_found" }, wake: null };
    // A workspace's "on" turns on its own copy; under the organization's pool
    // the organization's copy, which only organization administrators switch,
    // decides what its page shows.
    const after =
      input.enabled && input.workspaceId !== null
        ? ((
            await readSubscriptionCoreWorkspacePool(tx, provider, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
            })
          ).connections.find((entry) => entry.row.id === current.id)?.poolAllocatorEnabled ?? false)
        : input.enabled;
    return {
      result: projection("updated", after, Number(updated.allocator_version), updated.updated_at),
      // Re-enabling can make a waiting turn placeable; disabling changes nothing
      // a waiter needs, but a single wake is cheap and keeps the rule simple.
      wake: {
        accountId: input.accountId,
        reason: subscriptionCoreWakeReason(provider, "allocator_changed"),
      },
    };
  });
}

async function auditExtraCredits(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration,
  connectionId: string,
  enabled: boolean,
  version: number,
): Promise<void> {
  await tx.insert(auditEvents).values(
    withLosslessContentWriteVersion(
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        action: `${subscriptionCoreProviderId(provider)}.extra_credits.updated`,
        targetType: "subscription_connection",
        targetId: connectionId,
        metadata: { extraCreditsEnabled: enabled, extraCreditsVersion: version },
      },
      "metadata",
      "metadataCodecVersion",
    ),
  );
}

/**
 * Consent to paid usage beyond the plan for one connection (providers with
 * the `extraCredits` capability), with the same optimistic concurrency as
 * the allocator switch. A provider without the capability finds nothing.
 */
export async function setSubscriptionCoreExtraCredits(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration & {
    connectionId: string;
    enabled: boolean;
    expectedVersion: number;
  },
): Promise<{ result: SubscriptionCoreExtraCreditsResult; wake: SubscriptionCoreWake | null }> {
  if (!provider.adapter.capabilities.extraCredits) {
    return { result: { kind: "not_found" }, wake: null };
  }
  return await withAdministration(db, input, async (tx) => {
    if (input.workspaceId) {
      const [personal] = await rawRows<{
        result:
          | ({ id: string } & Exclude<SubscriptionCoreExtraCreditsResult, { kind: "not_found" }>)
          | null;
      }>(
        tx,
        sql`select opengeni_private.manage_subscription_core_personal(${subscriptionCoreProviderId(provider)},
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId}, ${input.connectionId}::uuid,
        'extra_credits', null, ${input.enabled}, ${input.expectedVersion}::integer) as result`,
      );
      if (personal?.result) {
        const result = {
          ...personal.result,
          extraCreditsUpdatedAt: date(personal.result.extraCreditsUpdatedAt),
        };
        if (result.kind === "updated") {
          await auditExtraCredits(
            tx,
            provider,
            input,
            result.id,
            result.extraCreditsEnabled,
            result.extraCreditsVersion,
          );
        }
        return {
          result,
          wake:
            result.kind === "updated"
              ? {
                  accountId: input.accountId,
                  reason: subscriptionCoreWakeReason(provider, "extra_credits_changed"),
                }
              : null,
        };
      }
    }
    const visible = await visibleSharedConnection(tx, provider, input, input.connectionId);
    if (!visible) return { result: { kind: "not_found" }, wake: null };
    const [row] = await rawRows<{ enabled: boolean; version: number }>(
      tx,
      sql`select extra_credits_enabled as enabled, extra_credits_version as version
        from subscription_connections where account_id = ${input.accountId}::uuid
        and id = ${visible.id}::uuid for update`,
    );
    const current = row
      ? {
          id: visible.id,
          extraCreditsEnabled: row.enabled,
          extraCreditsVersion: Number(row.version),
        }
      : null;
    if (!current) return { result: { kind: "not_found" }, wake: null };
    const projection = (
      kind: "updated" | "unchanged" | "conflict",
      enabled: boolean,
      version: number,
      updatedAt: Date | string | null,
    ) => ({
      kind,
      extraCreditsEnabled: enabled,
      extraCreditsVersion: version,
      extraCreditsUpdatedAt: date(updatedAt),
    });
    const [stamp] = await rawRows<{ updated_at: Date | string }>(
      tx,
      sql`select extra_credits_updated_at as updated_at from subscription_connections
        where account_id = ${input.accountId}::uuid and id = ${current.id}::uuid`,
    );
    if (current.extraCreditsEnabled === input.enabled) {
      return {
        result: projection(
          "unchanged",
          current.extraCreditsEnabled,
          current.extraCreditsVersion,
          stamp?.updated_at ?? null,
        ),
        wake: null,
      };
    }
    if (current.extraCreditsVersion !== input.expectedVersion) {
      return {
        result: projection(
          "conflict",
          current.extraCreditsEnabled,
          current.extraCreditsVersion,
          stamp?.updated_at ?? null,
        ),
        wake: null,
      };
    }
    let updated: { extra_credits_version: number | string; updated_at: Date | string } | undefined;
    try {
      updated = await tx.transaction(async (savepoint) => {
        const [updatedRow] = await rawRows<{
          extra_credits_version: number | string;
          updated_at: Date | string;
        }>(
          savepoint as unknown as Database,
          sql`update subscription_connections
            set extra_credits_enabled = ${input.enabled},
                extra_credits_updated_by_subject_id = ${input.subjectId},
                extra_credits_updated_at = clock_timestamp(),
                extra_credits_version = extra_credits_version + 1,
                updated_at = clock_timestamp()
            where account_id = ${input.accountId}::uuid and id = ${current.id}::uuid
              and extra_credits_version = ${input.expectedVersion}
            returning extra_credits_version, extra_credits_updated_at as updated_at`,
        );
        return updatedRow;
      });
    } catch (error) {
      if (isSubscriptionCoreRlsRefusal(error)) return { result: { kind: "not_found" }, wake: null };
      throw error;
    }
    // The update policy hides a connection this subject may not manage.
    if (!updated) return { result: { kind: "not_found" }, wake: null };
    await auditExtraCredits(
      tx,
      provider,
      input,
      current.id,
      input.enabled,
      Number(updated.extra_credits_version),
    );
    return {
      result: projection(
        "updated",
        input.enabled,
        Number(updated.extra_credits_version),
        updated.updated_at,
      ),
      // Re-enabling can make a waiting turn placeable; disabling changes nothing
      // a waiter needs, but a single wake is cheap and keeps the rule simple.
      wake: {
        accountId: input.accountId,
        reason: subscriptionCoreWakeReason(provider, "extra_credits_changed"),
      },
    };
  });
}

/** Rename one connection (label only). Returns null when it is not manageable. */
export async function renameSubscriptionCoreConnection(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration & { connectionId: string; label: string | null },
): Promise<string | null> {
  return await withAdministration(db, input, async (tx) => {
    const personal = await managePersonalConnection(tx, provider, input, "rename", input.label);
    if (personal) return personal.id;
    const current = await visibleSharedConnection(tx, provider, input, input.connectionId);
    if (!current) return null;
    const label = input.label === null ? null : input.label.trim().slice(0, 200) || null;
    try {
      const renamed = await tx.transaction(async (savepoint) =>
        rawRows<{ id: string }>(
          savepoint as unknown as Database,
          sql`update subscription_connections set label = ${label}, version = version + 1,
              updated_at = clock_timestamp()
            where account_id = ${input.accountId}::uuid and id = ${current.id}::uuid
            returning id::text as id`,
        ),
      );
      return renamed[0]?.id ?? null;
    } catch (error) {
      if (isSubscriptionCoreRlsRefusal(error)) return null;
      throw error;
    }
  });
}

/**
 * Write one settings row (the organization row for a NULL workspace) through
 * the settings manager policy. Returns false when the subject may not write it.
 *
 * The existing row is updated in place. The organization row's CHECK requires
 * every organization default to be present, so an upsert's proposed insert
 * row (which sets only this provider's values) would be refused before ON
 * CONFLICT ran; a missing row is therefore inserted with the defaults the
 * settings resolver already applies to an absent value (empty rotation,
 * providers and fallback order, no cross-provider failover, personal
 * connections allowed, no personal fallback). A workspace override row may
 * leave them NULL.
 */
async function writeSettingsRow(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration,
  patch: {
    rotationMode?: "spread" | "primary_first";
    primaryConnectionId?: string | null;
    providerSettings?: Record<string, unknown> | null;
  },
): Promise<boolean> {
  const providerId = subscriptionCoreProviderId(provider);
  const primary_column = primaryColumn(provider);
  const rotationJson =
    patch.rotationMode === undefined
      ? null
      : JSON.stringify({ [providerId]: { mode: patch.rotationMode } });
  const providerJson =
    patch.providerSettings === undefined || patch.providerSettings === null
      ? null
      : JSON.stringify({ [providerId]: patch.providerSettings });
  const clearProvider = patch.providerSettings === null;
  const setPrimary = patch.primaryConnectionId !== undefined;
  if (setPrimary && primary_column === null) throw primaryUnsupported(provider);
  const primary = setPrimary ? (patch.primaryConnectionId ?? null) : null;
  const primaryAssignment =
    primary_column === null
      ? sql``
      : sql`${primary_column} = case when ${setPrimary}
            then ${primary}::uuid else ${primary_column} end,`;
  const primaryInsertColumn = primary_column === null ? sql`` : sql`${primary_column},`;
  const primaryInsertValue = primary_column === null ? sql`` : sql`${primary}::uuid,`;
  const organizationRow = input.workspaceId === null;
  const update = async (db: Database) =>
    await rawRows<{ id: string }>(
      db,
      sql`update subscription_settings set
          rotation = case when ${rotationJson}::jsonb is null then rotation
            else coalesce(rotation, '{}'::jsonb) || ${rotationJson}::jsonb end,
          providers = case
            when ${clearProvider} then providers - (${providerId}::text)
            when ${providerJson}::jsonb is null then providers
            else coalesce(providers, '{}'::jsonb) || ${providerJson}::jsonb end,
          ${primaryAssignment}
          version = version + 1,
          updated_by_subject_id = ${input.subjectId},
          updated_at = clock_timestamp()
        where account_id = ${input.accountId}::uuid
          and workspace_id is not distinct from ${input.workspaceId}::uuid
        returning id::text as id`,
    );
  try {
    return await tx.transaction(async (savepoint) => {
      const scoped = savepoint as unknown as Database;
      if ((await update(scoped)).length > 0) return true;
      const inserted = await rawRows<{ id: string }>(
        scoped,
        sql`insert into subscription_settings (
            account_id, workspace_id, rotation, providers, ${primaryInsertColumn}
            cross_provider_failover, fallback_order, personal_connections_allowed,
            personal_fallback_allowed, updated_by_subject_id, updated_at
          ) values (
            ${input.accountId}::uuid, ${input.workspaceId}::uuid,
            case when ${organizationRow} then coalesce(${rotationJson}::jsonb, '{}'::jsonb)
              else ${rotationJson}::jsonb end,
            case when ${organizationRow} then coalesce(${providerJson}::jsonb, '{}'::jsonb)
              else ${providerJson}::jsonb end,
            ${primaryInsertValue}
            case when ${organizationRow} then false end,
            case when ${organizationRow} then '{}'::jsonb end,
            case when ${organizationRow} then true end,
            case when ${organizationRow} then false end,
            ${input.subjectId}, clock_timestamp()
          )
          on conflict (account_id, workspace_id) do nothing
          returning id::text as id`,
      );
      if (inserted.length > 0) return true;
      // A concurrent writer inserted the row first; update it.
      return (await update(scoped)).length > 0;
    });
  } catch (error) {
    if (isSubscriptionCoreRlsRefusal(error)) return false;
    throw error;
  }
}

/** The rotation mode in effect at the row being written, for an override that keeps it. */
async function effectiveRotationMode(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration,
): Promise<"spread" | "primary_first"> {
  if (input.workspaceId) {
    return subscriptionCoreProviderSettings(
      provider,
      await readSubscriptionEffectiveSettings(tx, input.accountId, input.workspaceId),
    ).rotationMode;
  }
  const [org] = await rawRows<{ mode: string | null }>(
    tx,
    sql`select rotation->(${subscriptionCoreProviderId(provider)}::text)->>'mode' as mode
      from subscription_settings
      where account_id = ${input.accountId}::uuid and workspace_id is null`,
  );
  return org?.mode === "primary_first" ? "primary_first" : "spread";
}

/**
 * The account unpinned sessions prefer: the primary connection of this
 * workspace (or the organization), keeping the rotation mode currently in
 * effect there.
 */
export async function setSubscriptionCorePrimary(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration & { connectionId: string },
): Promise<{ activated: string | null; wake: SubscriptionCoreWake | null }> {
  // Refused up front, before any lock or read, for personal and shared
  // connections alike (after the binding's own checks).
  subscriptionCoreProviderId(provider);
  if (provider.settings.primaryColumn === null) throw primaryUnsupported(provider);
  return await withAdministration(db, input, async (tx) => {
    const personal = await managePersonalConnection(tx, provider, input, "primary");
    if (personal)
      return { activated: personal.id, wake: wakeFor(provider, input, "primary_changed") };
    // The organization primary stays within the organization pool: a
    // workspace-managed account keeps its workspace classification (5.4).
    const current = await visibleSharedConnection(tx, provider, input, input.connectionId, {
      organizationPoolOnly: true,
    });
    if (!current) return { activated: null, wake: null };
    const written = await writeSettingsRow(tx, provider, input, {
      rotationMode: await effectiveRotationMode(tx, provider, input),
      primaryConnectionId: current.id,
    });
    return written
      ? { activated: current.id, wake: wakeFor(provider, input, "primary_changed") }
      : { activated: null, wake: null };
  });
}

/**
 * The primary a new or updated workspace rotation override must carry so the
 * effective primary does not change: the organization's while the workspace
 * inherits rotation from it, nothing to change while it already has its own.
 */
async function inheritedPrimaryForOverride(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration,
): Promise<{ primaryConnectionId: string | null } | Record<string, never>> {
  // A provider without a primary setting has nothing to carry.
  if (!input.workspaceId || provider.settings.primaryColumn === null) return {};
  const settings = subscriptionCoreProviderSettings(
    provider,
    await readSubscriptionEffectiveSettings(tx, input.accountId, input.workspaceId),
  );
  if (settings.rotationSource === "workspace") return {};
  return {
    primaryConnectionId: await readSubscriptionCorePrimaryConnectionId(
      tx,
      provider,
      input.accountId,
      null,
    ),
  };
}

/**
 * Rotation switch: on is `spread`, off is `primary_first` (D-13). A
 * workspace override carries the effective (inherited) primary, so toggling
 * rotation never drops the account unpinned sessions prefer. Returns null
 * when the subject may not write the row.
 */
export async function setSubscriptionCoreRotation(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreAdministration & { rotationEnabled: boolean },
): Promise<{ primaryConnectionId: string | null; wake: SubscriptionCoreWake } | null> {
  return await withAdministration(db, input, async (tx) => {
    const written = await writeSettingsRow(tx, provider, input, {
      rotationMode: input.rotationEnabled ? "spread" : "primary_first",
      ...(await inheritedPrimaryForOverride(tx, provider, input)),
    });
    if (!written) return null;
    return {
      primaryConnectionId: await readSubscriptionCorePrimaryConnectionId(
        tx,
        provider,
        input.accountId,
        input.workspaceId,
      ),
      wake: wakeFor(provider, input, "rotation_changed"),
    };
  });
}

/**
 * Workspace source modes as the workspace's provider override: `automatic`
 * removes it, `workspace`/`organization` set `inferenceSource`, `disabled`
 * sets `enabled = false`. Connection scope and the model allowlist are never
 * touched (design 5.2). Throws the provider's source-refused error.
 */
export async function setSubscriptionCoreWorkspaceSource(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    mode: SubscriptionCoreWorkspaceSourceMode;
  },
): Promise<{ pool: SubscriptionCoreWorkspacePool; wake: SubscriptionCoreWake }> {
  return await withAdministration(db, input, async (tx) => {
    const [workspace] = await rawRows<{ workspace_kind: string }>(
      tx,
      sql`select get_workspace_kind(${input.accountId}::uuid, ${input.workspaceId}::uuid)
        as workspace_kind`,
    );
    if (workspace?.workspace_kind === "personal" && input.mode !== "automatic") {
      throw provider.errors.sourceRefused(
        "personal_workspace",
        `${provider.adapter.displayName} source modes are not available for personal workspaces`,
      );
    }
    const written = await writeSettingsRow(tx, provider, input, {
      providerSettings:
        input.mode === "automatic"
          ? null
          : input.mode === "disabled"
            ? { enabled: false }
            : { enabled: true, inferenceSource: input.mode },
    });
    if (!written) {
      throw provider.errors.sourceRefused(
        "forbidden",
        `missing permission to change this workspace's ${provider.adapter.displayName} source`,
      );
    }
    return {
      pool: await readSubscriptionCoreWorkspacePool(tx, provider, input),
      wake: wakeFor(provider, input, "source_changed"),
    };
  });
}
