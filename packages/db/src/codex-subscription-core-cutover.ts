/**
 * The codec-aware stage of the M3 Codex cutover maintenance migration
 * (design docs/design/subscription-core-2026-10-07.md, 5.1.1 "Data move and
 * cutover protocol", steps 2 and 3).
 *
 * A closed, migration-owned conversion: the SQL migration opens the owner-only
 * row-security window, this stage moves every legacy Codex credential into
 * `subscription_connections` (decrypting and re-encrypting through the
 * environment codec, deduplicating one upstream identity per owner, recording
 * every merged legacy id as an alias and mapping scope, assignment policy,
 * health, quota and provider state), and the SQL that follows moves settings,
 * bindings, leases, waiters and accepted authority from the mapping table this
 * stage leaves behind. It is never a runtime path.
 *
 * The dedupe, scope, assignment-policy, delegated-manager, policy-union and
 * auto-assignment rules are the provider-neutral cutover planner
 * (`subscription-core/cutover-plan.ts`); this module keeps only what is
 * Codex's own: the legacy row shape and its decoding, the FedRAMP merge
 * refusal, and the quota and provider-state mapping.
 *
 * Secrets never leave this module: errors carry fixed text, conflicts carry a
 * content-free class and an organization id, and nothing logs.
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { codexPlanKey, parseIdToken } from "@opengeni/codex";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import {
  compareSubscriptionCutoverSources,
  planSubscriptionCoreCutover,
  type SubscriptionCutoverAutoAssignment,
  type SubscriptionCutoverConflict,
  type SubscriptionCutoverConflictClass,
  type SubscriptionCutoverConnection,
  type SubscriptionCutoverDecodedIdentity,
  type SubscriptionCutoverLegacyAuthority,
  type SubscriptionCutoverMembership,
  type SubscriptionCutoverPlan,
  type SubscriptionCutoverPolicy,
  type SubscriptionCutoverRules,
  type SubscriptionCutoverSource,
  type SubscriptionCutoverWorkspace,
} from "./subscription-core/cutover-plan";

/** Splits the 0689 migration into its owner-window prelude and its SQL backfill. */
export const CODEX_SUBSCRIPTION_CORE_CUTOVER_MARKER =
  "-- opengeni:codex-subscription-core-cutover-v1";
export const CODEX_SUBSCRIPTION_CORE_CUTOVER_MIGRATION = "0689_subscription_core_codex_cutover.sql";

/** As the legacy fleet read classifies a window. */
const NEAR_EXHAUSTION_PERCENT = 90;
/** Legacy 0524 parity: one proven plan refusal keeps a model away for a day. */
const PLAN_EXCLUSION_TTL_MS = 24 * 60 * 60 * 1000;

export type LegacyCodexCredentialRow = {
  id: string;
  account_id: string;
  workspace_id: string | null;
  authority_scope: string;
  chatgpt_account_id: string | null;
  scopes: string | null;
  plan_type: string | null;
  is_fedramp: boolean;
  expires_at: Date | null;
  last_refresh_at: Date | null;
  status: string;
  last_error: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  label: string | null;
  account_email: string | null;
  primary_used_percent: number | null;
  primary_reset_at: Date | null;
  secondary_used_percent: number | null;
  secondary_reset_at: Date | null;
  usage_checked_at: Date | null;
  exhausted_until: Date | null;
  exhausted_kind: string | null;
  allocator_enabled: boolean;
  extra_credits_enabled?: boolean;
  extra_credits_version?: number;
  extra_credits_updated_by_subject_id?: string | null;
  extra_credits_updated_at?: Date | null;
  selection_count: number;
  last_selected_at: Date | null;
  allocator_version: number;
  reset_credit_available_count: number | null;
  reset_credits_checked_at: Date | null;
  connected_by_subject_id: string | null;
  owner_organization_membership_id: string | null;
  organization_user_resource_authority_id: string | null;
  organization_user_resource_authority_generation: number | string | null;
  allowed_model_ids: string[] | null;
  allowed_workspace_ids: string[] | null;
  allow_personal_workspaces: boolean;
  plan_checked_at: Date | null;
  plan_previous_type: string | null;
  plan_changed_at: Date | null;
  plan_entitlement_exclusion: unknown;
};

