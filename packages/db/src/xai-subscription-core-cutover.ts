/**
 * The codec-aware stage of the SuperGrok drained cutover maintenance migration
 * (design docs/design/subscription-core-2026-10-07.md, 5.3 "Data mapping" and
 * "Cutover protocol"; the SuperGrok counterpart of 0689's Codex stage).
 *
 * A closed, migration-owned conversion. The SQL migration opens the
 * owner-only window and records the `xai` receipt and registry row; this
 * stage decodes every legacy SuperGrok credential, canonicalizes it to the
 * adapter's stored format (`{version:1, accessToken, refreshToken?}`,
 * `xai_oauth_v1`), plans the connections with the provider-neutral planner
 * and SuperGrok's rules, mints each owner's single cutover generation and
 * writes everything through the neutral stage writer. It also replaces every
 * non-terminal SuperGrok video envelope (a second copy of the credential) with
 * a reference to its canonical connection, the shape the core video path
 * reads (`{kind:"subscription-connection", provider, connectionId}`). The SQL that
 * follows moves settings, bindings, leases, waiters and accepted authority
 * from the tables this stage leaves behind. It is never a runtime path.
 *
 * SuperGrok-specific here: the legacy row shape, its token identity, its four
 * statuses, and the quota mapping. Secrets never leave this module: errors
 * carry fixed text, conflicts carry a content-free class and a count, and
 * nothing logs.
 */
import type postgres from "postgres";
import { decodeXaiJwtPayload, isXaiSubscriptionRateLimitDiagnostic } from "@opengeni/xai-subscription";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import {
  encodeSubscriptionCoreXaiCredential,
  SUBSCRIPTION_CORE_XAI_CREDENTIAL_FORMAT,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
} from "./subscription-core-xai-adapter";
import {
  planSubscriptionCoreCutover,
  type SubscriptionCutoverConnection,
  type SubscriptionCutoverDecodedIdentity,
  type SubscriptionCutoverPlan,
  type SubscriptionCutoverRules,
  type SubscriptionCutoverSource,
} from "./subscription-core/cutover-plan";
import {
  createSubscriptionCutoverStageTables,
  mintSubscriptionCutoverPersonalGenerations,
  writeSubscriptionCutoverConnections,
  type SubscriptionCutoverStagedConnection,
} from "./subscription-core/cutover-stage";

/** Splits the cutover migration into its owner-window prelude and its SQL backfill. */
export const XAI_SUBSCRIPTION_CORE_CUTOVER_MARKER = "-- opengeni:xai-subscription-core-cutover-v1";
export const XAI_SUBSCRIPTION_CORE_CUTOVER_MIGRATION = "0716_subscription_core_xai_cutover.sql";

/** As the legacy fleet read classifies a window. */
const NEAR_EXHAUSTION_PERCENT = 90;
/** The reference an in-flight video keeps when its funding credential cannot be resolved. */
const UNMAPPED_VIDEO_CONNECTION = "00000000-0000-0000-0000-000000000000";
/** The legacy SuperGrok resource kind of a `user` credential's personal authority. */
const LEGACY_RESOURCE_KIND = "xai_subscription";

