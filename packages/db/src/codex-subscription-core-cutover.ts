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
 * Secrets never leave this module: errors carry fixed text, conflicts carry a
 * content-free class and an organization id, and nothing logs.
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { codexPlanKey, parseIdToken } from "@opengeni/codex";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";

/** Splits the 0683 migration into its owner-window prelude and its SQL backfill. */
export const CODEX_SUBSCRIPTION_CORE_CUTOVER_MARKER =
  "-- opengeni:codex-subscription-core-cutover-v1";
export const CODEX_SUBSCRIPTION_CORE_CUTOVER_MIGRATION = "0683_subscription_core_codex_cutover.sql";

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

export type CutoverWorkspace = { id: string; accountId: string; personal: boolean };
export type CutoverMembership = {
  id: string;
  accountId: string;
  subjectId: string;
  active: boolean;
  personalWorkspaceId: string | null;
};
export type CutoverLegacyAuthority = {
  id: string;
  accountId: string;
  membershipId: string;
  resourceId: string;
  generation: number;
  active: boolean;
};

/** What the stage learned from a decrypted credential, without the secret. */
export type DecodedIdentity = {
  /** The ChatGPT account id the id_token names, when it parses. */
  tokenAccountId: string | null;
  /**
   * The signed-in person the id_token names (ChatGPT user id, else the OIDC
   * subject). Every member of a ChatGPT Team workspace shares the account id,
   * so only this tells two people's logins apart.
   */
  tokenUserId?: string | null;
  /** The id_token's email claim, a secondary same-person check only. */
  tokenEmail?: string | null;
};

export type CutoverConflictClass =
  | "provider_identity_mismatch"
  | "personal_workspace_owner_ambiguous"
  | "personal_owner_missing"
  | "fedramp_mismatch"
  | "unrepresentable_status"
  | "unrepresentable_scope";

export type CutoverConflict = { accountId: string; conflictClass: CutoverConflictClass };

export type PlannedPolicy = {
  workspaceId: string;
  pool: "workspace" | "organization";
  allocatorEnabled: boolean;
  allowedModelIds: string[] | null;
  managedByWorkspaceId: string | null;
};

/**
 * How a shared connection keeps the legacy organization source's reach over
 * workspaces created after the cutover, when `organization` scope cannot
 * express it: every new shared workspace (`sharedWorkspaces`, a NULL legacy
 * allowlist) and/or every new Personal workspace (`personalWorkspaces`) is
 * assigned with the organization source's own policy.
 */
export type PlannedAutoAssignment = {
  sharedWorkspaces: boolean;
  personalWorkspaces: boolean;
  allocatorEnabled: boolean;
  allowedModelIds: string[] | null;
};

export type PlannedConnection = {
  id: string;
  accountId: string;
  identity: string | null;
  /** The upstream person (`provider_subject_id`); see planCodexCutover. */
  providerSubjectId: string | null;
  canonical: LegacyCodexCredentialRow;
  members: LegacyCodexCredentialRow[];
  status: "active" | "needs_relogin" | "error";
  ownership: "shared" | "personal";
  ownerMembershipId: string | null;
  ownerSubjectId: string | null;
  authorityGeneration: number | null;
  authorityActive: boolean;
  /**
   * The canonical row is a verified legacy user-scope personal authority whose
   * generation transferred, so a live turn's legacy `user` snapshot of that
   * generation still names this connection. Otherwise no user snapshot does.
   */
  userGenerationCarried: boolean;
  originWorkspaceId: string | null;
  scopeKind: "organization" | "workspaces" | "people";
  allowPersonalWorkspaces: boolean;
  managedByWorkspaceId: string | null;
  allocatorEnabled: boolean;
  allowedModelIds: string[] | null;
  workspaceIds: string[];
  policies: PlannedPolicy[];
  autoAssignment: PlannedAutoAssignment | null;
  /** Content-free dispositions that are not parity failures. */
  dispositions: string[];
};

export type CutoverPlan = {
  connections: PlannedConnection[];
  conflicts: CutoverConflict[];
};

const STATUS_RANK: Record<string, number> = { active: 0, error: 1, needs_relogin: 2 };