export type CutoverWorkspace = SubscriptionCutoverWorkspace;
export type CutoverMembership = SubscriptionCutoverMembership;
export type CutoverLegacyAuthority = SubscriptionCutoverLegacyAuthority;

/**
 * What the stage learned from a decrypted credential, without the secret:
 * `tokenAccountId` is the ChatGPT account id the id_token names, when it
 * parses; `tokenUserId` is the signed-in person (ChatGPT user id, else the
 * OIDC subject; every member of a ChatGPT Team workspace shares the account
 * id, so only this tells two people's logins apart); `tokenEmail` is the
 * id_token's email claim, a secondary same-person check only.
 */
export type DecodedIdentity = SubscriptionCutoverDecodedIdentity;

/** Rows of one person whose FedRAMP flags disagree are refused, never merged. */
type CodexCutoverGroupConflict = "fedramp_mismatch";
/** The legacy Codex statuses the core represents. */
type CodexCutoverStatus = "active" | "needs_relogin" | "error";

export type CutoverConflictClass = SubscriptionCutoverConflictClass<CodexCutoverGroupConflict>;
export type CutoverConflict = SubscriptionCutoverConflict<CodexCutoverGroupConflict>;
export type PlannedPolicy = SubscriptionCutoverPolicy;
export type PlannedAutoAssignment = SubscriptionCutoverAutoAssignment;
export type PlannedConnection = SubscriptionCutoverConnection<
  LegacyCodexCredentialRow,
  CodexCutoverStatus
>;
export type CutoverPlan = SubscriptionCutoverPlan<
  LegacyCodexCredentialRow,
  CodexCutoverStatus,
  CodexCutoverGroupConflict
>;

/** Healthiest first: the canonical preference among one identity's rows. */
const STATUS_RANK: Readonly<Record<CodexCutoverStatus, number>> = {
  active: 0,
  error: 1,
  needs_relogin: 2,
};

/** The neutral facts of a legacy Codex row: the ChatGPT account id is the upstream id. */
function codexCutoverSource(row: LegacyCodexCredentialRow): SubscriptionCutoverSource {
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    authorityScope: row.authority_scope,
    status: row.status,
    providerAccountId: row.chatgpt_account_id,
    accountEmail: row.account_email,
    lastRefreshAt: row.last_refresh_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    allocatorEnabled: row.allocator_enabled,
    allowedModelIds: row.allowed_model_ids,
    allowedWorkspaceIds: row.allowed_workspace_ids,
    allowPersonalWorkspaces: row.allow_personal_workspaces,
    extraCreditsEnabled: row.extra_credits_enabled,
    ownerOrganizationMembershipId: row.owner_organization_membership_id,
    userAuthorityId: row.organization_user_resource_authority_id,
    userAuthorityGeneration: row.organization_user_resource_authority_generation,
  };
}

/**
 * Codex's rules on the provider-neutral cutover planner: the legacy Codex row
 * shape, its three representable statuses, and FedRAMP and commercial logins
 * of one person that never merge (`fedramp_mismatch` refuses the cutover).
 */
export const CODEX_CUTOVER_RULES: SubscriptionCutoverRules<
  LegacyCodexCredentialRow,
  CodexCutoverStatus,
  CodexCutoverGroupConflict
> = Object.freeze({
  statusRank: STATUS_RANK,
  source: codexCutoverSource,
  groupConflict: (rows: readonly LegacyCodexCredentialRow[]) =>
    new Set(rows.map((row) => row.is_fedramp)).size > 1 ? "fedramp_mismatch" : null,
});

/** Healthiest first, then the freshest token family, then deterministic order. */
export function compareCanonicalCandidates(
  a: LegacyCodexCredentialRow,
  b: LegacyCodexCredentialRow,
): number {
  return compareSubscriptionCutoverSources(
    STATUS_RANK,
    codexCutoverSource(a),
    codexCutoverSource(b),
  );
}

/**
 * Plan the canonical connections for every legacy Codex credential: the
 * provider-neutral cutover rules (`planSubscriptionCoreCutover`, which
 * documents dedupe, scope, assignment policies, the delegated manager, the
 * policy union and auto-assignment) with Codex's rules. Pure: the caller
 * supplies decrypted identity facts, never the secret itself.
 *
 * Codex identity: the stored ChatGPT account id, cross-checked against the
 * id_token's, and the person is the id_token's ChatGPT user id (every member
 * of a ChatGPT Team/Business/Enterprise workspace shares the account id).
 */