export type LegacyXaiCredentialRow = {
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
  quota_used_percent: number | null;
  quota_reset_at: Date | null;
  quota_checked_at: Date | null;
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

/** The legacy SuperGrok statuses, healthiest first (design 5.3 "Identity and dedupe"). */
type XaiCutoverStatus = "active" | "error" | "needs_relogin" | "disabled";
const STATUS_RANK: Readonly<Record<XaiCutoverStatus, number>> = {
  active: 0,
  error: 1,
  needs_relogin: 2,
  disabled: 3,
};

function xaiCutoverSource(row: LegacyXaiCredentialRow): SubscriptionCutoverSource {
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

/**
 * SuperGrok's rules on the provider-neutral cutover planner: the legacy row
 * shape and its four statuses. The upstream account and the person are both
 * the token identity subject, so rows of one login merge per owner; no
 * SuperGrok fact refuses a merge.
 */
export const XAI_CUTOVER_RULES: SubscriptionCutoverRules<LegacyXaiCredentialRow, XaiCutoverStatus> =
  Object.freeze({ statusRank: STATUS_RANK, source: xaiCutoverSource });

export type XaiCutoverPlan = SubscriptionCutoverPlan<LegacyXaiCredentialRow, XaiCutoverStatus>;
export type XaiCutoverConnection = SubscriptionCutoverConnection<
  LegacyXaiCredentialRow,
  XaiCutoverStatus
>;

function time(value: Date | null | undefined): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/** A legacy `last_error` that records a rate-limit refusal (the provider's own diagnostic). */
export function xaiCutoverRateLimited(lastError: string | null): boolean {
  if (!lastError) return false;
  return (
    isXaiSubscriptionRateLimitDiagnostic({ message: lastError }) ||
    /\b(?:429|rate[ _-]?limit(?:ed|_exceeded)?|too[ _-]many[ _-]requests|resource_exhausted|capacity_exceeded|server_overloaded|overloaded_error)\b/i.test(
      lastError,
    )
  );
}

/**
 * The shared quota model for the canonical row: the legacy usage read is one
 * window and `exhaustedUntil`, whose kind is `rate_limit` when the legacy
 * `last_error` records a rate-limit refusal and `quota` otherwise. Unknown
 * stays unknown: without a usage read or a stored exhaustion the observed
 * refresh generation stays NULL.
 */
export function planXaiCutoverQuota(
  row: LegacyXaiCredentialRow,
  refreshGeneration: number,
  now: Date,
): { quota: Record<string, unknown>; observedRefreshGeneration: number | null; updatedAt: Date } {
  const observed = time(row.quota_checked_at) !== null;
  const usedPercent = observed ? row.quota_used_percent : null;
  const status =
    !observed || usedPercent === null
      ? "unknown"
      : usedPercent >= 100
        ? "exhausted"
        : usedPercent >= NEAR_EXHAUSTION_PERCENT
          ? "warning"
          : "ok";
  const exhaustedUntil = time(row.exhausted_until);
  return {
    quota: {
      windows: [{ id: "primary", usedPercent, resetsAt: time(row.quota_reset_at), status }],
      modelCooldowns: {},
      exhaustedUntil,
      exhaustedKind:
        exhaustedUntil === null
          ? null
          : xaiCutoverRateLimited(row.last_error)
            ? "rate_limit"
            : "quota",
      source: "usage_endpoint",
    },
    observedRefreshGeneration: observed || exhaustedUntil !== null ? refreshGeneration : null,
    updatedAt: row.quota_checked_at ?? now,
  };
}

/** Plan every legacy SuperGrok credential with the neutral rules. Pure. */
export function planXaiCutover(input: {
  rows: readonly LegacyXaiCredentialRow[];
  identities: ReadonlyMap<string, SubscriptionCutoverDecodedIdentity>;
  workspaces: readonly { id: string; accountId: string; personal: boolean }[];
  memberships: readonly {
    id: string;
    accountId: string;
    subjectId: string;
    active: boolean;
    personalWorkspaceId: string | null;
  }[];
  legacyAuthorities: readonly {
    id: string;
    accountId: string;
    membershipId: string;
    resourceId: string;
    generation: number;
    active: boolean;
  }[];
}): XaiCutoverPlan {
  return planSubscriptionCoreCutover(XAI_CUTOVER_RULES, input);
}

/** A stage error whose text is fixed and content-free by construction. */
class XaiCutoverStageError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "XaiCutoverStageError";
    this.code = code;
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const OWN_REFUSAL = /^\d{4} [a-z][A-Za-z0-9 ,:()_-]{0,300}$/;

/**
 * Driver errors carry the statement's parameters (ciphertext, labels, emails)
 * and the server's detail text; neither may leave the stage. Only the
 * SQLSTATE and the violated constraint's name survive, plus the migration's
 * own fixed refusals.
 */
export function contentFreeXaiCutoverError(error: unknown): Error {
  if (error instanceof XaiCutoverStageError) return error;
  const source = (error ?? {}) as { code?: unknown; constraint_name?: unknown; message?: unknown };
  const code = typeof source.code === "string" && SQLSTATE.test(source.code) ? source.code : null;
  if (code === "55000" && typeof source.message === "string" && OWN_REFUSAL.test(source.message)) {
    return new XaiCutoverStageError(source.message, code);
  }
  const constraint =
    typeof source.constraint_name === "string" && IDENTIFIER.test(source.constraint_name)
      ? source.constraint_name
      : null;
  return new XaiCutoverStageError(
    `SuperGrok subscription cutover could not write the shared core (SQLSTATE ${code ?? "unknown"}${
      constraint ? `, ${constraint}` : ""
    }); see the runbook`,
    code ?? undefined,
  );
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Decrypt one legacy credential, canonicalize it to the adapter's stored
 * format and read its token identity: the access token's principal (the
 * subject the connect flow stored as `provider_account_id`), which is both
 * the upstream account and the person. A row without an access token is
 * undecodable and aborts the cutover.
 */
function decodeCredential(
  key: Uint8Array,
  encrypted: string,
): { plaintext: string; identity: SubscriptionCutoverDecodedIdentity } {
  try {
    const parsed = JSON.parse(decryptEnvironmentValue(key, encrypted)) as Record<
      string,
      unknown
    > | null;
    if (!parsed || typeof parsed !== "object" || !nonEmpty(parsed.accessToken)) {
      throw new Error("undecodable");
    }
    const accessToken = parsed.accessToken as string;
    const refreshToken = nonEmpty(parsed.refreshToken) ? (parsed.refreshToken as string) : null;
    const claims = decodeXaiJwtPayload(accessToken);
    const subject =
      nonEmpty(claims?.principal_id) ?? nonEmpty(claims?.principalId) ?? nonEmpty(claims?.sub);
    return {
      plaintext: encodeSubscriptionCoreXaiCredential({ accessToken, refreshToken }),
      identity: {
        tokenAccountId: subject,
        tokenUserId: subject,
        tokenEmail: nonEmpty(claims?.email),
      },
    };
  } catch {
    // Neither codec, JSON nor token values may escape through diagnostics.
    throw new XaiCutoverStageError(
      "SuperGrok subscription cutover could not decode a legacy credential (credential_undecodable); see the runbook",
      "55000",
    );
  }
}

/**
 * The legacy credential a SuperGrok video envelope was funded by, or null
 * when the envelope cannot be read (the operation then ends at its recovery
 * deadline, design 5.3 decision 6). Only the id leaves this function.
 */
function videoEnvelopeCredentialId(key: Uint8Array, encrypted: string): string | null {
  try {
    const parsed = JSON.parse(decryptEnvironmentValue(key, encrypted)) as Record<
      string,
      unknown
    > | null;
    const id = parsed?.kind === "xai-subscription" ? nonEmpty(parsed.credentialId) : null;
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? id.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/**
 * Move every legacy SuperGrok credential into the shared core. Runs inside
 * the migration transaction after the SQL prelude, and leaves
 * `pg_temp.subscription_cutover_connection_map`,
 * `pg_temp.subscription_cutover_dispositions`,
 * `pg_temp.subscription_cutover_readability` and
 * `pg_temp.subscription_cutover_video_credentials` for the SQL backfill.
 */
export async function migrateXaiSubscriptionCoreCredentials(
  tx: postgres.TransactionSql,
  encryptionKey: Uint8Array | undefined,
): Promise<void> {
  try {
    await moveXaiCredentials(tx, encryptionKey);
  } catch (error) {
    throw contentFreeXaiCutoverError(error);
  }
}

async function moveXaiCredentials(
  tx: postgres.TransactionSql,
  encryptionKey: Uint8Array | undefined,
): Promise<void> {
  await createSubscriptionCutoverStageTables(tx);
  await tx`CREATE TEMP TABLE subscription_cutover_video_credentials (
    operation_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    connection_id uuid,
    reference_encrypted text NOT NULL
  ) ON COMMIT DROP`;
  const rows = await tx<LegacyXaiCredentialRow[]>`
    SELECT id::text, account_id::text, workspace_id::text, authority_scope, provider_account_id,
      label, account_email, plan_type, status, expires_at, last_refresh_at, last_error, version,
      allocator_enabled, allocator_version, quota_used_percent, quota_reset_at, quota_checked_at,
      exhausted_until, selection_count, last_selected_at,
      owner_organization_membership_id::text,
      organization_user_resource_authority_id::text,
      organization_user_resource_authority_generation, connected_by_subject_id, created_at,
      updated_at, allowed_model_ids, allowed_workspace_ids::text[] AS allowed_workspace_ids,
      allow_personal_workspaces
    FROM xai_subscription_credentials
    ORDER BY account_id, created_at, id
  `;
  const operations = await tx<{ id: string; account_id: string }[]>`
    SELECT id::text, account_id::text FROM video_generation_operations
    WHERE funding_source = 'supergrok_subscription' AND terminal_at IS NULL
      AND credential_encrypted IS NOT NULL
    ORDER BY id`;
  if (rows.length === 0 && operations.length === 0) return;
  if (encryptionKey?.length !== 32) {
    throw new XaiCutoverStageError(
      "SuperGrok subscription cutover requires the existing environments encryption key",
    );
  }
  // Read every envelope's legacy credential id before any credential moves.
  const envelopes = new Map<string, string | null>();
  for (const operation of operations) {
    const [stored] = await tx<{ credential_encrypted: string }[]>`
      SELECT credential_encrypted FROM video_generation_operations WHERE id = ${operation.id}::uuid`;
    envelopes.set(operation.id, videoEnvelopeCredentialId(encryptionKey, stored!.credential_encrypted));
  }
  if (rows.length > 0) await moveXaiCredentialRows(tx, encryptionKey, rows);
  await stageVideoReferences(tx, encryptionKey, operations, envelopes);
}

/**
 * The connection reference each in-flight video operation keeps: its legacy
 * credential's canonical connection, or the nil id when the envelope or its
 * credential cannot be resolved (the core video path then finds no
 * connection and ends the operation at its recovery deadline, decision 6).
 */
async function stageVideoReferences(
  tx: postgres.TransactionSql,
  encryptionKey: Uint8Array,
  operations: readonly { id: string; account_id: string }[],
  envelopes: ReadonlyMap<string, string | null>,
): Promise<void> {
  for (const operation of operations) {
    const legacyId = envelopes.get(operation.id) ?? null;
    const [mapped] = legacyId
      ? await tx<{ connection_id: string }[]>`
          SELECT connection_id::text FROM pg_temp.subscription_cutover_connection_map
          WHERE account_id = ${operation.account_id}::uuid AND legacy_id = ${legacyId}::uuid`
      : [];
    const connectionId = mapped?.connection_id ?? null;
    const reference = encryptEnvironmentValue(
      encryptionKey,
      JSON.stringify({
        kind: "subscription-connection",
        provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
        connectionId: connectionId ?? UNMAPPED_VIDEO_CONNECTION,
      }),
    );
    // Read back before the SQL replaces the envelope.
    const parsed = JSON.parse(decryptEnvironmentValue(encryptionKey, reference)) as {
      connectionId?: unknown;
    };
    if (parsed.connectionId !== (connectionId ?? UNMAPPED_VIDEO_CONNECTION)) {
      throw new XaiCutoverStageError("0716 parity mismatch (video_reference_readability)", "55000");
    }
    await tx`INSERT INTO subscription_cutover_video_credentials (
        operation_id, account_id, connection_id, reference_encrypted
      ) VALUES (${operation.id}::uuid, ${operation.account_id}::uuid, ${connectionId}::uuid,
        ${reference})`;
  }
}

async function moveXaiCredentialRows(
  tx: postgres.TransactionSql,
  encryptionKey: Uint8Array,
  rows: readonly LegacyXaiCredentialRow[],
): Promise<void> {
  const decoded = new Map<string, ReturnType<typeof decodeCredential>>();
  for (const row of rows) {
    const [stored] = await tx<{ credential_encrypted: string }[]>`
      SELECT credential_encrypted FROM xai_subscription_credentials WHERE id = ${row.id}::uuid`;
    decoded.set(row.id, decodeCredential(encryptionKey, stored!.credential_encrypted));
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
      (status = 'active' AND revoked_at IS NULL) AS active, personal_workspace_id::text
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
    WHERE account_id = ANY(${accountIds}::uuid[]) AND resource_kind = ${LEGACY_RESOURCE_KIND}`;

  const plan = planXaiCutover({
    rows,
    identities: new Map([...decoded].map(([id, value]) => [id, value.identity])),
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
    throw new XaiCutoverStageError(
      `0716 refused ambiguous legacy state (${classes.join(", ")}) in ${organizations} organization(s); see the runbook`,
      "55000",
    );
  }

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
  const staged: SubscriptionCutoverStagedConnection<LegacyXaiCredentialRow>[] =
    plan.connections.map((connection) => {
      const row = connection.canonical;
      // Both the connection version and the refresh generation start from the
      // legacy version (design 5.3 "Health and quota").
      const version = Math.max(1, Math.floor(Number(row.version) || 1));
      const quota = planXaiCutoverQuota(row, version, now);
      const lastSelected = connection.members
        .map((member) => time(member.last_selected_at))
        .filter((value): value is number => value !== null)
        .sort((a, b) => b - a)[0];
      return {
        connection,
        plaintext: decoded.get(row.id)!.plaintext,
        credentialFormat: SUBSCRIPTION_CORE_XAI_CREDENTIAL_FORMAT,
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
      };
    });
  await writeSubscriptionCutoverConnections(tx, {
    provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
    encryptionKey,
    staged,
    personalGenerations,
    member: (row) => ({ id: row.id, scope: row.authority_scope, workspaceId: row.workspace_id }),
    now,
  });
}
