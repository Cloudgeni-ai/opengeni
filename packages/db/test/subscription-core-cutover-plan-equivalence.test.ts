import { describe, expect, test } from "bun:test";
import {
  CODEX_CUTOVER_RULES,
  planCodexCutover,
  type CutoverLegacyAuthority,
  type CutoverMembership,
  type CutoverWorkspace,
  type DecodedIdentity,
  type LegacyCodexCredentialRow,
} from "../src/codex-subscription-core-cutover";
import {
  planSubscriptionCoreCutover,
  type SubscriptionCutoverRules,
  type SubscriptionCutoverSource,
} from "../src/subscription-core/cutover-plan";
import { frozenPlanCodexCutover } from "./fixtures/codex-cutover-planner-frozen";

/** A small deterministic PRNG (mulberry32), so every run checks the same cases. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const chance = (p: number) => next() < p;
  return { next, pick, chance };
}

const uuid = (prefix: string, index: number) =>
  `00000000-0000-4000-${prefix}-${String(index).padStart(12, "0")}`;

type Scenario = {
  rows: LegacyCodexCredentialRow[];
  identities: Map<string, DecodedIdentity>;
  workspaces: CutoverWorkspace[];
  memberships: CutoverMembership[];
  legacyAuthorities: CutoverLegacyAuthority[];
};

/** Legacy statuses as stored (the legacy table has no CHECK): core ones, and others. */
const STATUSES = ["active", "active", "active", "error", "needs_relogin", "disabled", ""];
const DATES = [
  null,
  new Date("2026-01-01T00:00:00Z"),
  new Date("2026-02-01T00:00:00Z"),
  new Date("2026-02-01T00:00:00Z"),
  new Date("2026-03-01T00:00:00Z"),
  new Date("invalid"),
];
const MODELS: Array<string[] | null> = [
  null,
  null,
  [],
  ["m/a"],
  ["m/b", "m/a"],
  ["m/a", "m/a"],
  ["m/c"],
];