export function planCodexCutover(input: {
  rows: readonly LegacyCodexCredentialRow[];
  identities: ReadonlyMap<string, DecodedIdentity>;
  workspaces: readonly CutoverWorkspace[];
  memberships: readonly CutoverMembership[];
  legacyAuthorities: readonly CutoverLegacyAuthority[];
}): CutoverPlan {
  return planSubscriptionCoreCutover(CODEX_CUTOVER_RULES, input);
}

function time(value: Date | null | undefined): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

type QuotaWindow = {
  id: string;
  usedPercent: number | null;
  resetsAt: number | null;
  status: "ok" | "warning" | "exhausted" | "unknown";
};

function windowFor(
  id: string,
  usedPercent: number | null,
  resetsAt: Date | null,
  observed: boolean,
): QuotaWindow {
  const status: QuotaWindow["status"] =
    !observed || usedPercent === null
      ? "unknown"
      : usedPercent >= 100
        ? "exhausted"
        : usedPercent >= NEAR_EXHAUSTION_PERCENT
          ? "warning"
          : "ok";
  return { id, usedPercent: observed ? usedPercent : null, resetsAt: time(resetsAt), status };
}

/**
 * The shared quota model for the canonical row. Unknown stays unknown: without
 * a usage read, a stored exhaustion or a live plan cooldown the observed
 * refresh generation stays NULL, which the core reads as "no observation".
 */
export function planCodexCutoverQuota(
  connection: PlannedConnection,
  refreshGeneration: number,
  now: Date,
): { quota: Record<string, unknown>; observedRefreshGeneration: number | null; updatedAt: Date } {
  const row = connection.canonical;
  const observed = time(row.usage_checked_at) !== null;
  const modelCooldowns: Record<string, number> = {};
  const exclusion = row.plan_entitlement_exclusion as {
    planType?: unknown;
    models?: unknown;
  } | null;
  if (
    exclusion &&
    typeof exclusion === "object" &&
    typeof exclusion.planType === "string" &&
    codexPlanKey(exclusion.planType) === codexPlanKey(row.plan_type) &&
    Array.isArray(exclusion.models)
  ) {
    for (const entry of exclusion.models as Array<Record<string, unknown>>) {
      if (!entry || typeof entry.modelId !== "string" || typeof entry.excludedAt !== "string") {
        continue;
      }
      const at = new Date(entry.excludedAt).getTime();
      if (!Number.isFinite(at)) continue;
      const until = at + PLAN_EXCLUSION_TTL_MS;
      if (until <= now.getTime()) continue;
      modelCooldowns[entry.modelId] = Math.max(modelCooldowns[entry.modelId] ?? 0, until);
    }
  }
  const exhaustedUntil = time(row.exhausted_until);
  const exhaustedKind =
    exhaustedUntil !== null &&
    (row.exhausted_kind === "quota" || row.exhausted_kind === "rate_limit")
      ? row.exhausted_kind
      : null;
  const hasObservation =
    observed || exhaustedUntil !== null || Object.keys(modelCooldowns).length > 0;
  return {
    quota: {
      windows: [
        windowFor("primary", row.primary_used_percent, row.primary_reset_at, observed),
        windowFor("secondary", row.secondary_used_percent, row.secondary_reset_at, observed),
      ],
      modelCooldowns,
      exhaustedUntil,
      exhaustedKind,
      source: "usage_endpoint",
    },
    observedRefreshGeneration: hasObservation ? refreshGeneration : null,
    updatedAt: row.usage_checked_at ?? now,
  };
}

/** Adapter-owned state (design 3.1): never read by core decisions. */
export function planCodexCutoverProviderState(
  connection: PlannedConnection,
): Record<string, unknown> {
  const row = connection.canonical;
  const iso = (value: Date | null) => (value ? new Date(value).toISOString() : undefined);
  const state: Record<string, unknown> = {};
  if (row.is_fedramp) state.isFedramp = true;
  if (row.reset_credit_available_count !== null) {
    state.resetCreditAvailableCount = row.reset_credit_available_count;
  }
  if (row.reset_credits_checked_at) state.resetCreditsCheckedAt = iso(row.reset_credits_checked_at);
  if (row.plan_checked_at) state.planCheckedAt = iso(row.plan_checked_at);
  if (row.plan_previous_type) state.planPreviousType = row.plan_previous_type;
  if (row.plan_changed_at) state.planChangedAt = iso(row.plan_changed_at);
  if (row.scopes) state.scopes = row.scopes;
  return state;
}

