/**
 * The codec-aware stage of the Claude drained cutover maintenance migration
 * (design docs/design/subscription-core-2026-10-07.md, 5.3 "Data mapping",
 * "Cutover protocol" and "Claude track"; the Claude counterpart of the
 * SuperGrok stage, sharing its provider-neutral planner and writers).
 *
 * A closed, migration-owned conversion. The SQL migration opens the
 * owner-only window and records the `claude` receipt and registry row; this
 * stage decodes every legacy Claude credential (the stored plaintext is the
 * legacy secret object unchanged, `claude_oauth_v1` with `oauth`, else
 * `claude_setup_token_v1`), plans the connections with the neutral planner
 * and Claude's rules, mints each owner's single cutover generation, maps
 * `claude_subscription_account_usage` into the shared quota model (cooldowns
 * re-keyed from upstream to product model ids) and writes everything through
 * the neutral stage writer. The SQL that follows moves settings, bindings,
 * leases, waiters, auth-recovery receipts and accepted authority. It is
 * never a runtime path.
 *
 * Claude-specific here: the identity rules (the person is `accountUuid`; an
 * `oauth:`/`setup:` HMAC id is its own person key; OAuth and setup-token rows
 * never merge), the usage mapping and the organization's model catalog.
 * Secrets never leave this module: errors carry fixed text, conflicts a
 * content-free class and a count, and nothing logs.
 */
import type postgres from "postgres";
import { CLAUDE_DEFAULT_CONNECTION_MODEL_IDS, type ClaudeUsageObservation } from "@opengeni/config";
import { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import { decryptEnvironmentValue } from "./environment-crypto";
import {
  decodeSubscriptionCoreClaudeCredential,
  decodeSubscriptionCoreClaudeQuota,
  encodeSubscriptionCoreClaudeCredential,
  SUBSCRIPTION_CORE_CLAUDE,
  SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT,
  SUBSCRIPTION_CORE_CLAUDE_SETUP_TOKEN_FORMAT,
  subscriptionCoreClaudeProductModelIds,
} from "./subscription-core-claude-adapter";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";
import {
  planSubscriptionCoreCutover,
  type SubscriptionCutoverDecodedIdentity,
  type SubscriptionCutoverInput,
  type SubscriptionCutoverPlan,
  type SubscriptionCutoverRules,
  type SubscriptionCutoverSource,
} from "./subscription-core/cutover-plan";
import {
  contentFreeSubscriptionCutoverError,
  createSubscriptionCutoverStageTables,
  loadSubscriptionCutoverPlanContext,
  mintSubscriptionCutoverPersonalGenerations,
  subscriptionCutoverConflictError,
  SubscriptionCutoverStageError,
  writeSubscriptionCutoverConnections,
  type SubscriptionCutoverStagedConnection,
} from "./subscription-core/cutover-stage";

/** Splits the cutover migration into its owner-window prelude and its SQL backfill. */
export const CLAUDE_SUBSCRIPTION_CORE_CUTOVER_MARKER =
  "-- opengeni:claude-subscription-core-cutover-v1";
export const CLAUDE_SUBSCRIPTION_CORE_CUTOVER_MIGRATION =
  "0720_subscription_core_claude_cutover.sql";
const ORDINAL = CLAUDE_SUBSCRIPTION_CORE_CUTOVER_MIGRATION.slice(0, 4);
/** The legacy Claude resource kind of a `user` credential's personal authority. */
const LEGACY_RESOURCE_KIND = "claude_subscription";
/** An identity the connect writers derived from the token, not the Claude account. */
const HMAC_IDENTITY = /^(?:oauth|setup):/;

export type LegacyClaudeCredentialRow = {
  id: string;
  account_id: string;
  workspace_id: string | null;
  authority_scope: string;
  provider_account_id: string | null;
  label: string | null;
  account_email: string | null;
  plan_type: string | null;
  status: string;
  expires_at: Date | null;
  last_refresh_at: Date | null;
  last_error: string | null;
  version: number;
  allocator_enabled: boolean;
  allocator_version: number;
  exhausted_until: Date | null;
  selection_count: number;
  last_selected_at: Date | null;
  owner_organization_membership_id: string | null;
  organization_user_resource_authority_id: string | null;
  organization_user_resource_authority_generation: number | string | null;
  connected_by_subject_id: string | null;
  created_at: Date;
  updated_at: Date;
  allowed_model_ids: string[] | null;
  allowed_workspace_ids: string[] | null;
  allow_personal_workspaces: boolean;
};

/** One `claude_subscription_account_usage` row. */
export type LegacyClaudeUsageRow = {
  credential_id: string;
  credential_version: number;
  snapshot: unknown;
  model_cooldowns: unknown;
  updated_at: Date;
};

/** The legacy Claude statuses, healthiest first (design 5.3 "Identity and dedupe"). */
type ClaudeCutoverStatus = "active" | "error" | "needs_relogin" | "disabled";
const STATUS_RANK: Readonly<Record<ClaudeCutoverStatus, number>> = {
  active: 0,
  error: 1,
  needs_relogin: 2,
  disabled: 3,
};

function claudeCutoverSource(row: LegacyClaudeCredentialRow): SubscriptionCutoverSource {
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    authorityScope: row.authority_scope,
    status: row.status,
    providerAccountId: row.provider_account_id,
    accountEmail: row.account_email,
    lastRefreshAt: row.last_refresh_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    allocatorEnabled: row.allocator_enabled,
    allowedModelIds: row.allowed_model_ids,
    allowedWorkspaceIds: row.allowed_workspace_ids,
    allowPersonalWorkspaces: row.allow_personal_workspaces,
    ownerOrganizationMembershipId: row.owner_organization_membership_id,
    userAuthorityId: row.organization_user_resource_authority_id,
    userAuthorityGeneration: row.organization_user_resource_authority_generation,
  };
}

