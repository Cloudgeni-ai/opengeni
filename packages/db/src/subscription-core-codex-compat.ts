/**
 * Legacy Codex route shapes projected from the shared subscription core
 * (M3 PR 2b, SUB-COMPAT-02).
 *
 * Dormant until an organization's Codex cutover row is enabled: API handlers
 * read `readCodexCutoverDisposition` first and call into this module only for
 * the `core` disposition. Every read and write runs under the caller's own
 * row-level-security context (organization, workspace and, for writes, the
 * authenticated subject), so the core tables' policies decide visibility and
 * management authority: an organization administrator, or a workspace
 * administrator for a connection or setting that workspace manages. Nothing
 * here reads or writes a legacy Codex table, and nothing returns credential
 * material. Personal connections are never listed (they are visible only
 * inside their owner's exact accepted turn).
 */
import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import {
  decodeSubscriptionQuota,
  readSubscriptionEffectiveSettings,
  readSubscriptionProviderCutoverState,
  resolveSubscriptionConnectionId,
} from "./subscription-core-repository";
import type {
  CodexAccountStatus,
  CodexRotationSettings,
  EffectiveCodexSubscriptionSource,
  WorkspaceCodexSubscriptionMode,
  WorkspaceCodexSubscriptionSource,
} from "./index";

/**
 * `legacy`: no cutover row, the legacy Codex path is unchanged. `core`: the
 * cutover is enabled. `maintenance`: a disabled cutover row; callers fail
 * closed and read no legacy Codex table.
 */
export type CodexCutoverDisposition = "legacy" | "core" | "maintenance";

export async function readCodexCutoverDisposition(
  db: Database,
  accountId: string,
  /**
   * The caller's workspace, when it has one. The cutover row needs only the
   * account scope, but a caller inside a shared request transaction (whose
   * sibling queries run concurrently) must not have its workspace setting
   * changed underneath them, so the nested scope keeps the same workspace.
   */
  workspaceId: string | null = null,
): Promise<CodexCutoverDisposition> {
  const state = await withRlsContext(
    db,
    { accountId, workspaceId },
    async (tx) => await readSubscriptionProviderCutoverState(tx, { accountId, provider: "codex" }),
  );
  return state === "not_configured" ? "legacy" : state === "enabled" ? "core" : "maintenance";
}

/** A wake the caller delivers after its mutation committed. */
export type SubscriptionCoreCodexWake = {
  accountId: string;
  reason: string;
  workspaceIds?: readonly string[];
};