class CodexCutoverCredentialError extends Error {}

/** A stage error whose text is fixed and content-free by construction. */
class CodexCutoverStageError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "CodexCutoverStageError";
    this.code = code;
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const OWN_REFUSAL = /^\d{4} [a-z][A-Za-z0-9 ,()_-]{0,200}$/;

/**
 * Driver errors carry the statement's parameters (ciphertext, labels, emails)
 * and the server's detail text; neither may leave the stage. Only the
 * SQLSTATE and the violated constraint's schema name survive.
 */
export function contentFreeCodexCutoverError(error: unknown): Error {
  if (error instanceof CodexCutoverStageError) return error;
  const source = (error ?? {}) as { code?: unknown; constraint_name?: unknown; message?: unknown };
  const code = typeof source.code === "string" && SQLSTATE.test(source.code) ? source.code : null;
  // The migration's own fixed refusals ("0689 parity mismatch (live_leases)")
  // carry no data; keep their text, never the driver's attachments.
  if (code === "55000" && typeof source.message === "string" && OWN_REFUSAL.test(source.message)) {
    return new CodexCutoverStageError(source.message, code);
  }
  const constraint =
    typeof source.constraint_name === "string" && IDENTIFIER.test(source.constraint_name)
      ? source.constraint_name
      : null;
  return new CodexCutoverStageError(
    `Codex subscription cutover could not write the shared core (SQLSTATE ${code ?? "unknown"}${
      constraint ? `, ${constraint}` : ""
    }); see the runbook`,
    code ?? undefined,
  );
}

function decodeCredential(
  key: Uint8Array,
  encrypted: string,
): {
  plaintext: string;
  tokenAccountId: string | null;
  tokenUserId: string | null;
  tokenEmail: string | null;
} {
  try {
    const plaintext = decryptEnvironmentValue(key, encrypted);
    const parsed = JSON.parse(plaintext) as Record<string, unknown> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.access_token !== "string" ||
      typeof parsed.refresh_token !== "string" ||
      typeof parsed.id_token !== "string"
    ) {
      throw new CodexCutoverCredentialError();
    }
    let tokenAccountId: string | null = null;
    let tokenUserId: string | null = null;
    let tokenEmail: string | null = null;
    try {
      const claims = parseIdToken(parsed.id_token);
      tokenAccountId = claims.chatgptAccountId;
      tokenUserId = claims.chatgptUserId;
      tokenEmail = claims.email;
    } catch {
      tokenAccountId = null;
    }
    // Canonicalize the stored object to exactly the three token fields.
    return {
      plaintext: JSON.stringify({
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        id_token: parsed.id_token,
      }),
      tokenAccountId,
      tokenUserId,
      tokenEmail,
    };
  } catch {
    // Neither codec, JSON nor token values may escape through diagnostics.
    throw new CodexCutoverStageError(
      "Codex subscription cutover could not decode a legacy credential",
    );
  }
}

