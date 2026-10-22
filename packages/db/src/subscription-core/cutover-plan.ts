/**
 * The provider-neutral rules of a provider's drained cutover onto the shared
 * subscription core (design docs/design/subscription-core-2026-10-07.md,
 * 5.1.1 "Data move and cutover protocol" and 5.3 "Data mapping"): which
 * legacy credential rows become one connection (dedupe and the canonical
 * row), its scope, one assignment policy per (workspace, inference pool)
 * source, its delegated manager, the connection-level policy union, and the
 * auto-assignment that keeps an organization source's reach over workspaces
 * created later.
 *
 * Keyed by provider: each provider's cutover stage passes its own rules
 * (`SubscriptionCutoverRules`): the legacy statuses it can represent, the
 * neutral facts of its legacy row shape and any group its rows must never
 * merge. The rules here never read a provider id or a provider-specific
 * column; the provider's own row travels through the plan untouched
 * (`canonical`, `members`) for its stage to write.
 *
 * Pure: the stage supplies decrypted identity facts, never the secret, and
 * the plan names its conflicts by a content-free class and organization id.
 */

export type SubscriptionCutoverWorkspace = { id: string; accountId: string; personal: boolean };
export type SubscriptionCutoverMembership = {
  id: string;
  accountId: string;
  subjectId: string;
  active: boolean;
  personalWorkspaceId: string | null;
};
export type SubscriptionCutoverLegacyAuthority = {
  id: string;
  accountId: string;
  membershipId: string;
  resourceId: string;
  generation: number;
  active: boolean;
};

/** What the stage learned from a decrypted credential, without the secret. */
export type SubscriptionCutoverDecodedIdentity = {
  /** The upstream account id the credential's token names, when it parses. */
  tokenAccountId: string | null;
  /**
   * The signed-in person the token names. Several people can share one
   * upstream account, so only this tells two people's logins apart.
   */
  tokenUserId?: string | null;
  /** The token's email claim, a secondary same-person check only. */
  tokenEmail?: string | null;
};

/**
 * The neutral facts the rules read from one legacy credential row. Values
 * pass through from the provider's row as they are (no defaulting), so the
 * rules decide on exactly what the legacy row holds.
 */
export type SubscriptionCutoverSource = {
  id: string;
  accountId: string;
  workspaceId: string | null;
  /** `organization`, `workspace` or `user`; any other scope is unrepresentable. */
  authorityScope: string;
  status: string;
  /** The stored upstream account id, cross-checked against the token's. */
  providerAccountId: string | null;
  /** The stored account email. */
  accountEmail: string | null;
  lastRefreshAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
  allocatorEnabled: boolean;
  allowedModelIds: string[] | null;
  allowedWorkspaceIds: string[] | null;
  allowPersonalWorkspaces: boolean;
  /** Absent for a provider without extra credits. */
  extraCreditsEnabled?: boolean | undefined;
  ownerOrganizationMembershipId: string | null;
  /** The legacy user-scope personal authority and its frozen generation. */
  userAuthorityId: string | null;
  userAuthorityGeneration: number | string | null;
};

/** One provider's cutover rules: its legacy row shape and facts, as data. */
export type SubscriptionCutoverRules<
  Row,
  Status extends string = string,
  GroupConflict extends string = never,
> = {
  /**
   * The legacy statuses the core can represent, by canonical preference
   * (lower is healthier). A row with any other status is a conflict.
   */
  readonly statusRank: Readonly<Record<Status, number>>;
  /** The neutral facts of one legacy row. */
  readonly source: (row: Row) => SubscriptionCutoverSource;
  /**
   * A conflict class when one upstream identity's rows (canonical first)
   * disagree on a fact the provider cannot merge, or null.
   */
  readonly groupConflict?: (rows: readonly Row[]) => GroupConflict | null;
};

export type SubscriptionCutoverConflictClass<GroupConflict extends string = never> =
  | "provider_identity_mismatch"
  | "personal_workspace_owner_ambiguous"
  | "personal_owner_missing"
  | "unrepresentable_status"
  | "unrepresentable_scope"
  | GroupConflict;

export type SubscriptionCutoverConflict<GroupConflict extends string = never> = {
  accountId: string;
  conflictClass: SubscriptionCutoverConflictClass<GroupConflict>;
};