function scenario(seed: number): Scenario {
  const { pick, chance, next } = random(seed);
  const accounts = [uuid("8000", 1), uuid("8000", 2)].slice(0, chance(0.8) ? 1 : 2);
  const workspaces: CutoverWorkspace[] = [];
  const memberships: CutoverMembership[] = [];
  let counter = 0;
  for (const accountId of accounts) {
    const shared = 1 + Math.floor(next() * 3);
    for (let index = 0; index < shared; index += 1)
      workspaces.push({ id: uuid("a000", (counter += 1)), accountId, personal: false });
    const personal = Math.floor(next() * 3);
    for (let index = 0; index < personal; index += 1) {
      const workspaceId = uuid("b000", (counter += 1));
      workspaces.push({ id: workspaceId, accountId, personal: true });
      const owners = chance(0.12) ? 2 : chance(0.1) ? 0 : 1;
      for (let owner = 0; owner < owners; owner += 1)
        memberships.push({
          id: uuid("c000", (counter += 1)),
          // An owner from another organization is ambiguous too.
          accountId: chance(0.08) ? uuid("8000", 9) : accountId,
          subjectId: `user:${counter}`,
          active: chance(0.85),
          personalWorkspaceId: workspaceId,
        });
    }
    if (chance(0.5))
      memberships.push({
        id: uuid("c000", (counter += 1)),
        accountId,
        subjectId: `user:${counter}`,
        active: chance(0.8),
        personalWorkspaceId: null,
      });
  }
  const missingWorkspace = uuid("a000", 999);
  const rows: LegacyCodexCredentialRow[] = [];
  const identities = new Map<string, DecodedIdentity>();
  const legacyAuthorities: CutoverLegacyAuthority[] = [];
  const count = 1 + Math.floor(next() * 8);
  for (let index = 0; index < count; index += 1) {
    const accountId = pick(accounts);
    const own = workspaces.filter((workspace) => workspace.accountId === accountId);
    const scope = pick(["organization", "organization", "workspace", "workspace", "user", "team"]);
    const workspaceId =
      scope === "organization"
        ? chance(0.7)
          ? null
          : pick(own).id
        : chance(0.08)
          ? pick([null, missingWorkspace])
          : pick(own).id;
    const ownerMembership = pick([
      null,
      ...memberships.filter((membership) => membership.accountId === accountId).map((m) => m.id),
      uuid("c000", 998),
    ]);
    const id = uuid("9000", seed * 16 + index);
    const authorityId = chance(0.5) ? uuid("d000", seed * 16 + index) : null;
    const generation = pick([null, 1, 2, "2"]);
    if (authorityId && ownerMembership && chance(0.8))
      legacyAuthorities.push({
        id: authorityId,
        accountId,
        membershipId: chance(0.85) ? ownerMembership : uuid("c000", 997),
        resourceId: chance(0.9) ? id : uuid("9000", 0),
        generation: chance(0.85) ? Number(generation ?? 1) : 7,
        active: chance(0.85),
      });
    const allowedWorkspaces = chance(0.5)
      ? null
      : [
          ...own.filter(() => chance(0.5)).map((workspace) => workspace.id),
          ...(chance(0.15) ? [missingWorkspace] : []),
        ];
    const extraCredits = pick([undefined, true, false]);
    rows.push({
      id,
      account_id: accountId,
      workspace_id: workspaceId,
      authority_scope: scope,
      chatgpt_account_id: pick([null, "acct-a", "acct-a", "acct-a", "acct-b", ""]),
      scopes: null,
      plan_type: "pro",
      is_fedramp: chance(0.1),
      expires_at: null,
      last_refresh_at: pick(DATES),
      status: pick(STATUSES),
      last_error: null,
      version: 1,
      created_at: pick(DATES.slice(1)) as Date,
      updated_at: pick(DATES.slice(1)) as Date,
      label: null,
      account_email: pick([null, null, "a@example.test", " A@Example.test ", "b@example.test"]),
      primary_used_percent: null,
      primary_reset_at: null,
      secondary_used_percent: null,
      secondary_reset_at: null,
      usage_checked_at: null,
      exhausted_until: null,
      exhausted_kind: null,
      allocator_enabled: chance(0.7),
      ...(extraCredits === undefined ? {} : { extra_credits_enabled: extraCredits }),
      selection_count: 0,
      last_selected_at: null,
      allocator_version: 1,
      reset_credit_available_count: null,
      reset_credits_checked_at: null,
      connected_by_subject_id: null,
      owner_organization_membership_id: ownerMembership,
      organization_user_resource_authority_id: authorityId,
      organization_user_resource_authority_generation: generation,
      allowed_model_ids: pick(MODELS),
      allowed_workspace_ids: allowedWorkspaces,
      allow_personal_workspaces: chance(0.6),
      plan_checked_at: null,
      plan_previous_type: null,
      plan_changed_at: null,
      plan_entitlement_exclusion: null,
    });
    if (chance(0.9))
      identities.set(id, {
        tokenAccountId: pick([null, "acct-a", "acct-a", "acct-a", "acct-b"]),
        ...(chance(0.9)
          ? {
              tokenUserId: pick([
                null,
                "",
                "person-1",
                "person-1",
                "person-1",
                " person-1 ",
                "person-2",
              ]),
            }
          : {}),
        ...(chance(0.7)
          ? { tokenEmail: pick([null, "a@example.test", "b@example.test", "A@EXAMPLE.TEST"]) }
          : {}),
      });
  }
  // Input order matters to grouping and conflict order: shuffle deterministically.
  rows.sort(() => (chance(0.5) ? -1 : 1));
  return { rows, identities, workspaces, memberships, legacyAuthorities };
}