/** A content-free digest for the parity report; never the secret. */
function readabilityDigest(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Move every legacy Codex credential into the shared core. Runs inside the
 * migration transaction, after the SQL prelude has opened the owner-only
 * window, and leaves `pg_temp.codex_cutover_connection_map` (every legacy id to
 * its canonical connection) for the SQL backfill that follows.
 */
export async function migrateCodexSubscriptionCoreCredentials(
  tx: postgres.TransactionSql,
  encryptionKey: Uint8Array | undefined,
): Promise<void> {
  try {
    await moveCodexCredentials(tx, encryptionKey);
  } catch (error) {
    throw contentFreeCodexCutoverError(error);
  }
}

async function moveCodexCredentials(
  tx: postgres.TransactionSql,
  encryptionKey: Uint8Array | undefined,
): Promise<void> {
  const rows = await tx<LegacyCodexCredentialRow[]>`
    SELECT id::text, account_id::text, workspace_id::text, authority_scope, chatgpt_account_id,
      scopes, plan_type, is_fedramp, expires_at, last_refresh_at, status, last_error, version,
      created_at, updated_at, label, account_email, primary_used_percent, primary_reset_at,
      secondary_used_percent, secondary_reset_at, usage_checked_at, exhausted_until,
      exhausted_kind, allocator_enabled, selection_count, last_selected_at, allocator_version,
      reset_credit_available_count, reset_credits_checked_at, connected_by_subject_id,
      owner_organization_membership_id::text, organization_user_resource_authority_id::text,
      organization_user_resource_authority_generation,
      allowed_model_ids, allowed_workspace_ids::text[] AS allowed_workspace_ids,
      allow_personal_workspaces, plan_checked_at, plan_previous_type, plan_changed_at,
      plan_entitlement_exclusion, extra_credits_enabled, extra_credits_version,
      extra_credits_updated_by_subject_id, extra_credits_updated_at
    FROM codex_subscription_credentials
    ORDER BY account_id, created_at, id
  `;
  await tx`CREATE TEMP TABLE codex_cutover_connection_map (
    legacy_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    ownership text NOT NULL,
    owner_membership_id uuid,
    authority_generation bigint,
    authority_active boolean NOT NULL,
    user_generation_carried boolean NOT NULL,
    legacy_scope text NOT NULL,
    legacy_workspace_id uuid
  ) ON COMMIT DROP`;
  await tx`CREATE TEMP TABLE codex_cutover_dispositions (
    account_id uuid NOT NULL,
    disposition text NOT NULL,
    count bigint NOT NULL
  ) ON COMMIT DROP`;
  await tx`CREATE TEMP TABLE codex_cutover_readability (
    connection_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    source_digest text NOT NULL,
    target_digest text NOT NULL
  ) ON COMMIT DROP`;
  if (rows.length === 0) return;
  if (encryptionKey?.length !== 32) {
    throw new CodexCutoverStageError(
      "Codex subscription cutover requires the existing environments encryption key",
    );
  }

  const decoded = new Map<string, ReturnType<typeof decodeCredential>>();
  for (const row of rows) {
    const encrypted = await tx<{ credential_encrypted: string }[]>`
      SELECT credential_encrypted FROM codex_subscription_credentials WHERE id = ${row.id}::uuid`;
    decoded.set(row.id, decodeCredential(encryptionKey, encrypted[0]!.credential_encrypted));
  }

  const accountIds = [...new Set(rows.map((row) => row.account_id))];
  const workspaces = await tx<{ id: string; account_id: string; personal: boolean }[]>`
    SELECT workspace.id::text, workspace.account_id::text,
      EXISTS (SELECT 1 FROM organization_memberships membership
        WHERE membership.account_id = workspace.account_id
          AND membership.personal_workspace_id = workspace.id) AS personal
    FROM workspaces workspace WHERE workspace.account_id = ANY(${accountIds}::uuid[])`;
  const memberships = await tx<
    {
      id: string;
      account_id: string;
      subject_id: string;
      active: boolean;
      personal_workspace_id: string | null;
    }[]
  >`
    SELECT id::text, account_id::text, subject_id,
      (status = 'active' AND revoked_at IS NULL) AS active,
      personal_workspace_id::text
    FROM organization_memberships WHERE account_id = ANY(${accountIds}::uuid[])`;
  const authorities = await tx<
    {
      id: string;
      account_id: string;
      organization_membership_id: string;
      resource_id: string;
      generation: number | string;
      active: boolean;
    }[]
  >`
    SELECT id::text, account_id::text, organization_membership_id::text, resource_id::text,
      generation, (status = 'active' AND revoked_at IS NULL) AS active
    FROM organization_user_resource_authorities
    WHERE account_id = ANY(${accountIds}::uuid[]) AND resource_kind = 'codex_subscription'`;

  const plan = planCodexCutover({
    rows,
    identities: new Map(
      [...decoded].map(([id, value]) => [
        id,
        {
          tokenAccountId: value.tokenAccountId,
          tokenUserId: value.tokenUserId,
          tokenEmail: value.tokenEmail,
        },
      ]),
    ),
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      accountId: workspace.account_id,
      personal: workspace.personal,
    })),
    memberships: memberships.map((membership) => ({
      id: membership.id,
      accountId: membership.account_id,
      subjectId: membership.subject_id,
      active: membership.active,
      personalWorkspaceId: membership.personal_workspace_id,
    })),
    legacyAuthorities: authorities.map((authority) => ({
      id: authority.id,
      accountId: authority.account_id,
      membershipId: authority.organization_membership_id,
      resourceId: authority.resource_id,
      generation: Number(authority.generation),
      active: authority.active,
    })),
  });
  if (plan.conflicts.length > 0) {
    const classes = [...new Set(plan.conflicts.map((entry) => entry.conflictClass))].sort();
    const organizations = new Set(plan.conflicts.map((entry) => entry.accountId)).size;
    throw new CodexCutoverStageError(
      `Codex subscription cutover refused ambiguous legacy state (${classes.join(", ")}) in ${organizations} organization(s); see the runbook`,
      "55000",
    );
  }

  const now = new Date();
  const dispositions = new Map<string, number>();
  for (const connection of plan.connections) {
    for (const disposition of connection.dispositions) {
      const key = `${connection.accountId}\u0000${disposition}`;
      dispositions.set(key, (dispositions.get(key) ?? 0) + 1);
    }
    const source = decoded.get(connection.canonical.id)!;
    const credentialEncrypted = encryptEnvironmentValue(encryptionKey, source.plaintext);
    const refreshGeneration = Math.max(1, Math.floor(Number(connection.canonical.version) || 1));
    let authorityId: string | null = null;
    if (connection.ownership === "personal") {
      const [authority] = await tx<{ id: string }[]>`
        INSERT INTO organization_user_resource_authorities (
          account_id, organization_membership_id, resource_kind, resource_id,
          origin_workspace_id, generation, status, revoked_at
        ) VALUES (
          ${connection.accountId}::uuid, ${connection.ownerMembershipId}::uuid,
          'subscription_connection', ${connection.id}::uuid, ${connection.originWorkspaceId}::uuid,
          ${connection.authorityGeneration}, ${connection.authorityActive ? "active" : "revoked"},
          ${connection.authorityActive ? null : now}
        ) RETURNING id::text`;
      authorityId = authority!.id;
    }
    const label =
      connection.canonical.label ?? connection.members.find((row) => row.label)?.label ?? null;
    const email =
      connection.canonical.account_email ??
      connection.members.find((row) => row.account_email)?.account_email ??
      null;
    await tx`
      INSERT INTO subscription_connections (
        id, account_id, provider, kind, provider_account_id, account_email, label, plan_type,
        credential_encrypted, credential_format, expires_at, last_refresh_at, refresh_generation,
        version, status, last_error, allocator_enabled, allocator_version, excluded_models,
        allowed_model_ids, ownership, owner_organization_membership_id, owner_subject_id,
        authority_id, authority_resource_kind, authority_generation, connected_by_subject_id,
        scope_kind, allow_personal_workspaces, managed_by_workspace_id, provider_state,
        provider_subject_id, created_at, updated_at, extra_credits_enabled,
        extra_credits_version, extra_credits_updated_by_subject_id, extra_credits_updated_at
      ) VALUES (
        ${connection.id}::uuid, ${connection.accountId}::uuid, 'codex', 'subscription',
        ${connection.identity}, ${email}, ${label}, ${connection.canonical.plan_type},
        ${credentialEncrypted}, 'v1', ${connection.canonical.expires_at},
        ${connection.canonical.last_refresh_at}, ${refreshGeneration}, 1, ${connection.status},
        ${connection.canonical.last_error}, ${connection.allocatorEnabled},
        ${Math.max(1, Number(connection.canonical.allocator_version) || 1)}, '{}'::text[],
        ${connection.allowedModelIds}::text[], ${connection.ownership},
        ${connection.ownerMembershipId}::uuid, ${connection.ownerSubjectId}, ${authorityId}::uuid,
        ${connection.ownership === "personal" ? "subscription_connection" : null},
        ${connection.authorityGeneration}, ${connection.canonical.connected_by_subject_id},
        ${connection.scopeKind}, ${connection.allowPersonalWorkspaces},
        ${connection.managedByWorkspaceId}::uuid,
        ${tx.json(planCodexCutoverProviderState(connection) as postgres.JSONValue)},
        ${connection.providerSubjectId},
        ${connection.canonical.created_at}, ${connection.canonical.updated_at},
        ${connection.members.every((row) => row.extra_credits_enabled === true)},
        ${Math.max(1, ...connection.members.map((row) => row.extra_credits_version ?? 1))},
        ${connection.canonical.extra_credits_updated_by_subject_id ?? null},
        ${connection.canonical.extra_credits_updated_at ?? null}
      )`;
    if (connection.autoAssignment) {
      await tx`INSERT INTO opengeni_private.subscription_codex_auto_assignments AS auto (
          account_id, connection_id, shared_workspaces, personal_workspaces,
          allocator_enabled, allowed_model_ids
        ) VALUES (
          ${connection.accountId}::uuid, ${connection.id}::uuid,
          ${connection.autoAssignment.sharedWorkspaces},
          ${connection.autoAssignment.personalWorkspaces},
          ${connection.autoAssignment.allocatorEnabled},
          ${connection.autoAssignment.allowedModelIds}::text[]
        )`;
    }
    for (const workspaceId of connection.workspaceIds) {
      await tx`INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
        VALUES (${connection.accountId}::uuid, ${connection.id}::uuid, ${workspaceId}::uuid)`;
    }
    for (const policy of connection.policies) {
      await tx`INSERT INTO subscription_connection_assignment_policies (
          account_id, connection_id, workspace_id, inference_pool, allocator_enabled,
          allowed_model_ids, excluded_models, managed_by_workspace_id, updated_at
        ) VALUES (
          ${connection.accountId}::uuid, ${connection.id}::uuid, ${policy.workspaceId}::uuid,
          ${policy.pool}, ${policy.allocatorEnabled}, ${policy.allowedModelIds}::text[],
          '{}'::text[], ${policy.managedByWorkspaceId}::uuid, ${now}
        )`;
    }
    const quota = planCodexCutoverQuota(connection, refreshGeneration, now);
    const selectionCount = connection.members.reduce(
      (sum, row) => sum + Math.max(0, Number(row.selection_count) || 0),
      0,
    );
    const lastSelected = connection.members
      .map((row) => time(row.last_selected_at))
      .filter((value): value is number => value !== null)
      .sort((a, b) => b - a)[0];
    await tx`INSERT INTO subscription_connection_quota (
        account_id, connection_id, quota, selection_count, last_selected_at,
        observed_refresh_generation, revision, updated_at
      ) VALUES (
        ${connection.accountId}::uuid, ${connection.id}::uuid,
        ${tx.json(quota.quota as postgres.JSONValue)}, ${selectionCount},
        ${lastSelected === undefined ? null : new Date(lastSelected)},
        ${quota.observedRefreshGeneration}, 1, ${quota.updatedAt}
      )`;
    for (const member of connection.members) {
      await tx`INSERT INTO codex_cutover_connection_map (
          legacy_id, account_id, connection_id, ownership, owner_membership_id,
          authority_generation, authority_active, user_generation_carried, legacy_scope,
          legacy_workspace_id
        ) VALUES (
          ${member.id}::uuid, ${connection.accountId}::uuid, ${connection.id}::uuid,
          ${connection.ownership}, ${connection.ownerMembershipId}::uuid,
          ${connection.authorityGeneration}, ${connection.authorityActive},
          ${connection.userGenerationCarried}, ${member.authority_scope},
          ${member.workspace_id}::uuid
        )`;
      if (member.id !== connection.id) {
        await tx`INSERT INTO subscription_connection_aliases (
            account_id, provider, alias_connection_id, connection_id
          ) VALUES (${connection.accountId}::uuid, 'codex', ${member.id}::uuid, ${connection.id}::uuid)`;
      }
    }
    // Readability parity: the stored target decrypts to the source secret.
    const [stored] = await tx<{ credential_encrypted: string }[]>`
      SELECT credential_encrypted FROM subscription_connections WHERE id = ${connection.id}::uuid`;
    let targetDigest = "unreadable";
    try {
      targetDigest = readabilityDigest(
        decryptEnvironmentValue(encryptionKey, stored!.credential_encrypted),
      );
    } catch {
      targetDigest = "unreadable";
    }
    await tx`INSERT INTO codex_cutover_readability (connection_id, account_id, source_digest, target_digest)
      VALUES (${connection.id}::uuid, ${connection.accountId}::uuid,
        ${readabilityDigest(source.plaintext)}, ${targetDigest})`;
  }
  for (const [key, count] of dispositions) {
    const [accountId, disposition] = key.split("\u0000");
    await tx`INSERT INTO codex_cutover_dispositions (account_id, disposition, count)
      VALUES (${accountId!}::uuid, ${disposition!}, ${count})`;
  }
}