function time(value: Date | null | undefined): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/** Healthiest first, then the freshest token family, then deterministic order. */
export function compareCanonicalCandidates(
  a: LegacyCodexCredentialRow,
  b: LegacyCodexCredentialRow,
): number {
  const rank = (row: LegacyCodexCredentialRow) => STATUS_RANK[row.status] ?? 9;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const refreshA = time(a.last_refresh_at);
  const refreshB = time(b.last_refresh_at);
  if (refreshA !== refreshB) {
    if (refreshA === null) return 1;
    if (refreshB === null) return -1;
    return refreshB - refreshA;
  }
  const updatedA = time(a.updated_at) ?? 0;
  const updatedB = time(b.updated_at) ?? 0;
  if (updatedA !== updatedB) return updatedB - updatedA;
  const createdA = time(a.created_at) ?? 0;
  const createdB = time(b.created_at) ?? 0;
  if (createdA !== createdB) return createdA - createdB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sameModels(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unionModels(values: Array<string[] | null>): string[] | null {
  if (values.some((value) => value === null)) return null;
  return [...new Set(values.flatMap((value) => value ?? []))].sort();
}

/**
 * Plan the canonical connections for every legacy Codex credential. Pure: the
 * caller supplies decrypted identity facts, never the secret itself.
 *
 * Identity: organization, upstream account (the stored ChatGPT account id,
 * cross-checked against the id_token), the signed-in person (the id_token's
 * ChatGPT user id) and owner (the personal owner membership, or shared). Every
 * member of a ChatGPT Team/Business/Enterprise workspace shares the account
 * id, so rows merge only when they are provably the same person: a row whose
 * person is unknown, or whose stored and token emails disagree with another
 * row of the same person, stays its own connection (a content-free
 * disposition, not an abort). Distinct people stay distinct connections, each
 * with its own credential, assignments, designations and pins. Within a group
 * the healthiest row is canonical and keeps its id; the others become aliases.
 *
 * Scope (design 5.2): a shared connection is `organization` scope only when its
 * organization source has no allowlist, admits Personal workspaces, and carries
 * the widest allocator/model policy of the group, so that every current and
 * future workspace sees exactly the organization row's policy. Otherwise every
 * workspace the legacy rows admit today is enumerated (`workspaces` scope) with
 * each source row's exact per-workspace assignment policy, and the organization
 * source's reach over workspaces created later (every shared workspace when it
 * had no allowlist, every Personal workspace when it admitted them) is kept as
 * an auto-assignment with that source's own policy. The core connection-level
 * policy intersects the per-assignment policy, so the connection-level value
 * is the union.
 */
export function planCodexCutover(input: {
  rows: readonly LegacyCodexCredentialRow[];
  identities: ReadonlyMap<string, DecodedIdentity>;
  workspaces: readonly CutoverWorkspace[];
  memberships: readonly CutoverMembership[];
  legacyAuthorities: readonly CutoverLegacyAuthority[];
}): CutoverPlan {
  const conflicts: CutoverConflict[] = [];
  const conflict = (accountId: string, conflictClass: CutoverConflictClass) =>
    conflicts.push({ accountId, conflictClass });
  const workspacesByAccount = new Map<string, CutoverWorkspace[]>();
  for (const workspace of input.workspaces) {
    const list = workspacesByAccount.get(workspace.accountId) ?? [];
    list.push(workspace);
    workspacesByAccount.set(workspace.accountId, list);
  }
  for (const list of workspacesByAccount.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));
  const workspaceById = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const membershipById = new Map(
    input.memberships.map((membership) => [membership.id, membership]),
  );
  const personalOwners = new Map<string, CutoverMembership[]>();
  for (const membership of input.memberships) {
    if (!membership.personalWorkspaceId) continue;
    const list = personalOwners.get(membership.personalWorkspaceId) ?? [];
    list.push(membership);
    personalOwners.set(membership.personalWorkspaceId, list);
  }
  const authorityById = new Map(
    input.legacyAuthorities.map((authority) => [authority.id, authority]),
  );

  type Classified = {
    row: LegacyCodexCredentialRow;
    identity: string | null;
    person: string | null;
    email: string | null;
    ownerMembershipId: string | null;
    /** Workspaces this source row admits today, and its pool there. */
    covers: string[];
    pool: "workspace" | "organization" | null;
  };
  const classified: Classified[] = [];
  for (const row of input.rows) {
    if (!(row.status in STATUS_RANK)) {
      conflict(row.account_id, "unrepresentable_status");
      continue;
    }
    const decoded = input.identities.get(row.id);
    const tokenAccountId = decoded?.tokenAccountId ?? null;
    if (row.chatgpt_account_id && tokenAccountId && row.chatgpt_account_id !== tokenAccountId) {
      conflict(row.account_id, "provider_identity_mismatch");
      continue;
    }
    const identity = row.chatgpt_account_id ?? tokenAccountId;
    const person = decoded?.tokenUserId?.trim() || null;
    const email = (row.account_email ?? decoded?.tokenEmail ?? null)?.trim().toLowerCase() || null;
    const base = { row, identity, person, email };
    const workspaces = workspacesByAccount.get(row.account_id) ?? [];
    if (row.authority_scope === "organization") {
      const allowed = row.allowed_workspace_ids;
      const covers = workspaces
        .filter((workspace) =>
          workspace.personal
            ? row.allow_personal_workspaces
            : allowed === null || allowed.includes(workspace.id),
        )
        .map((workspace) => workspace.id);
      classified.push({ ...base, ownerMembershipId: null, covers, pool: "organization" });
      continue;
    }
    if (row.authority_scope === "user") {
      const owner = row.owner_organization_membership_id
        ? membershipById.get(row.owner_organization_membership_id)
        : undefined;
      if (!owner || owner.accountId !== row.account_id) {
        conflict(row.account_id, "personal_owner_missing");
        continue;
      }
      classified.push({ ...base, ownerMembershipId: owner.id, covers: [], pool: null });
      continue;
    }
    if (row.authority_scope !== "workspace" || !row.workspace_id) {
      conflict(row.account_id, "unrepresentable_scope");
      continue;
    }
    const workspace = workspaceById.get(row.workspace_id);
    if (!workspace || workspace.accountId !== row.account_id) {
      conflict(row.account_id, "unrepresentable_scope");
      continue;
    }
    if (workspace.personal) {
      const owners = personalOwners.get(workspace.id) ?? [];
      if (owners.length !== 1 || owners[0]!.accountId !== row.account_id) {
        conflict(row.account_id, "personal_workspace_owner_ambiguous");
        continue;
      }
      classified.push({ ...base, ownerMembershipId: owners[0]!.id, covers: [], pool: null });
      continue;
    }
    classified.push({
      ...base,
      ownerMembershipId: null,
      covers: [workspace.id],
      pool: "workspace",
    });
  }

  // Same organization, upstream account and owner: the rows that a
  // person-blind key would have merged.
  const slotKey = (entry: Classified) =>
    `${entry.row.account_id}\u0000${entry.identity}\u0000${entry.ownerMembershipId ?? "shared"}`;
  const slotSizes = new Map<string, number>();
  for (const entry of classified) {
    if (entry.identity === null) continue;
    slotSizes.set(slotKey(entry), (slotSizes.get(slotKey(entry)) ?? 0) + 1);
  }
  const groups = new Map<string, Classified[]>();
  for (const entry of classified) {
    const key =
      entry.identity === null || entry.person === null
        ? `row:${entry.row.id}`
        : `${slotKey(entry)}\u0000${entry.person}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  // The same person id with two different emails is not provable: keep each
  // row on its own.
  const separated = new Set<string>();
  for (const [key, group] of [...groups]) {
    if (group.length < 2) continue;
    const emails = new Set(group.map((entry) => entry.email).filter((value) => value !== null));
    if (emails.size < 2) continue;
    groups.delete(key);
    for (const entry of group) {
      separated.add(entry.row.id);
      groups.set(`row:${entry.row.id}`, [entry]);
    }
  }

  const connections: PlannedConnection[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => compareCanonicalCandidates(a.row, b.row));
    const canonical = sorted[0]!;
    const accountId = canonical.row.account_id;
    if (new Set(group.map((entry) => entry.row.is_fedramp)).size > 1) {
      conflict(accountId, "fedramp_mismatch");
      continue;
    }
    const dispositions: string[] = [];
    if (
      group.some((entry) => entry.row.extra_credits_enabled === true) &&
      group.some((entry) => entry.row.extra_credits_enabled !== true)
    ) {
      dispositions.push("extra_credit_consent_conflict_disabled");
    }
    // A row kept apart from others of its upstream account and owner carries
    // a per-row person key, so the core identity stays unique; a known person
    // is the key itself.
    const keptApart =
      canonical.identity !== null &&
      (canonical.person === null || separated.has(canonical.row.id)) &&
      (slotSizes.get(slotKey(canonical)) ?? 0) > 1;
    if (keptApart) {
      dispositions.push(
        separated.has(canonical.row.id)
          ? "person_identity_email_mismatch_kept_separate"
          : "person_identity_unknown_kept_separate",
      );
    }
    const providerSubjectId =
      canonical.identity === null
        ? null
        : keptApart
          ? `legacy:${canonical.row.id}`
          : separated.has(canonical.row.id)
            ? null
            : canonical.person;
    const members = sorted.map((entry) => entry.row);
    const unionAllocator = group.some((entry) => entry.row.allocator_enabled);
    const unionAllowed = unionModels(group.map((entry) => entry.row.allowed_model_ids));
    const base = {
      id: canonical.row.id,
      accountId,
      identity: canonical.identity,
      providerSubjectId,
      canonical: canonical.row,
      members,
      status: canonical.row.status as PlannedConnection["status"],
    };

    if (canonical.ownerMembershipId) {
      const owner = membershipById.get(canonical.ownerMembershipId)!;
      // The canonical row's frozen generation transfers only when it is that
      // verified user-scope authority; any other personal connection (a
      // Personal-workspace row) starts at generation 1, and no legacy `user`
      // snapshot then names it.
      const legacyAuthority = canonical.row.organization_user_resource_authority_id
        ? authorityById.get(canonical.row.organization_user_resource_authority_id)
        : undefined;
      const legacyGeneration =
        canonical.row.organization_user_resource_authority_generation === null
          ? null
          : Number(canonical.row.organization_user_resource_authority_generation);
      const userVerified =
        canonical.row.authority_scope === "user" &&
        legacyGeneration !== null &&
        legacyAuthority !== undefined &&
        legacyAuthority.active &&
        legacyAuthority.membershipId === owner.id &&
        legacyAuthority.resourceId === canonical.row.id &&
        legacyAuthority.generation === legacyGeneration;
      const legacyVerified = canonical.row.authority_scope !== "user" || userVerified;
      const personalOrigin = group.find((entry) => entry.row.authority_scope === "workspace");
      if (!owner.active) dispositions.push("personal_owner_inactive");
      if (!legacyVerified) dispositions.push("personal_authority_not_verified");
      connections.push({
        ...base,
        ownership: "personal",
        ownerMembershipId: owner.id,
        ownerSubjectId: owner.subjectId,
        authorityGeneration: userVerified ? legacyGeneration! : 1,
        authorityActive: owner.active && legacyVerified,
        userGenerationCarried: userVerified && owner.active,
        originWorkspaceId: personalOrigin?.row.workspace_id ?? canonical.row.workspace_id,
        scopeKind: "people",
        allowPersonalWorkspaces: true,
        managedByWorkspaceId: null,
        allocatorEnabled: unionAllocator,
        allowedModelIds: unionAllowed,
        workspaceIds: [],
        policies: [],
        autoAssignment: null,
        dispositions,
      });
      continue;
    }

    const organizationSources = group.filter((entry) => entry.pool === "organization");
    const localSources = group.filter((entry) => entry.pool === "workspace");
    const organizationSource = organizationSources[0];
    const organizationScope =
      organizationSources.length === 1 &&
      organizationSource!.row.allowed_workspace_ids === null &&
      organizationSource!.row.allow_personal_workspaces &&
      organizationSource!.row.allocator_enabled === unionAllocator &&
      sameModels(organizationSource!.row.allowed_model_ids, unionAllowed);
    const policiesByKey = new Map<string, PlannedPolicy>();
    const addPolicy = (entry: Classified, workspaceId: string) => {
      const policy: PlannedPolicy = {
        workspaceId,
        pool: entry.pool!,
        allocatorEnabled: entry.row.allocator_enabled,
        allowedModelIds: entry.row.allowed_model_ids,
        managedByWorkspaceId: entry.pool === "workspace" ? entry.row.workspace_id : null,
      };
      const key = `${workspaceId}\u0000${policy.pool}`;
      const existing = policiesByKey.get(key);
      if (!existing) {
        policiesByKey.set(key, policy);
        return;
      }
      // Union enabled policies, not flags and model sets independently. A
      // disabled unrestricted row must never broaden an enabled limited row.
      // When both are disabled the union remains disabled.
      if (existing.allocatorEnabled === policy.allocatorEnabled) {
        existing.allowedModelIds = unionModels([existing.allowedModelIds, policy.allowedModelIds]);
      } else if (policy.allocatorEnabled) {
        existing.allowedModelIds = policy.allowedModelIds;
      }
      existing.allocatorEnabled ||= policy.allocatorEnabled;
      if (!dispositions.includes("duplicate_pool_policy_merged")) {
        dispositions.push("duplicate_pool_policy_merged");
      }
    };
    let workspaceIds: string[];
    let autoAssignment: PlannedAutoAssignment | null = null;
    if (organizationScope) {
      // Every current and future workspace sees the organization source through
      // the connection-level policy. Only a workspace that also has its own
      // local copy needs explicit policies for both pools.
      workspaceIds = [];
      for (const local of localSources) {
        addPolicy(local, local.row.workspace_id!);
        addPolicy(organizationSource!, local.row.workspace_id!);
      }
    } else {
      const covered = new Set<string>();
      for (const entry of group) {
        for (const workspaceId of entry.covers) {
          covered.add(workspaceId);
          addPolicy(entry, workspaceId);
        }
      }
      workspaceIds = [...covered].sort();
      const listed = organizationSource?.row.allowed_workspace_ids ?? [];
      if (listed.some((workspaceId) => !workspaceById.has(workspaceId))) {
        dispositions.push("organization_allowlist_missing_workspace_dropped");
      }
      if (organizationSources.length > 1) {
        // Two organization rows of one person and account cannot exist in
        // legacy (one per organization and ChatGPT account); never widen.
        dispositions.push("organization_reach_not_extended");
      } else if (organizationSource) {
        const sharedWorkspaces = organizationSource.row.allowed_workspace_ids === null;
        const personalWorkspaces = organizationSource.row.allow_personal_workspaces;
        if (sharedWorkspaces || personalWorkspaces) {
          autoAssignment = {
            sharedWorkspaces,
            personalWorkspaces,
            allocatorEnabled: organizationSource.row.allocator_enabled,
            allowedModelIds: organizationSource.row.allowed_model_ids,
          };
          dispositions.push("organization_reach_auto_assigned");
        }
      }
    }
    connections.push({
      ...base,
      ownership: "shared",
      ownerMembershipId: null,
      ownerSubjectId: null,
      authorityGeneration: null,
      authorityActive: false,
      userGenerationCarried: false,
      originWorkspaceId: null,
      scopeKind: organizationScope ? "organization" : "workspaces",
      allowPersonalWorkspaces: organizationScope
        ? true
        : (organizationSource?.row.allow_personal_workspaces ?? false),
      managedByWorkspaceId:
        group.length === 1 && localSources.length === 1 ? localSources[0]!.row.workspace_id : null,
      allocatorEnabled: organizationScope
        ? organizationSource!.row.allocator_enabled
        : unionAllocator,
      allowedModelIds: organizationScope ? organizationSource!.row.allowed_model_ids : unionAllowed,
      workspaceIds,
      policies: [...policiesByKey.values()],
      autoAssignment,
      dispositions,
    });
  }
  connections.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { connections, conflicts };
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
  // The migration's own fixed refusals ("0683 parity mismatch (live_leases)")
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
