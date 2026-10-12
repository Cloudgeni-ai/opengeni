/**
 * A frozen copy of the Codex cutover planner as migration 0689 shipped it,
 * before its generic rules moved to the provider-neutral planner
 * (`src/subscription-core/cutover-plan.ts`). Test-only: the equivalence test
 * proves the refactored `planCodexCutover` returns byte-for-byte the same
 * plan. Do not edit the code below; it is the exact pre-refactor source.
 */

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

/** Flags and models form one policy: paused rows contribute no enabled capacity. */
function unionAllocationPolicies(
  policies: readonly Pick<PlannedPolicy, "allocatorEnabled" | "allowedModelIds">[],
): Pick<PlannedPolicy, "allocatorEnabled" | "allowedModelIds"> {
  const allocatorEnabled = policies.some((policy) => policy.allocatorEnabled);
  return {
    allocatorEnabled,
    allowedModelIds: unionModels(
      policies
        .filter((policy) => policy.allocatorEnabled || !allocatorEnabled)
        .map((policy) => policy.allowedModelIds),
    ),
  };
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
 * is the enabled-source union (or the disabled union if every source is paused).
 * Personal connections have no assignment policy, so this same ceiling is also
 * their complete allocator/model policy.
 */
export function frozenPlanCodexCutover(input: {
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
    const { allocatorEnabled: unionAllocator, allowedModelIds: unionAllowed } =
      unionAllocationPolicies(
        group.map(({ row }) => ({
          allocatorEnabled: row.allocator_enabled,
          allowedModelIds: row.allowed_model_ids,
        })),
      );
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
      Object.assign(existing, unionAllocationPolicies([existing, policy]));
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
