/**
 * Legacy Codex route shapes projected from the shared subscription core
 * (M3 PR 2b, SUB-COMPAT-02).
 *
 * Dormant until an organization's Codex cutover row is enabled: API handlers
 * read `readCodexCutoverDisposition` first and call into this module only for
 * the `core` disposition. The pools, settings and writers themselves are
 * provider-neutral (`subscription-core/administration`) and run under the
 * caller's own row-level-security context; this module supplies Codex as
 * data and projects the neutral rows into the legacy Codex account shape
 * (ChatGPT account id, reset credits, plan history and plan-entitlement
 * exclusions). Nothing here reads or writes a legacy Codex table, and nothing
 * returns credential material. Personal connections are listed only to their
 * owner, through the owner-only reader.
 */
import { codexPlanKey } from "@opengeni/codex";
import { CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS } from "./codex-plan-entitlement";
import { withRlsContext, type Database } from "./database";
import { decodeSubscriptionQuota } from "./subscription-core-repository";
import {
  listSubscriptionCorePersonalConnectionRowsInTransaction,
  readSubscriptionCoreCutoverDisposition,
  readSubscriptionCoreOrganizationPool,
  readSubscriptionCoreWorkspacePool,
  renameSubscriptionCoreConnection,
  setSubscriptionCoreAllocator,
  setSubscriptionCoreExtraCredits,
  setSubscriptionCorePrimary,
  setSubscriptionCoreRotation,
  setSubscriptionCoreWorkspaceSource,
  type SubscriptionCoreAdministration,
  type SubscriptionCoreAllocatorResult,
  type SubscriptionCoreConnectionRow,
  type SubscriptionCoreCutoverDisposition,
  type SubscriptionCoreExtraCreditsResult,
  type SubscriptionCoreWake,
} from "./subscription-core/administration";
import { SUBSCRIPTION_CORE_CODEX } from "./subscription-core-codex-adapter";
import type {
  CodexAccountStatus,
  CodexRotationSettings,
  EffectiveCodexSubscriptionSource,
  WorkspaceCodexSubscriptionMode,
  WorkspaceCodexSubscriptionSource,
} from "./codex-account-types";

export { SubscriptionCoreCodexSourceRefusedError } from "./subscription-core-codex-errors";

/**
 * `core`: the cutover is enabled. `maintenance`: a missing or disabled row; callers fail
 * closed and read no legacy Codex table.
 */
export type CodexCutoverDisposition = SubscriptionCoreCutoverDisposition;

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
  return await readSubscriptionCoreCutoverDisposition(
    db,
    SUBSCRIPTION_CORE_CODEX,
    accountId,
    workspaceId,
  );
}

/** A wake the caller delivers after its mutation committed. */
export type SubscriptionCoreCodexWake = SubscriptionCoreWake;

function date(value: Date | string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

function stateDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function projectAccount(
  row: SubscriptionCoreConnectionRow,
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
    // Plan history the M3 cutover carried over (and later plan changes the
    // connection trigger records) is adapter-owned provider state.
    planCheckedAt: stateDate(row.provider_state?.planCheckedAt),
    planPreviousType:
      typeof row.provider_state?.planPreviousType === "string"
        ? row.provider_state.planPreviousType
        : null,
    planChangedAt: stateDate(row.provider_state?.planChangedAt),
    planEntitlementExclusion: planCooldownExclusion(row.plan_type, quota),
    status: row.status,
    extraCreditsEnabled: row.extra_credits_enabled,
    extraCreditsVersion: Number(row.extra_credits_version),
    extraCreditsUpdatedAt: date(row.extra_credits_updated_at),
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

/**
 * The legacy plan-entitlement projection of the core's per-model cooldowns: a
 * proven plan refusal is a 24-hour model cooldown on the connection (design
 * PR 2a), so each live cooldown is reported under the connection's current
 * plan with the time it was proven.
 */
function planCooldownExclusion(
  planType: string | null,
  quota: ReturnType<typeof decodeSubscriptionQuota>,
): NonNullable<CodexAccountStatus["planEntitlementExclusion"]> | null {
  const models = Object.entries(quota?.modelCooldowns ?? {})
    .filter(([, until]) => Number.isFinite(until))
    .map(([modelId, until]) => ({
      modelId,
      excludedAt: new Date(until - CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS),
    }))
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
  return models.length === 0 ? null : { planType: codexPlanKey(planType), models };
}

function rotationSettings(
  primaryConnectionId: string | null,
  rotationEnabled: boolean,
): CodexRotationSettings {
  return { activeCredentialId: primaryConnectionId, rotationEnabled, rotationStrategy: "sharded" };
}

export type SubscriptionCoreCodexWorkspaceProjection = {
  accounts: CodexAccountStatus[];
  rotation: CodexRotationSettings;
  source: WorkspaceCodexSubscriptionSource;
  /** The viewer's own personal connections among `accounts` (Personal workspace only). */
  personalAccountIds?: string[];
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
  const pool = await readSubscriptionCoreWorkspacePool(tx, SUBSCRIPTION_CORE_CODEX, input);
  return {
    accounts: pool.connections.map((entry) =>
      projectAccount(entry.row, {
        source: entry.source,
        primaryConnectionId: pool.primaryConnectionId,
        poolAllocatorEnabled: entry.poolAllocatorEnabled,
      }),
    ),
    rotation: rotationSettings(pool.primaryConnectionId, pool.rotationMode === "spread"),
    source: pool.source,
  };
}

export async function getSubscriptionCoreCodexWorkspaceProjection(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    /**
     * The viewing person. In their own Personal workspace their personal
     * Codex connections are listed with the workspace pool (M3 PR 3b).
     */
    viewerSubjectId?: string | null;
  },
): Promise<SubscriptionCoreCodexWorkspaceProjection> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const projection = await projectSubscriptionCoreCodexWorkspace(tx, input);
      if (!input.viewerSubjectId || projection.source.workspaceKind !== "personal") {
        return projection;
      }
      const personal = await listSubscriptionCoreCodexPersonalAccountsInTransaction(tx, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.viewerSubjectId,
      });
      // Personal rows are intentionally visible only through the owner reader,
      // so sanitize the historical primary pointer after that projection joins.
      if (
        ![...projection.accounts, ...personal].some(
          (account) => account.id === projection.rotation.activeCredentialId,
        )
      ) {
        projection.rotation.activeCredentialId = null;
      }
      return personal.length === 0
        ? projection
        : {
            ...projection,
            accounts: [
              ...projection.accounts,
              ...personal.map((account) => ({
                ...account,
                isActive: account.id === projection.rotation.activeCredentialId,
              })),
            ],
            personalAccountIds: personal.map((account) => account.id),
          };
    },
  );
}