export type SubscriptionCutoverPolicy = {
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
export type SubscriptionCutoverAutoAssignment = {
  sharedWorkspaces: boolean;
  personalWorkspaces: boolean;
  allocatorEnabled: boolean;
  allowedModelIds: string[] | null;
};

export type SubscriptionCutoverConnection<Row, Status extends string = string> = {
  id: string;
  accountId: string;
  identity: string | null;
  /** The upstream person (`provider_subject_id`); see planSubscriptionCoreCutover. */
  providerSubjectId: string | null;
  canonical: Row;
  members: Row[];
  status: Status;
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
  policies: SubscriptionCutoverPolicy[];
  autoAssignment: SubscriptionCutoverAutoAssignment | null;
  /** Content-free dispositions that are not parity failures. */
  dispositions: string[];
};

export type SubscriptionCutoverPlan<
  Row,
  Status extends string = string,
  GroupConflict extends string = never,
> = {
  connections: SubscriptionCutoverConnection<Row, Status>[];
  conflicts: SubscriptionCutoverConflict<GroupConflict>[];
};

export type SubscriptionCutoverInput<Row> = {
  rows: readonly Row[];
  identities: ReadonlyMap<string, SubscriptionCutoverDecodedIdentity>;
  workspaces: readonly SubscriptionCutoverWorkspace[];
  memberships: readonly SubscriptionCutoverMembership[];
  legacyAuthorities: readonly SubscriptionCutoverLegacyAuthority[];
};

function time(value: Date | null | undefined): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/** A status the rules admit (own keys only: never an inherited object member). */
function representable(statusRank: Readonly<Record<string, number>>, status: string): boolean {
  return Object.prototype.hasOwnProperty.call(statusRank, status);
}

/** Healthiest first, then the freshest token family, then deterministic order. */
export function compareSubscriptionCutoverSources(
  statusRank: Readonly<Record<string, number>>,
  a: SubscriptionCutoverSource,
  b: SubscriptionCutoverSource,
): number {
  const rank = (source: SubscriptionCutoverSource) =>
    representable(statusRank, source.status) ? statusRank[source.status]! : 9;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const refreshA = time(a.lastRefreshAt);
  const refreshB = time(b.lastRefreshAt);
  if (refreshA !== refreshB) {
    if (refreshA === null) return 1;
    if (refreshB === null) return -1;
    return refreshB - refreshA;
  }
  const updatedA = time(a.updatedAt) ?? 0;
  const updatedB = time(b.updatedAt) ?? 0;
  if (updatedA !== updatedB) return updatedB - updatedA;
  const createdA = time(a.createdAt) ?? 0;
  const createdB = time(b.createdAt) ?? 0;
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
export function unionSubscriptionCutoverPolicies(
  policies: readonly Pick<SubscriptionCutoverPolicy, "allocatorEnabled" | "allowedModelIds">[],
): Pick<SubscriptionCutoverPolicy, "allocatorEnabled" | "allowedModelIds"> {
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
 * Plan the canonical connections for every legacy credential row of one
 * provider. Pure: the caller supplies decrypted identity facts, never the
 * secret itself.
 *
 * Identity: organization, upstream account (the stored upstream account id,
 * cross-checked against the token's; a contradiction is a conflict), the
 * signed-in person (the token's user id) and owner (the personal owner
 * membership, or shared). Several people can share one upstream account, so
 * rows merge only when they are provably the same person: a row whose person
 * is unknown, or whose stored and token emails disagree with another row of
 * the same person, stays its own connection (a content-free disposition, not
 * an abort). Distinct people stay distinct connections, each with its own
 * credential, assignments, designations and pins. Within a group the
 * healthiest row (the rules' status rank, then the freshest refresh) is
 * canonical and keeps its id; the others become aliases. A group the rules
 * refuse to merge (`groupConflict`) is a conflict.
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
export function planSubscriptionCoreCutover<
  Row,
  Status extends string = string,
  GroupConflict extends string = never,
>(
  rules: SubscriptionCutoverRules<Row, Status, GroupConflict>,
  input: SubscriptionCutoverInput<Row>,
): SubscriptionCutoverPlan<Row, Status, GroupConflict> {
  const statusRank: Readonly<Record<string, number>> = rules.statusRank;
  const conflicts: SubscriptionCutoverConflict<GroupConflict>[] = [];
  const conflict = (
    accountId: string,
    conflictClass: SubscriptionCutoverConflictClass<GroupConflict>,
  ) => conflicts.push({ accountId, conflictClass });
  const workspacesByAccount = new Map<string, SubscriptionCutoverWorkspace[]>();
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
  const personalOwners = new Map<string, SubscriptionCutoverMembership[]>();
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
    row: Row;
    source: SubscriptionCutoverSource;
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
    const source = rules.source(row);
    if (!representable(statusRank, source.status)) {
      conflict(source.accountId, "unrepresentable_status");
      continue;
    }
    const decoded = input.identities.get(source.id);
    const tokenAccountId = decoded?.tokenAccountId ?? null;
    if (source.providerAccountId && tokenAccountId && source.providerAccountId !== tokenAccountId) {
      conflict(source.accountId, "provider_identity_mismatch");
      continue;
    }
    const identity = source.providerAccountId ?? tokenAccountId;
    const person = decoded?.tokenUserId?.trim() || null;
    const email =
      (source.accountEmail ?? decoded?.tokenEmail ?? null)?.trim().toLowerCase() || null;
    const base = { row, source, identity, person, email };
    const workspaces = workspacesByAccount.get(source.accountId) ?? [];
    if (source.authorityScope === "organization") {
      const allowed = source.allowedWorkspaceIds;
      const covers = workspaces
        .filter((workspace) =>
          workspace.personal
            ? source.allowPersonalWorkspaces
            : allowed === null || allowed.includes(workspace.id),
        )
        .map((workspace) => workspace.id);
      classified.push({ ...base, ownerMembershipId: null, covers, pool: "organization" });
      continue;
    }
    if (source.authorityScope === "user") {
      const owner = source.ownerOrganizationMembershipId
        ? membershipById.get(source.ownerOrganizationMembershipId)
        : undefined;
      if (!owner || owner.accountId !== source.accountId) {
        conflict(source.accountId, "personal_owner_missing");
        continue;
      }
      classified.push({ ...base, ownerMembershipId: owner.id, covers: [], pool: null });
      continue;
    }
    if (source.authorityScope !== "workspace" || !source.workspaceId) {
      conflict(source.accountId, "unrepresentable_scope");
      continue;
    }
    const workspace = workspaceById.get(source.workspaceId);
    if (!workspace || workspace.accountId !== source.accountId) {
      conflict(source.accountId, "unrepresentable_scope");
      continue;
    }
    if (workspace.personal) {
      const owners = personalOwners.get(workspace.id) ?? [];
      if (owners.length !== 1 || owners[0]!.accountId !== source.accountId) {
        conflict(source.accountId, "personal_workspace_owner_ambiguous");
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
    `${entry.source.accountId}\u0000${entry.identity}\u0000${entry.ownerMembershipId ?? "shared"}`;
  const slotSizes = new Map<string, number>();
  for (const entry of classified) {
    if (entry.identity === null) continue;
    slotSizes.set(slotKey(entry), (slotSizes.get(slotKey(entry)) ?? 0) + 1);
  }
  const groups = new Map<string, Classified[]>();
  for (const entry of classified) {
    const key =
      entry.identity === null || entry.person === null
        ? `row:${entry.source.id}`
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
      separated.add(entry.source.id);
      groups.set(`row:${entry.source.id}`, [entry]);
    }
  }

  const connections: SubscriptionCutoverConnection<Row, Status>[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) =>
      compareSubscriptionCutoverSources(statusRank, a.source, b.source),
    );
    const canonical = sorted[0]!;
    const accountId = canonical.source.accountId;
    const refused = rules.groupConflict?.(sorted.map((entry) => entry.row)) ?? null;
    if (refused !== null) {
      conflict(accountId, refused);
      continue;
    }
    const dispositions: string[] = [];
    if (
      group.some((entry) => entry.source.extraCreditsEnabled === true) &&
      group.some((entry) => entry.source.extraCreditsEnabled !== true)
    ) {
      dispositions.push("extra_credit_consent_conflict_disabled");
    }
    // A row kept apart from others of its upstream account and owner carries
    // a per-row person key, so the core identity stays unique; a known person
    // is the key itself.
    const keptApart =
      canonical.identity !== null &&
      (canonical.person === null || separated.has(canonical.source.id)) &&
      (slotSizes.get(slotKey(canonical)) ?? 0) > 1;
    if (keptApart) {
      dispositions.push(
        separated.has(canonical.source.id)
          ? "person_identity_email_mismatch_kept_separate"
          : "person_identity_unknown_kept_separate",
      );
    }
    const providerSubjectId =
      canonical.identity === null
        ? null
        : keptApart
          ? `legacy:${canonical.source.id}`
          : separated.has(canonical.source.id)
            ? null
            : canonical.person;
    const members = sorted.map((entry) => entry.row);
    const { allocatorEnabled: unionAllocator, allowedModelIds: unionAllowed } =
      unionSubscriptionCutoverPolicies(
        group.map(({ source }) => ({
          allocatorEnabled: source.allocatorEnabled,
          allowedModelIds: source.allowedModelIds,
        })),
      );
    const base = {
      id: canonical.source.id,
      accountId,
      identity: canonical.identity,
      providerSubjectId,
      canonical: canonical.row,
      members,
      status: canonical.source.status as Status,
    };

    if (canonical.ownerMembershipId) {
      const owner = membershipById.get(canonical.ownerMembershipId)!;
      // The canonical row's frozen generation transfers only when it is that
      // verified user-scope authority; any other personal connection (a
      // Personal-workspace row) starts at generation 1, and no legacy `user`
      // snapshot then names it.
      const legacyAuthority = canonical.source.userAuthorityId
        ? authorityById.get(canonical.source.userAuthorityId)
        : undefined;
      const legacyGeneration =
        canonical.source.userAuthorityGeneration === null
          ? null
          : Number(canonical.source.userAuthorityGeneration);
      const userVerified =
        canonical.source.authorityScope === "user" &&
        legacyGeneration !== null &&
        legacyAuthority !== undefined &&
        legacyAuthority.active &&
        legacyAuthority.membershipId === owner.id &&
        legacyAuthority.resourceId === canonical.source.id &&
        legacyAuthority.generation === legacyGeneration;
      const legacyVerified = canonical.source.authorityScope !== "user" || userVerified;
      const personalOrigin = group.find((entry) => entry.source.authorityScope === "workspace");
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
        originWorkspaceId: personalOrigin?.source.workspaceId ?? canonical.source.workspaceId,
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
      organizationSource!.source.allowedWorkspaceIds === null &&
      organizationSource!.source.allowPersonalWorkspaces &&
      organizationSource!.source.allocatorEnabled === unionAllocator &&
      sameModels(organizationSource!.source.allowedModelIds, unionAllowed);
    const policiesByKey = new Map<string, SubscriptionCutoverPolicy>();
    const addPolicy = (entry: Classified, workspaceId: string) => {
      const policy: SubscriptionCutoverPolicy = {
        workspaceId,
        pool: entry.pool!,
        allocatorEnabled: entry.source.allocatorEnabled,
        allowedModelIds: entry.source.allowedModelIds,
        managedByWorkspaceId: entry.pool === "workspace" ? entry.source.workspaceId : null,
      };
      const key = `${workspaceId}\u0000${policy.pool}`;
      const existing = policiesByKey.get(key);
      if (!existing) {
        policiesByKey.set(key, policy);
        return;
      }
      Object.assign(existing, unionSubscriptionCutoverPolicies([existing, policy]));
      if (!dispositions.includes("duplicate_pool_policy_merged")) {
        dispositions.push("duplicate_pool_policy_merged");
      }
    };
    let workspaceIds: string[];
    let autoAssignment: SubscriptionCutoverAutoAssignment | null = null;
    if (organizationScope) {
      // Every current and future workspace sees the organization source through
      // the connection-level policy. Only a workspace that also has its own
      // local copy needs explicit policies for both pools.
      workspaceIds = [];
      for (const local of localSources) {
        addPolicy(local, local.source.workspaceId!);
        addPolicy(organizationSource!, local.source.workspaceId!);
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
      const listed = organizationSource?.source.allowedWorkspaceIds ?? [];
      if (listed.some((workspaceId) => !workspaceById.has(workspaceId))) {
        dispositions.push("organization_allowlist_missing_workspace_dropped");
      }
      if (organizationSources.length > 1) {
        // Two organization rows of one person and account cannot exist in
        // legacy (one per organization and upstream account); never widen.
        dispositions.push("organization_reach_not_extended");
      } else if (organizationSource) {
        const sharedWorkspaces = organizationSource.source.allowedWorkspaceIds === null;
        const personalWorkspaces = organizationSource.source.allowPersonalWorkspaces;
        if (sharedWorkspaces || personalWorkspaces) {
          autoAssignment = {
            sharedWorkspaces,
            personalWorkspaces,
            allocatorEnabled: organizationSource.source.allocatorEnabled,
            allowedModelIds: organizationSource.source.allowedModelIds,
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
        : (organizationSource?.source.allowPersonalWorkspaces ?? false),
      managedByWorkspaceId:
        group.length === 1 && localSources.length === 1
          ? localSources[0]!.source.workspaceId
          : null,
      allocatorEnabled: organizationScope
        ? organizationSource!.source.allocatorEnabled
        : unionAllocator,
      allowedModelIds: organizationScope
        ? organizationSource!.source.allowedModelIds
        : unionAllowed,
      workspaceIds,
      policies: [...policiesByKey.values()],
      autoAssignment,
      dispositions,
    });
  }
  connections.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { connections, conflicts };
}