/** Claude's rules on the provider-neutral planner: its legacy row shape and four statuses. */
export const CLAUDE_CUTOVER_RULES: SubscriptionCutoverRules<
  LegacyClaudeCredentialRow,
  ClaudeCutoverStatus
> = Object.freeze({ statusRank: STATUS_RANK, source: claudeCutoverSource });

export type ClaudeCutoverPlan = SubscriptionCutoverPlan<
  LegacyClaudeCredentialRow,
  ClaudeCutoverStatus
>;

/**
 * The identity facts of one decoded credential (design 5.3 "Identity and
 * dedupe"). The person is the Claude `accountUuid`, and a stored account
 * UUID that contradicts it aborts. An `oauth:`/`setup:` HMAC id is derived
 * from the token at connect time, so it is never cross-checked against the
 * current token: it is its own person key, and only when its prefix agrees
 * with the credential's format. OAuth and setup-token rows never merge: a
 * setup token never carries a person key of its own (it reports no profile),
 * so a setup-format row is merged only with a row of the same HMAC id.
 */
export function claudeCutoverIdentity(
  storedProviderAccountId: string | null,
  credential: { identity: { accountUuid: string }; oauth?: unknown },
): SubscriptionCutoverDecodedIdentity {
  const stored = storedProviderAccountId?.trim() || null;
  const oauth = credential.oauth !== undefined && credential.oauth !== null;
  if (stored && HMAC_IDENTITY.test(stored)) {
    const tag = oauth ? "oauth:" : "setup:";
    return { tokenAccountId: null, tokenUserId: stored.startsWith(tag) ? stored : null };
  }
  const accountUuid = credential.identity.accountUuid.trim() || null;
  return { tokenAccountId: accountUuid, tokenUserId: oauth ? accountUuid : null };
}

/** Plan every legacy Claude credential with the neutral rules. Pure. */
export function planClaudeCutover(
  input: SubscriptionCutoverInput<LegacyClaudeCredentialRow>,
): ClaudeCutoverPlan {
  return planSubscriptionCoreCutover(CLAUDE_CUTOVER_RULES, input);
}