/**
 * The viewing person's own personal Codex connections in the legacy account
 * shape (no credential material), through the owner-only reader. Requires the
 * workspace RLS context on `tx`; sets the subject. Empty for anyone else, for
 * a workspace the person may not use, or without an enabled cutover.
 */
export async function listSubscriptionCoreCodexPersonalAccountsInTransaction(
  tx: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<CodexAccountStatus[]> {
  const rows = await listSubscriptionCorePersonalConnectionRowsInTransaction(
    tx,
    SUBSCRIPTION_CORE_CODEX,
    input,
  );
  return rows.map((row) =>
    projectAccount(row, {
      source: "workspace",
      primaryConnectionId: null,
      poolAllocatorEnabled: true,
    }),
  );
}

/**
 * The organization's Codex accounts (every shared connection it
 * administers, including ones a shared workspace manages) and its rotation,
 * for an organization administrator. A
 * non-administrator sees nothing: the connection policy hides every row.
 */
export async function getSubscriptionCoreOrganizationCodexProjection(
  db: Database,
  input: { organizationId: string; subjectId: string },
): Promise<{ accounts: CodexAccountStatus[]; rotation: CodexRotationSettings }> {
  const pool = await readSubscriptionCoreOrganizationPool(db, SUBSCRIPTION_CORE_CODEX, input);
  if (!pool) return { accounts: [], rotation: rotationSettings(null, false) };
  return {
    accounts: pool.rows.map((row) => ({
      ...projectAccount(row, {
        source: "organization",
        primaryConnectionId: pool.primaryConnectionId,
        poolAllocatorEnabled: true,
      }),
      ownInWorkspaceIds: pool.ownInWorkspaceIds.get(row.id) ?? [],
    })),
    rotation: rotationSettings(pool.primaryConnectionId, pool.rotationMode === "spread"),
  };
}

type Administration = SubscriptionCoreAdministration;

export type SubscriptionCoreCodexAllocatorResult = SubscriptionCoreAllocatorResult;

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
  return await setSubscriptionCoreAllocator(db, SUBSCRIPTION_CORE_CODEX, input);
}

export type SubscriptionCoreCodexExtraCreditsResult = SubscriptionCoreExtraCreditsResult;

/**
 * Consent to paid usage beyond the plan for one connection, with the same
 * optimistic concurrency as the allocator switch. Organization
 * administrators and the connection's delegated manager may toggle it.
 */
export async function setSubscriptionCoreCodexExtraCredits(
  db: Database,
  input: Administration & { connectionId: string; enabled: boolean; expectedVersion: number },
): Promise<{
  result: SubscriptionCoreCodexExtraCreditsResult;
  wake: SubscriptionCoreCodexWake | null;
}> {
  return await setSubscriptionCoreExtraCredits(db, SUBSCRIPTION_CORE_CODEX, input);
}

/** Rename one connection (label only). Returns null when it is not manageable. */
export async function renameSubscriptionCoreCodexConnection(
  db: Database,
  input: Administration & { connectionId: string; label: string | null },
): Promise<string | null> {
  return await renameSubscriptionCoreConnection(db, SUBSCRIPTION_CORE_CODEX, input);
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
  return await setSubscriptionCorePrimary(db, SUBSCRIPTION_CORE_CODEX, input);
}

/**
 * Legacy rotation toggle: on is `spread`, off is `primary_first` (D-13). A
 * workspace override carries the effective (inherited) primary, so toggling
 * rotation never drops the account unpinned sessions prefer.
 */
export async function setSubscriptionCoreCodexRotation(
  db: Database,
  input: Administration & { rotationEnabled: boolean },
): Promise<{ rotation: CodexRotationSettings | null; wake: SubscriptionCoreCodexWake | null }> {
  const written = await setSubscriptionCoreRotation(db, SUBSCRIPTION_CORE_CODEX, input);
  if (!written) return { rotation: null, wake: null };
  return {
    rotation: rotationSettings(written.primaryConnectionId, input.rotationEnabled),
    wake: written.wake,
  };
}

/**
 * Legacy workspace source modes as the workspace's Codex provider override:
 * `automatic` removes it, `workspace`/`organization` set `inferenceSource`,
 * `disabled` sets `enabled = false`. Connection scope and the model allowlist
 * are never touched (design 5.2). Throws
 * `SubscriptionCoreCodexSourceRefusedError` when refused.
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
  const changed = await setSubscriptionCoreWorkspaceSource(db, SUBSCRIPTION_CORE_CODEX, input);
  return { source: changed.pool.source, wake: changed.wake };
}