describe("provider-neutral cutover planner", () => {
  test("Codex plans are byte-for-byte the 0689 plans over 20000 generated legacy states", () => {
    // Every branch the rules distinguish, counted over the generated states.
    const reached = new Map<string, number>();
    const reach = (key: string) => reached.set(key, (reached.get(key) ?? 0) + 1);
    for (let seed = 1; seed <= 20_000; seed += 1) {
      const input = scenario(seed);
      const before = frozenPlanCodexCutover(input);
      const after = planCodexCutover(input);
      // Same keys in the same order, same values, same row objects.
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(after).toStrictEqual(before as unknown as typeof after);
      for (const [index, connection] of after.connections.entries()) {
        expect(connection.canonical).toBe(before.connections[index]!.canonical);
        connection.members.forEach((member, position) =>
          expect(member).toBe(before.connections[index]!.members[position]!),
        );
      }
      for (const entry of after.conflicts) reach(`conflict:${entry.conflictClass}`);
      for (const connection of after.connections) {
        reach(`scope:${connection.scopeKind}`);
        reach(connection.members.length > 1 ? "merged" : "single");
        if (connection.autoAssignment) reach("auto_assignment");
        if (connection.managedByWorkspaceId) reach("delegated_manager");
        if (connection.userGenerationCarried) reach("user_generation_carried");
        if (connection.providerSubjectId?.startsWith("legacy:")) reach("legacy_person_key");
        for (const disposition of connection.dispositions) reach(`disposition:${disposition}`);
      }
    }
    const branches = [
      "conflict:fedramp_mismatch",
      "conflict:personal_owner_missing",
      "conflict:personal_workspace_owner_ambiguous",
      "conflict:provider_identity_mismatch",
      "conflict:unrepresentable_scope",
      "conflict:unrepresentable_status",
      "scope:organization",
      "scope:workspaces",
      "scope:people",
      "merged",
      "single",
      "auto_assignment",
      "delegated_manager",
      "user_generation_carried",
      "legacy_person_key",
      "disposition:duplicate_pool_policy_merged",
      "disposition:extra_credit_consent_conflict_disabled",
      "disposition:organization_allowlist_missing_workspace_dropped",
      "disposition:organization_reach_auto_assigned",
      "disposition:organization_reach_not_extended",
      "disposition:person_identity_email_mismatch_kept_separate",
      "disposition:person_identity_unknown_kept_separate",
      "disposition:personal_authority_not_verified",
      "disposition:personal_owner_inactive",
    ];
    expect(branches.filter((branch) => (reached.get(branch) ?? 0) < 40)).toEqual([]);
  });

  test("the Codex entry point is the neutral planner with Codex's rules", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const input = scenario(seed);
      expect(JSON.stringify(planSubscriptionCoreCutover(CODEX_CUTOVER_RULES, input))).toBe(
        JSON.stringify(planCodexCutover(input)),
      );
    }
  });

  test("a status named like an object member is refused instead of planned", () => {
    // The 0689 planner looked statuses up through the object prototype, so a
    // legacy status such as "toString" passed its check and produced a
    // connection the core's status CHECK then refused (the migration aborted
    // on a constraint error). The neutral rules read own keys only and refuse
    // it as an unrepresentable status; both abort the cutover.
    const base = scenario(7);
    const row = { ...base.rows[0]!, authority_scope: "organization", status: "toString" };
    const input = { ...base, rows: [row] };
    expect(frozenPlanCodexCutover(input).connections.map((entry) => entry.status)).toEqual([
      "toString",
    ]);
    expect(planCodexCutover(input)).toEqual({
      connections: [],
      conflicts: [{ accountId: row.account_id, conflictClass: "unrepresentable_status" }],
    });
  });

  test("another provider's row shape and rules plan through the same rules", () => {
    // A provider-free synthetic row shape: different field names, a fourth
    // representable status and its own merge refusal.
    type SyntheticRow = {
      key: string;
      organization: string;
      workspace: string | null;
      reach: string;
      state: string;
      upstream: string | null;
      mail: string | null;
      refreshed: Date | null;
      changed: Date;
      born: Date;
      serving: boolean;
      models: string[] | null;
      workspaces: string[] | null;
      personal: boolean;
      owner: string | null;
      region: string;
    };
    const rules: SubscriptionCutoverRules<
      SyntheticRow,
      "active" | "error" | "needs_relogin" | "disabled",
      "region_mismatch"
    > = {
      statusRank: { active: 0, error: 1, needs_relogin: 2, disabled: 3 },
      source: (row): SubscriptionCutoverSource => ({
        id: row.key,
        accountId: row.organization,
        workspaceId: row.workspace,
        authorityScope: row.reach,
        status: row.state,
        providerAccountId: row.upstream,
        accountEmail: row.mail,
        lastRefreshAt: row.refreshed,
        updatedAt: row.changed,
        createdAt: row.born,
        allocatorEnabled: row.serving,
        allowedModelIds: row.models,
        allowedWorkspaceIds: row.workspaces,
        allowPersonalWorkspaces: row.personal,
        ownerOrganizationMembershipId: row.owner,
        userAuthorityId: null,
        userAuthorityGeneration: null,
      }),
      groupConflict: (rows) =>
        new Set(rows.map((row) => row.region)).size > 1 ? "region_mismatch" : null,
    };
    const organization = uuid("8000", 1);
    const [w1, w2, w3, personal] = [1, 2, 3, 4].map((index) => uuid("a000", index)) as [
      string,
      string,
      string,
      string,
    ];
    const owner = uuid("c000", 1);
    const at = new Date("2026-01-01T00:00:00Z");
    const row = (overrides: Partial<SyntheticRow>): SyntheticRow => ({
      key: uuid("9000", 0),
      organization,
      workspace: null,
      reach: "organization",
      state: "active",
      upstream: "upstream-1",
      mail: null,
      refreshed: null,
      changed: at,
      born: at,
      serving: true,
      models: null,
      workspaces: null,
      personal: false,
      owner: null,
      region: "global",
      ...overrides,
    });
    const identities = (rows: SyntheticRow[]) =>
      new Map(rows.map((entry) => [entry.key, { tokenAccountId: null, tokenUserId: "p1" }]));
    const context = {
      workspaces: [
        { id: w1, accountId: organization, personal: false },
        { id: w2, accountId: organization, personal: false },
        { id: w3, accountId: organization, personal: false },
        { id: personal, accountId: organization, personal: true },
      ],
      memberships: [
        {
          id: owner,
          accountId: organization,
          subjectId: "user:owner",
          active: true,
          personalWorkspaceId: personal,
        },
      ],
      legacyAuthorities: [],
    };

    // An organization source without Personal reach: `workspaces` scope over
    // today's shared workspaces plus an auto-assignment for later ones; the
    // disabled local copy of the same person merges into it as a policy.
    const organizationRow = row({ key: uuid("9000", 1) });
    const disabledLocal = row({
      key: uuid("9000", 2),
      reach: "workspace",
      workspace: w2,
      state: "disabled",
      models: ["m/a"],
    });
    const shared = planSubscriptionCoreCutover(rules, {
      ...context,
      rows: [disabledLocal, organizationRow],
      identities: identities([disabledLocal, organizationRow]),
    });
    expect(shared.conflicts).toEqual([]);
    expect(shared.connections).toHaveLength(1);
    expect(shared.connections[0]).toMatchObject({
      id: organizationRow.key,
      canonical: organizationRow,
      members: [organizationRow, disabledLocal],
      status: "active",
      ownership: "shared",
      scopeKind: "workspaces",
      allowPersonalWorkspaces: false,
      managedByWorkspaceId: null,
      workspaceIds: [w1, w2, w3],
      autoAssignment: {
        sharedWorkspaces: true,
        personalWorkspaces: false,
        allocatorEnabled: true,
        allowedModelIds: null,
      },
      dispositions: ["organization_reach_auto_assigned"],
    });
    expect(shared.connections[0]!.policies).toContainEqual({
      workspaceId: w2,
      pool: "workspace",
      allocatorEnabled: true,
      allowedModelIds: ["m/a"],
      managedByWorkspaceId: w2,
    });

    // A single organization source with Personal reach and the union policy:
    // `organization` scope, no enumerated workspaces, no auto-assignment.
    const everywhere = row({ key: uuid("9000", 3), personal: true });
    const organizationScoped = planSubscriptionCoreCutover(rules, {
      ...context,
      rows: [everywhere],
      identities: identities([everywhere]),
    });
    expect(organizationScoped.connections[0]).toMatchObject({
      scopeKind: "organization",
      allowPersonalWorkspaces: true,
      workspaceIds: [],
      autoAssignment: null,
      policies: [],
    });

    // One workspace source: delegated to its workspace.
    const local = row({ key: uuid("9000", 4), reach: "workspace", workspace: w3 });
    expect(
      planSubscriptionCoreCutover(rules, {
        ...context,
        rows: [local],
        identities: identities([local]),
      }).connections[0],
    ).toMatchObject({ scopeKind: "workspaces", managedByWorkspaceId: w3, workspaceIds: [w3] });

    // The provider's merge refusal and an unrepresentable status.
    const eu = row({ key: uuid("9000", 5), region: "eu" });
    const unknown = row({ key: uuid("9000", 6), state: "suspended" });
    expect(
      planSubscriptionCoreCutover(rules, {
        ...context,
        rows: [organizationRow, eu, unknown],
        identities: identities([organizationRow, eu, unknown]),
      }),
    ).toEqual({
      connections: [],
      conflicts: [
        { accountId: organization, conflictClass: "unrepresentable_status" },
        { accountId: organization, conflictClass: "region_mismatch" },
      ],
    });
  });
});