type ConnectionRow = {
  id: string;
  label: string | null;
  account_email: string | null;
  plan_type: string | null;
  provider_account_id: string | null;
  status: string;
  last_error: string | null;
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

function stateDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function projectAccount(
  row: ConnectionRow,
  input: {
    source: Exclude<EffectiveCodexSubscriptionSource, "disabled">;
    primaryConnectionId: string | null;
    poolAllocatorEnabled: boolean;
  },
): CodexAccountStatus {
  const quota = decodeSubscriptionQuota(row);
  const window = (id: string) => quota?.windows.find((candidate) => candidate.id === id);
  const primary = window("primary");
  const secondary = window("secondary");
  const resetCount = row.provider_state?.resetCreditAvailableCount;
  return {
    id: row.id,
    source: input.source,
    chatgptAccountId: row.provider_account_id,
    label: row.label,
    accountEmail: row.account_email,
    planType: row.plan_type,
    planCheckedAt: null,
    planPreviousType: null,
    planChangedAt: null,
    planEntitlementExclusion: null,
    status: row.status,
    allocatorEnabled: row.allocator_enabled && input.poolAllocatorEnabled,
    allocatorVersion: Number(row.allocator_version),
    allocatorUpdatedBySubjectId: null,
    allocatorUpdatedAt: date(row.updated_at),
    resetCreditAvailableCount:
      typeof resetCount === "number" && Number.isSafeInteger(resetCount) ? resetCount : null,
    resetCreditsCheckedAt: stateDate(row.provider_state?.resetCreditsCheckedAt),
    connectedBySubjectId: row.connected_by_subject_id,
    isActive: row.id === input.primaryConnectionId,
    expiresAt: date(row.expires_at),
    lastRefreshAt: date(row.last_refresh_at),
    lastError: row.last_error,
    primaryUsedPercent: primary?.usedPercent ?? null,
    primaryResetAt: primary?.resetsAt == null ? null : new Date(primary.resetsAt),
    secondaryUsedPercent: secondary?.usedPercent ?? null,
    secondaryResetAt: secondary?.resetsAt == null ? null : new Date(secondary.resetsAt),
    usageCheckedAt: quota?.observedAt == null ? null : new Date(quota.observedAt),
    exhaustedUntil: quota?.exhaustedUntil == null ? null : new Date(quota.exhaustedUntil),
    exhaustedKind: quota?.exhaustedKind ?? null,
    allowedModelIds: row.allowed_model_ids,
  };
}

type EffectiveCodexSettings = {
  enabled: boolean;
  inferenceSource: "automatic" | "workspace" | "organization";
  rotationMode: "spread" | "primary_first";
  rotationSource: "organization" | "workspace";
};

function effectiveCodexSettings(
  effective: Awaited<ReturnType<typeof readSubscriptionEffectiveSettings>>,
): EffectiveCodexSettings {
  const values = effective.values as unknown as {
    rotation?: Record<string, { mode?: unknown } | undefined>;
    providers?: Record<string, { enabled?: unknown; inferenceSource?: unknown } | undefined>;
  };
  const provider = values.providers?.codex;
  const source = provider?.inferenceSource;
  return {
    enabled: provider?.enabled !== false,
    inferenceSource: source === "workspace" || source === "organization" ? source : "automatic",
    rotationMode: values.rotation?.codex?.mode === "primary_first" ? "primary_first" : "spread",
    rotationSource: effective.sources.rotation.codex === "workspace" ? "workspace" : "organization",
  };
}

async function readPrimaryConnectionId(
  tx: Database,
  accountId: string,
  workspaceId: string | null,
): Promise<string | null> {
  const [row] = await rawRows<{ primary_id: string | null }>(
    tx,
    sql`select codex_primary_connection_id::text as primary_id from subscription_settings
      where account_id = ${accountId}::uuid
        and workspace_id is not distinct from ${workspaceId}::uuid`,
  );
  return row?.primary_id ?? null;
}

export type SubscriptionCoreCodexWorkspaceProjection = {
  accounts: CodexAccountStatus[];
  rotation: CodexRotationSettings;
  source: WorkspaceCodexSubscriptionSource;
};

/**
 * The workspace's Codex account pool, rotation and source in the legacy
 * shapes. Requires the workspace RLS context on `tx`. Only shared
 * subscription connections in the workspace's scope are listed; an
 * administrator's wider visibility is filtered explicitly.
 */
export async function projectSubscriptionCoreCodexWorkspace(
  tx: Database,
  input: { accountId: string; workspaceId: string },
): Promise<SubscriptionCoreCodexWorkspaceProjection> {
  const [workspace] = await rawRows<{ workspace_kind: "personal" | "shared" }>(
    tx,
    sql`select get_workspace_kind(${input.accountId}::uuid, ${input.workspaceId}::uuid)
      as workspace_kind`,
  );
  const workspaceKind = workspace?.workspace_kind === "personal" ? "personal" : "shared";
  const settings = effectiveCodexSettings(
    await readSubscriptionEffectiveSettings(tx, input.accountId, input.workspaceId),
  );
  const rows = await rawRows<ConnectionRow & { pools: string[] | null }>(
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
      and connection.provider = 'codex' and connection.kind = 'subscription'
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
  const mode: WorkspaceCodexSubscriptionMode = await (async () => {
    const [row] = await rawRows<{ codex: { enabled?: unknown; inferenceSource?: unknown } | null }>(
      tx,
      sql`select providers->'codex' as codex from subscription_settings
        where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
    );
    if (row?.codex?.enabled === false) return "disabled";
    if (row?.codex?.inferenceSource === "workspace") return "workspace";
    if (row?.codex?.inferenceSource === "organization") return "organization";
    return "automatic";
  })();
  const effectiveSource: EffectiveCodexSubscriptionSource = !settings.enabled
    ? "disabled"
    : settings.inferenceSource !== "automatic"
      ? settings.inferenceSource
      : workspaceAvailable
        ? "workspace"
        : "organization";
  const primaryConnectionId = await readPrimaryConnectionId(
    tx,
    input.accountId,
    settings.rotationSource === "workspace" ? input.workspaceId : null,
  );
  // Only the effective pool is listed (legacy parity): nothing while Codex is
  // disabled here, only workspace-classified connections for the workspace
  // source and only organization-classified ones for the organization
  // source. Automatic admits both shared pools on the core, so both are
  // listed. Callers with mere workspace read access must not see accounts
  // that cannot serve this workspace.
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
  const accounts = pools.filter(inEffectiveSource).map(({ row, entries, local }) => {
    const inEffectivePool = entries.filter((entry) => entry.pool === effectiveSource);
    return projectAccount(row, {
      source: local ? "workspace" : "organization",
      primaryConnectionId,
      poolAllocatorEnabled:
        entries.length === 0 ||
        (inEffectivePool.length > 0 ? inEffectivePool : entries).some((entry) => entry.allocator),
    });
  });
  return {
    accounts,
    rotation: {
      activeCredentialId: primaryConnectionId,
      rotationEnabled: settings.rotationMode === "spread",
      rotationStrategy: "sharded",
    },
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

export async function getSubscriptionCoreCodexWorkspaceProjection(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<SubscriptionCoreCodexWorkspaceProjection> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => await projectSubscriptionCoreCodexWorkspace(tx, input),
  );
}

/**
 * The organization's own Codex accounts (shared connections no workspace
 * manages) and its rotation, for an organization administrator. A
 * non-administrator sees nothing: the connection policy hides every row.
 */
export async function getSubscriptionCoreOrganizationCodexProjection(
  db: Database,
  input: { organizationId: string; subjectId: string },
): Promise<{ accounts: CodexAccountStatus[]; rotation: CodexRotationSettings }> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      const [admin] = await rawRows<{ admin: boolean }>(
        tx,
        sql`select opengeni_private.subscription_organization_admin(${input.organizationId}::uuid) as admin`,
      );
      if (admin?.admin !== true) {
        return {
          accounts: [],
          rotation: {
            activeCredentialId: null,
            rotationEnabled: false,
            rotationStrategy: "sharded",
          },
        };
      }
      const [org] = await rawRows<{ mode: string | null; primary_id: string | null }>(
        tx,
        sql`select rotation->'codex'->>'mode' as mode,
          codex_primary_connection_id::text as primary_id
        from subscription_settings
        where account_id = ${input.organizationId}::uuid and workspace_id is null`,
      );
      const primaryConnectionId = org?.primary_id ?? null;
      const rows = await rawRows<ConnectionRow>(
        tx,
        sql`select ${CONNECTION_COLUMNS}
      from subscription_connections connection
      left join subscription_connection_quota quota
        on quota.account_id = connection.account_id and quota.connection_id = connection.id
      where connection.account_id = ${input.organizationId}::uuid
        and connection.provider = 'codex' and connection.kind = 'subscription'
        and connection.ownership = 'shared' and connection.managed_by_workspace_id is null
      order by connection.created_at, connection.id`,
      );
      return {
        accounts: rows.map((row) =>
          projectAccount(row, {
            source: "organization",
            primaryConnectionId,
            poolAllocatorEnabled: true,
          }),
        ),
        rotation: {
          activeCredentialId: primaryConnectionId,
          rotationEnabled: (org?.mode ?? "spread") !== "primary_first",
          rotationStrategy: "sharded",
        },
      };
    },
  );
}

function isRlsRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "42501" || causeCode === "42501";
}

type Administration = { accountId: string; workspaceId: string | null; subjectId: string };

async function withCodexAdministration<T>(
  db: Database,
  input: Administration,
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

/** Resolve a legacy or canonical id to a visible shared Codex subscription connection. */
async function visibleSharedConnection(
  tx: Database,
  accountId: string,
  rawId: string,
): Promise<{ id: string; allocatorEnabled: boolean; allocatorVersion: number } | null> {
  const connectionId = await resolveSubscriptionConnectionId(tx, {
    accountId,
    provider: "codex",
    connectionId: rawId,
  });
  if (!connectionId) return null;
  const [row] = await rawRows<{ allocator_enabled: boolean; allocator_version: number | string }>(
    tx,
    sql`select allocator_enabled, allocator_version from subscription_connections
      where account_id = ${accountId}::uuid and provider = 'codex' and kind = 'subscription'
        and ownership = 'shared' and id = ${connectionId}::uuid`,
  );
  return row
    ? {
        id: connectionId,
        allocatorEnabled: row.allocator_enabled,
        allocatorVersion: Number(row.allocator_version),
      }
    : null;
}

export type SubscriptionCoreCodexAllocatorResult =
  | {
      kind: "updated" | "unchanged" | "conflict";
      allocatorEnabled: boolean;
      allocatorVersion: number;
      allocatorUpdatedAt: Date | null;
    }
  | { kind: "not_found" };

/**
 * New-allocation eligibility of one connection, with the legacy optimistic
 * concurrency: the same state is idempotent even with a stale version; a
 * conflicting stale version returns the current one. Organization
 * administrators and the connection's delegated manager may toggle it.
 */
export async function setSubscriptionCoreCodexAllocator(
  db: Database,
  input: Administration & { connectionId: string; enabled: boolean; expectedVersion: number },
): Promise<{
  result: SubscriptionCoreCodexAllocatorResult;
  wake: SubscriptionCoreCodexWake | null;
}> {
  return await withCodexAdministration(db, input, async (tx) => {
    const current = await visibleSharedConnection(tx, input.accountId, input.connectionId);
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
    if (current.allocatorEnabled === input.enabled) {
      return {
        result: projection(
          "unchanged",
          current.allocatorEnabled,
          current.allocatorVersion,
          stamp?.updated_at ?? null,
        ),
        wake: null,
      };
    }
    if (current.allocatorVersion !== input.expectedVersion) {
      return {
        result: projection(
          "conflict",
          current.allocatorEnabled,
          current.allocatorVersion,
          stamp?.updated_at ?? null,
        ),
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
        return row;
      });
    } catch (error) {
      if (isRlsRefusal(error)) return { result: { kind: "not_found" }, wake: null };
      throw error;
    }
    // The update policy hides a connection this subject may not manage.
    if (!updated) return { result: { kind: "not_found" }, wake: null };
    return {
      result: projection(
        "updated",
        input.enabled,
        Number(updated.allocator_version),
        updated.updated_at,
      ),
      // Re-enabling can make a waiting turn placeable; disabling changes nothing
      // a waiter needs, but a single wake is cheap and keeps the rule simple.
      wake: { accountId: input.accountId, reason: "core_codex_allocator_changed" },
    };
  });
}

/** Rename one connection (label only). Returns false when it is not manageable. */
export async function renameSubscriptionCoreCodexConnection(
  db: Database,
  input: Administration & { connectionId: string; label: string | null },
): Promise<string | null> {
  return await withCodexAdministration(db, input, async (tx) => {
    const current = await visibleSharedConnection(tx, input.accountId, input.connectionId);
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
      if (isRlsRefusal(error)) return null;
      throw error;
    }
  });
}

/**
 * Upsert one settings row (organization row for a NULL workspace) through the
 * settings manager policy. Returns false when the subject may not write it.
 */
async function writeSettingsRow(
  tx: Database,
  input: Administration,
  patch: {
    rotationMode?: "spread" | "primary_first";
    primaryConnectionId?: string | null;
    codexProvider?: Record<string, unknown> | null;
  },
): Promise<boolean> {
  const rotationJson =
    patch.rotationMode === undefined
      ? null
      : JSON.stringify({ codex: { mode: patch.rotationMode } });
  const providerJson =
    patch.codexProvider === undefined || patch.codexProvider === null
      ? null
      : JSON.stringify({ codex: patch.codexProvider });
  const clearProvider = patch.codexProvider === null;
  const setPrimary = patch.primaryConnectionId !== undefined;
  try {
    const rows = await tx.transaction(async (savepoint) =>
      rawRows<{ id: string }>(
        savepoint as unknown as Database,
        sql`insert into subscription_settings (
            account_id, workspace_id, rotation, providers, codex_primary_connection_id,
            updated_by_subject_id, updated_at
          ) values (
            ${input.accountId}::uuid, ${input.workspaceId}::uuid,
            ${rotationJson}::jsonb, ${providerJson}::jsonb,
            ${setPrimary ? (patch.primaryConnectionId ?? null) : null}::uuid,
            ${input.subjectId}, clock_timestamp()
          )
          on conflict (account_id, workspace_id) do update set
            rotation = case when ${rotationJson}::jsonb is null then subscription_settings.rotation
              else coalesce(subscription_settings.rotation, '{}'::jsonb) || ${rotationJson}::jsonb end,
            providers = case
              when ${clearProvider} then subscription_settings.providers - 'codex'
              when ${providerJson}::jsonb is null then subscription_settings.providers
              else coalesce(subscription_settings.providers, '{}'::jsonb) || ${providerJson}::jsonb end,
            codex_primary_connection_id = case when ${setPrimary}
              then ${setPrimary ? (patch.primaryConnectionId ?? null) : null}::uuid
              else subscription_settings.codex_primary_connection_id end,
            version = subscription_settings.version + 1,
            updated_by_subject_id = excluded.updated_by_subject_id,
            updated_at = excluded.updated_at
          returning id::text as id`,
      ),
    );
    return rows.length > 0;
  } catch (error) {
    if (isRlsRefusal(error)) return false;
    throw error;
  }
}

/** The rotation mode in effect at the row being written, for an override that keeps it. */
async function effectiveRotationMode(
  tx: Database,
  input: Administration,
): Promise<"spread" | "primary_first"> {
  if (input.workspaceId) {
    return effectiveCodexSettings(
      await readSubscriptionEffectiveSettings(tx, input.accountId, input.workspaceId),
    ).rotationMode;
  }
  const [org] = await rawRows<{ mode: string | null }>(
    tx,
    sql`select rotation->'codex'->>'mode' as mode from subscription_settings
      where account_id = ${input.accountId}::uuid and workspace_id is null`,
  );
  return org?.mode === "primary_first" ? "primary_first" : "spread";
}

function wakeFor(input: Administration, reason: string): SubscriptionCoreCodexWake {
  return input.workspaceId
    ? { accountId: input.accountId, reason, workspaceIds: [input.workspaceId] }
    : { accountId: input.accountId, reason };
}

/**
 * Legacy "activate": the account unpinned sessions prefer. Core: the
 * primary connection of this workspace (or the organization), keeping the
 * rotation mode currently in effect there.
 */
export async function setSubscriptionCoreCodexPrimary(
  db: Database,
  input: Administration & { connectionId: string },
): Promise<{ activated: string | null; wake: SubscriptionCoreCodexWake | null }> {
  return await withCodexAdministration(db, input, async (tx) => {
    const current = await visibleSharedConnection(tx, input.accountId, input.connectionId);
    if (!current) return { activated: null, wake: null };
    const written = await writeSettingsRow(tx, input, {
      rotationMode: await effectiveRotationMode(tx, input),
      primaryConnectionId: current.id,
    });
    return written
      ? { activated: current.id, wake: wakeFor(input, "core_codex_primary_changed") }
      : { activated: null, wake: null };
  });
}

/** Legacy rotation toggle: on is `spread`, off is `primary_first` (D-13). */
export async function setSubscriptionCoreCodexRotation(
  db: Database,
  input: Administration & { rotationEnabled: boolean },
): Promise<{ rotation: CodexRotationSettings | null; wake: SubscriptionCoreCodexWake | null }> {
  return await withCodexAdministration(db, input, async (tx) => {
    const written = await writeSettingsRow(tx, input, {
      rotationMode: input.rotationEnabled ? "spread" : "primary_first",
    });
    if (!written) return { rotation: null, wake: null };
    return {
      rotation: {
        activeCredentialId: await readPrimaryConnectionId(tx, input.accountId, input.workspaceId),
        rotationEnabled: input.rotationEnabled,
        rotationStrategy: "sharded",
      },
      wake: wakeFor(input, "core_codex_rotation_changed"),
    };
  });
}

export class SubscriptionCoreCodexSourceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionCoreCodexSourceRefusedError";
  }
}

/**
 * Legacy workspace source modes as the workspace's Codex provider override:
 * `automatic` removes it, `workspace`/`organization` set `inferenceSource`,
 * `disabled` sets `enabled = false`. Connection scope and the model allowlist
 * are never touched (design 5.2).
 */
export async function setSubscriptionCoreWorkspaceCodexSource(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    mode: WorkspaceCodexSubscriptionMode;
  },
): Promise<{ source: WorkspaceCodexSubscriptionSource; wake: SubscriptionCoreCodexWake }> {
  return await withCodexAdministration(db, input, async (tx) => {
    const [workspace] = await rawRows<{ workspace_kind: string }>(
      tx,
      sql`select get_workspace_kind(${input.accountId}::uuid, ${input.workspaceId}::uuid)
        as workspace_kind`,
    );
    if (workspace?.workspace_kind === "personal" && input.mode !== "automatic") {
      throw new SubscriptionCoreCodexSourceRefusedError(
        "Codex source modes are not available for personal workspaces",
      );
    }
    const written = await writeSettingsRow(tx, input, {
      codexProvider:
        input.mode === "automatic"
          ? null
          : input.mode === "disabled"
            ? { enabled: false }
            : { enabled: true, inferenceSource: input.mode },
    });
    if (!written) {
      throw new SubscriptionCoreCodexSourceRefusedError(
        "missing permission to change this workspace's Codex source",
      );
    }
    const projection = await projectSubscriptionCoreCodexWorkspace(tx, input);
    return {
      source: projection.source,
      wake: wakeFor(input, "core_codex_source_changed"),
    };
  });
}