function time(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/** A legacy usage row's snapshot, when it is current for the credential version. */
function currentUsage(row: { version: number }, usage: LegacyClaudeUsageRow | undefined) {
  if (!usage || Number(usage.credential_version) !== Number(row.version)) return null;
  const parsed = ClaudeSubscriptionUsage.safeParse(usage.snapshot);
  return parsed.success && parsed.data.credentialVersion === Number(row.version)
    ? parsed.data
    : undefined;
}

/** The live legacy per-model cooldowns of a current usage row, by upstream model id. */
function legacyCooldowns(
  row: { version: number },
  usage: LegacyClaudeUsageRow | undefined,
  now: number,
): Map<string, number> {
  const cooldowns = new Map<string, number>();
  if (!usage || Number(usage.credential_version) !== Number(row.version)) return cooldowns;
  const raw = usage.model_cooldowns;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cooldowns;
  for (const [model, until] of Object.entries(raw as Record<string, unknown>)) {
    const end = typeof until === "string" ? Date.parse(until) : NaN;
    if (model.trim() && model.length <= 256 && Number.isFinite(end) && end > now) {
      cooldowns.set(model, Math.max(cooldowns.get(model) ?? end, end));
    }
  }
  return cooldowns;
}

/**
 * The shared quota model for one canonical connection (design 5.3 "Health
 * and quota", "Claude track"). A usage row current for the canonical
 * credential's version is decoded by the adapter's own rules
 * (`decodeSubscriptionCoreClaudeQuota`) against every Claude model the
 * organization can serve, and the observed refresh generation is that
 * version; otherwise the usage is unknown (NULL generation), never exhausted.
 * Legacy per-model cooldowns of every member (each current for its own
 * credential) are re-keyed to both product model ids and kept to their end.
 * The credential's own `exhausted_until`, which legacy honored only without a
 * current usage row, is carried as the connection's exhaustion (`quota`) in
 * that case, so a resting account keeps resting. The usage `refreshStatus`
 * (for example `reconnect`) stays a quota fact and never changes status
 * (design 5.3 "Data mapping"); a pending `reconnect` is a disposition.
 */
export function planClaudeCutoverQuota(input: {
  canonical: LegacyClaudeCredentialRow;
  members: readonly LegacyClaudeCredentialRow[];
  usage: ReadonlyMap<string, LegacyClaudeUsageRow>;
  upstreamModelIds: readonly string[];
  refreshGeneration: number;
  now: Date;
}): {
  quota: Record<string, unknown>;
  observedRefreshGeneration: number | null;
  updatedAt: Date;
  usageUnreadable: boolean;
  reconnectPending: boolean;
} {
  const { canonical, refreshGeneration } = input;
  const now = input.now.getTime();
  const usageRow = input.usage.get(canonical.id);
  const usage = currentUsage(canonical, usageRow);
  const observation: ClaudeUsageObservation | null =
    usage && usage.observedAt !== null
      ? {
          windows: usage.windows,
          observedAt: usage.observedAt,
          source: usage.source ?? "response_headers",
          requestStatus: usage.requestStatus ?? null,
          requestRestrictions: usage.requestRestrictions ?? [],
        }
      : null;
  const decoded = observation
    ? decodeSubscriptionCoreClaudeQuota({
        observation,
        refreshGeneration,
        upstreamModelIds: input.upstreamModelIds,
      })
    : null;
  const modelCooldowns: Record<string, number> = { ...decoded?.modelCooldowns };
  for (const member of input.members) {
    for (const [model, end] of legacyCooldowns(member, input.usage.get(member.id), now)) {
      for (const productModelId of subscriptionCoreClaudeProductModelIds(model)) {
        modelCooldowns[productModelId] = Math.max(modelCooldowns[productModelId] ?? end, end);
      }
    }
  }
  const legacyExhaustion = usage ? null : time(canonical.exhausted_until);
  const exhaustedUntil =
    decoded?.exhaustedUntil ??
    (legacyExhaustion !== null && legacyExhaustion > now ? legacyExhaustion : null);
  const known = Boolean(usage) || exhaustedUntil !== null || Object.keys(modelCooldowns).length > 0;
  return {
    quota: {
      windows: decoded?.windows ?? [],
      modelCooldowns,
      exhaustedUntil,
      exhaustedKind: exhaustedUntil === null ? null : (decoded?.exhaustedKind ?? "quota"),
      source: decoded?.source ?? (usage ? null : exhaustedUntil === null ? null : "refusal"),
      ...(usage
        ? { refreshStatus: usage.refreshStatus, refreshCheckedAt: usage.refreshCheckedAt }
        : {}),
    },
    observedRefreshGeneration: known ? refreshGeneration : null,
    updatedAt:
      decoded?.observedAt !== undefined && decoded.observedAt !== null
        ? new Date(decoded.observedAt)
        : (usageRow?.updated_at ?? input.now),
    usageUnreadable: usageRow !== undefined && usage === undefined,
    reconnectPending: usage?.refreshStatus === "reconnect",
  };
}

/** Driver errors never leave the stage with their parameters or detail text. */
export function contentFreeClaudeCutoverError(error: unknown): Error {
  return contentFreeSubscriptionCutoverError(error, "Claude");
}

/**
 * Decrypt one legacy credential and validate it as the adapter's stored
 * format (the legacy object unchanged, re-encoded in its field order). An
 * unreadable or invalid secret aborts the cutover with a fixed text.
 */
function decodeCredential(
  key: Uint8Array,
  encrypted: string,
  storedProviderAccountId: string | null,
): { plaintext: string; format: string; identity: SubscriptionCutoverDecodedIdentity } {
  try {
    const credential = decodeSubscriptionCoreClaudeCredential(
      decryptEnvironmentValue(key, encrypted),
    );
    return {
      plaintext: encodeSubscriptionCoreClaudeCredential(credential),
      format: credential.oauth
        ? SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT
        : SUBSCRIPTION_CORE_CLAUDE_SETUP_TOKEN_FORMAT,
      identity: claudeCutoverIdentity(storedProviderAccountId, credential),
    };
  } catch {
    // Neither codec, JSON nor token values may escape through diagnostics.
    throw new SubscriptionCutoverStageError(
      "Claude subscription cutover could not decode a legacy credential (credential_undecodable); see the runbook",
      "55000",
    );
  }
}

/**
 * Every Claude upstream model an organization can serve: its organization
 * and workspace Claude subscription models (not removed) and the default
 * models, so a family limit reaches each (design 5.3 "Claude track").
 */
async function loadClaudeCatalogs(
  tx: postgres.TransactionSql,
  accountIds: readonly string[],
): Promise<Map<string, string[]>> {
  const rows = await tx<{ account_id: string; upstream_model_id: string }[]>`
    SELECT account_id::text, upstream_model_id FROM organization_model_provider_custom_models
    WHERE account_id = ANY(${[...accountIds]}::uuid[]) AND provider_kind = 'claude_subscription'
      AND retired_at IS NULL
    UNION
    SELECT account_id::text, upstream_model_id FROM workspace_gateway_custom_models
    WHERE account_id = ANY(${[...accountIds]}::uuid[]) AND provider_kind = 'claude_subscription'
      AND retired_at IS NULL`;
  const catalogs = new Map<string, string[]>();
  for (const accountId of accountIds)
    catalogs.set(accountId, [...CLAUDE_DEFAULT_CONNECTION_MODEL_IDS]);
  for (const row of rows) catalogs.get(row.account_id)?.push(row.upstream_model_id);
  for (const [accountId, models] of catalogs) catalogs.set(accountId, [...new Set(models)].sort());
  return catalogs;
}

/**
 * Move every legacy Claude credential into the shared core. Runs inside the
 * migration transaction after the SQL prelude, and leaves
 * `pg_temp.subscription_cutover_connection_map`,
 * `pg_temp.subscription_cutover_dispositions` and
 * `pg_temp.subscription_cutover_readability` for the SQL backfill.
 */
export async function migrateClaudeSubscriptionCoreCredentials(
  tx: postgres.TransactionSql,
  encryptionKey: Uint8Array | undefined,
): Promise<void> {
  try {
    await moveClaudeCredentials(tx, encryptionKey);
  } catch (error) {
    throw contentFreeClaudeCutoverError(error);
  }
}

async function moveClaudeCredentials(
  tx: postgres.TransactionSql,
  encryptionKey: Uint8Array | undefined,
): Promise<void> {
  await createSubscriptionCutoverStageTables(tx);
  // The canonical connections whose current usage row could not be read
  // (the usage parity accounts for each; a disposition lists them).
  await tx`CREATE TEMP TABLE claude_cutover_usage_unreadable (connection_id uuid PRIMARY KEY)
    ON COMMIT DROP`;
  const rows = await tx<LegacyClaudeCredentialRow[]>`
    SELECT id::text, account_id::text, workspace_id::text, authority_scope, provider_account_id,
      label, account_email, plan_type, status, expires_at, last_refresh_at, last_error, version,
      allocator_enabled, allocator_version, exhausted_until, selection_count, last_selected_at,
      owner_organization_membership_id::text,
      organization_user_resource_authority_id::text,
      organization_user_resource_authority_generation, connected_by_subject_id, created_at,
      updated_at, allowed_model_ids, allowed_workspace_ids::text[] AS allowed_workspace_ids,
      allow_personal_workspaces
    FROM claude_subscription_credentials
    ORDER BY account_id, created_at, id`;
  if (rows.length === 0) return;
  if (encryptionKey?.length !== 32) {
    throw new SubscriptionCutoverStageError(
      "Claude subscription cutover requires the existing environments encryption key",
    );
  }
  const decoded = new Map<string, ReturnType<typeof decodeCredential>>();
  for (const row of rows) {
    const [stored] = await tx<{ credential_encrypted: string }[]>`
      SELECT credential_encrypted FROM claude_subscription_credentials WHERE id = ${row.id}::uuid`;
    decoded.set(
      row.id,
      decodeCredential(encryptionKey, stored!.credential_encrypted, row.provider_account_id),
    );
  }
  const usageRows = await tx<LegacyClaudeUsageRow[]>`
    SELECT credential_id::text, credential_version, snapshot, model_cooldowns, updated_at
    FROM claude_subscription_account_usage`;
  const usage = new Map(usageRows.map((row) => [row.credential_id, row]));
  const accountIds = [...new Set(rows.map((row) => row.account_id))];
  const catalogs = await loadClaudeCatalogs(tx, accountIds);

  const context = await loadSubscriptionCutoverPlanContext(tx, {
    accountIds,
    legacyResourceKind: LEGACY_RESOURCE_KIND,
  });
  const plan = planClaudeCutover({
    rows,
    identities: new Map([...decoded].map(([id, value]) => [id, value.identity])),
    ...context,
  });
  if (plan.conflicts.length > 0) throw subscriptionCutoverConflictError(ORDINAL, plan.conflicts);

  const personalOwners = [
    ...new Set(
      plan.connections
        .filter((connection) => connection.ownership === "personal")
        .map((connection) => connection.ownerMembershipId!),
    ),
  ].sort();
  const personalGenerations = await mintSubscriptionCutoverPersonalGenerations(tx, {
    legacyResourceKind: LEGACY_RESOURCE_KIND,
    ownerMembershipIds: personalOwners,
  });
  const now = new Date();
  const staged: SubscriptionCutoverStagedConnection<LegacyClaudeCredentialRow>[] = [];
  for (const connection of plan.connections) {
    const row = connection.canonical;
    // Both the connection version and the refresh generation start from the
    // legacy version (design 5.3 "Health and quota").
    const version = Math.max(1, Math.floor(Number(row.version) || 1));
    const quota = planClaudeCutoverQuota({
      canonical: row,
      members: connection.members,
      usage,
      upstreamModelIds: catalogs.get(connection.accountId) ?? [],
      refreshGeneration: version,
      now,
    });
    if (quota.usageUnreadable) {
      connection.dispositions.push("usage_snapshot_unreadable");
      await tx`INSERT INTO claude_cutover_usage_unreadable VALUES (${row.id}::uuid)`;
    }
    // Legacy held such an account back until a usage check passed; the core
    // keeps the flag as a quota fact and finds out on its next request.
    if (quota.reconnectPending) connection.dispositions.push("usage_reconnect_pending");
    const lastSelected = connection.members
      .map((member) => time(member.last_selected_at))
      .filter((value): value is number => value !== null)
      .sort((a, b) => b - a)[0];
    staged.push({
      connection,
      plaintext: decoded.get(row.id)!.plaintext,
      credentialFormat: decoded.get(row.id)!.format,
      version,
      refreshGeneration: version,
      allocatorVersion: Math.max(1, Math.floor(Number(row.allocator_version) || 1)),
      label: row.label ?? connection.members.find((member) => member.label)?.label ?? null,
      accountEmail:
        row.account_email ??
        connection.members.find((member) => member.account_email)?.account_email ??
        null,
      planType: row.plan_type,
      expiresAt: row.expires_at,
      lastRefreshAt: row.last_refresh_at,
      lastError: row.last_error,
      connectedBySubjectId: row.connected_by_subject_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      providerState: {},
      quota: quota.quota,
      observedRefreshGeneration: quota.observedRefreshGeneration,
      quotaUpdatedAt: quota.updatedAt,
      selectionCount: connection.members.reduce(
        (sum, member) => sum + Math.max(0, Number(member.selection_count) || 0),
        0,
      ),
      lastSelectedAt: lastSelected === undefined ? null : new Date(lastSelected),
      extraCredits: { enabled: false, version: 1, updatedBySubjectId: null, updatedAt: null },
    });
  }
  await writeSubscriptionCutoverConnections(tx, {
    binding: SUBSCRIPTION_CORE_CLAUDE as SubscriptionCoreProvider,
    encryptionKey,
    staged,
    personalGenerations,
    member: (row) => ({ id: row.id, scope: row.authority_scope, workspaceId: row.workspace_id }),
    now,
  });
}
