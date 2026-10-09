import { describe, expect, test } from "bun:test";
import {
  canServe,
  type PlacementInput,
  type SubscriptionConnection,
} from "@opengeni/subscriptions";
import {
  planCodexCutover,
  planCodexCutoverQuota,
  type CutoverLegacyAuthority,
  type CutoverMembership,
  type CutoverWorkspace,
  type LegacyCodexCredentialRow,
} from "../src/codex-subscription-core-cutover";

const account = "00000000-0000-4000-8000-000000000001";
const w1 = "00000000-0000-4000-8000-0000000000a1";
const w2 = "00000000-0000-4000-8000-0000000000a2";
const personal = "00000000-0000-4000-8000-0000000000b1";
const owner = "00000000-0000-4000-8000-0000000000c1";
const workspaces: CutoverWorkspace[] = [
  { id: w1, accountId: account, personal: false },
  { id: w2, accountId: account, personal: false },
  { id: personal, accountId: account, personal: true },
];
const memberships: CutoverMembership[] = [
  {
    id: owner,
    accountId: account,
    subjectId: "user:owner",
    active: true,
    personalWorkspaceId: personal,
  },
];
let next = 0;
function row(overrides: Partial<LegacyCodexCredentialRow>): LegacyCodexCredentialRow {
  next += 1;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    account_id: account,
    workspace_id: w1,
    authority_scope: "workspace",
    chatgpt_account_id: "acct",
    scopes: null,
    plan_type: "pro",
    is_fedramp: false,
    expires_at: null,
    last_refresh_at: null,
    status: "active",
    last_error: null,
    version: 3,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    label: null,
    account_email: null,
    primary_used_percent: null,
    primary_reset_at: null,
    secondary_used_percent: null,
    secondary_reset_at: null,
    usage_checked_at: null,
    exhausted_until: null,
    exhausted_kind: null,
    allocator_enabled: true,
    selection_count: 0,
    last_selected_at: null,
    allocator_version: 1,
    reset_credit_available_count: null,
    reset_credits_checked_at: null,
    connected_by_subject_id: null,
    owner_organization_membership_id: null,
    organization_user_resource_authority_id: null,
    organization_user_resource_authority_generation: null,
    allowed_model_ids: null,
    allowed_workspace_ids: null,
    allow_personal_workspaces: true,
    plan_checked_at: null,
    plan_previous_type: null,
    plan_changed_at: null,
    plan_entitlement_exclusion: null,
    ...overrides,
  };
}
/** Every row is the same signed-in person unless `persons` says otherwise. */
const plan = (
  rows: LegacyCodexCredentialRow[],
  tokens: Record<string, string | null> = {},
  persons: Record<string, string | null> = {},
  options: { emails?: Record<string, string>; legacyAuthorities?: CutoverLegacyAuthority[] } = {},
) =>
  planCodexCutover({
    rows,
    identities: new Map(
      rows.map((entry) => [
        entry.id,
        {
          tokenAccountId: tokens[entry.id] ?? null,
          tokenUserId: entry.id in persons ? persons[entry.id]! : "person-a",
          tokenEmail: options.emails?.[entry.id] ?? null,
        },
      ]),
    ),
    workspaces,
    memberships,
    legacyAuthorities: options.legacyAuthorities ?? [],
  });

describe("Codex cutover dedupe and scope planning", () => {
  test("one upstream identity collapses to the healthiest row and keeps per-workspace policy", () => {
    const healthy = row({ workspace_id: w1, last_refresh_at: new Date("2026-02-01T00:00:00Z") });
    const broken = row({
      workspace_id: w2,
      status: "error",
      allocator_enabled: false,
      allowed_model_ids: ["codex/a"],
    });
    const result = plan([broken, healthy]);
    expect(result.conflicts).toEqual([]);
    expect(result.connections).toHaveLength(1);
    const [connection] = result.connections;
    expect(connection!.id).toBe(healthy.id);
    expect(connection!.members.map((member) => member.id)).toEqual([healthy.id, broken.id]);
    expect(connection!.scopeKind).toBe("workspaces");
    expect(connection!.workspaceIds).toEqual([w1, w2].sort());
    expect(connection!.managedByWorkspaceId).toBeNull();
    // Connection-level policy is the union so each workspace's own policy decides.
    expect(connection!.allocatorEnabled).toBe(true);
    expect(connection!.allowedModelIds).toBeNull();
    expect(connection!.policies).toEqual(
      expect.arrayContaining([
        {
          workspaceId: w1,
          pool: "workspace",
          allocatorEnabled: true,
          allowedModelIds: null,
          managedByWorkspaceId: w1,
        },
        {
          workspaceId: w2,
          pool: "workspace",
          allocatorEnabled: false,
          allowedModelIds: ["codex/a"],
          managedByWorkspaceId: w2,
        },
      ]),
    );
  });

  test("an organization row without an allowlist is organization scope with the local copy in both pools", () => {
    const organization = row({ workspace_id: null, authority_scope: "organization" });
    const local = row({ workspace_id: w1 });
    const [connection] = plan([organization, local]).connections;
    expect(connection!.scopeKind).toBe("organization");
    expect(connection!.workspaceIds).toEqual([]);
    expect(
      connection!.policies.map((policy) => `${policy.workspaceId}:${policy.pool}`).sort(),
    ).toEqual([`${w1}:organization`, `${w1}:workspace`].sort());
  });

  test("an organization row narrower than a local copy, or one excluding Personal workspaces, is enumerated", () => {
    const organization = row({
      workspace_id: null,
      authority_scope: "organization",
      allowed_model_ids: ["codex/a"],
    });
    const local = row({ workspace_id: w1 });
    const [connection] = plan([organization, local]).connections;
    expect(connection!.scopeKind).toBe("workspaces");
    expect(connection!.dispositions).toContain("organization_reach_auto_assigned");
    expect(connection!.workspaceIds).toEqual([w1, w2, personal].sort());
    // Workspaces created later keep the organization source's reach and policy.
    expect(connection!.autoAssignment).toEqual({
      sharedWorkspaces: true,
      personalWorkspaces: true,
      allocatorEnabled: true,
      allowedModelIds: ["codex/a"],
    });
    const noPersonal = plan([
      row({
        workspace_id: null,
        authority_scope: "organization",
        allow_personal_workspaces: false,
      }),
    ]);
    expect(noPersonal.connections[0]!.workspaceIds).toEqual([w1, w2].sort());
    expect(noPersonal.connections[0]!.allowPersonalWorkspaces).toBe(false);
    expect(noPersonal.connections[0]!.autoAssignment).toMatchObject({
      sharedWorkspaces: true,
      personalWorkspaces: false,
    });
  });

  test("an allowlisted organization row keeps its Personal-workspace reach", () => {
    const [connection] = plan([
      row({
        workspace_id: null,
        authority_scope: "organization",
        allowed_workspace_ids: [w2],
        allow_personal_workspaces: true,
      }),
    ]).connections;
    expect(connection!.scopeKind).toBe("workspaces");
    expect(connection!.allowPersonalWorkspaces).toBe(true);
    expect(connection!.workspaceIds).toEqual([w2, personal].sort());
    expect(connection!.autoAssignment).toMatchObject({
      sharedWorkspaces: false,
      personalWorkspaces: true,
    });
  });

  test("two people's logins of one ChatGPT workspace stay distinct connections", () => {
    const alice = row({ workspace_id: w1 });
    const bob = row({ workspace_id: w2 });
    const result = plan([alice, bob], {}, { [alice.id]: "alice", [bob.id]: "bob" });
    expect(result.conflicts).toEqual([]);
    expect(result.connections).toHaveLength(2);
    const byId = new Map(result.connections.map((connection) => [connection.id, connection]));
    expect(byId.get(alice.id)).toMatchObject({
      providerSubjectId: "alice",
      members: [alice],
      workspaceIds: [w1],
      managedByWorkspaceId: w1,
    });
    expect(byId.get(bob.id)).toMatchObject({
      providerSubjectId: "bob",
      members: [bob],
      workspaceIds: [w2],
      managedByWorkspaceId: w2,
    });
  });

  test("an unknown or contradictory person is never merged", () => {
    const known = row({ workspace_id: w1 });
    const unknown = row({ workspace_id: w2 });
    const unresolved = plan([known, unknown], {}, { [unknown.id]: null });
    expect(unresolved.connections).toHaveLength(2);
    const lone = unresolved.connections.find((connection) => connection.id === unknown.id)!;
    expect(lone.providerSubjectId).toBe(`legacy:${unknown.id}`);
    expect(lone.dispositions).toContain("person_identity_unknown_kept_separate");
    expect(
      unresolved.connections.find((connection) => connection.id === known.id)!.providerSubjectId,
    ).toBe("person-a");
    // Alone in its upstream account, an unknown person needs no separating key.
    const solo = row({});
    expect(plan([solo], {}, { [solo.id]: null }).connections[0]!.providerSubjectId).toBeNull();
    // One person id with two different emails is not provably one person.
    const first = row({ workspace_id: w1, account_email: "one@example.test" });
    const second = row({ workspace_id: w2, account_email: "two@example.test" });
    const contradictory = plan([first, second]);
    expect(contradictory.connections).toHaveLength(2);
    expect(
      contradictory.connections.map((connection) => connection.providerSubjectId).sort(),
    ).toEqual([`legacy:${first.id}`, `legacy:${second.id}`].sort());
    expect(contradictory.connections[0]!.dispositions).toContain(
      "person_identity_email_mismatch_kept_separate",
    );
  });

  test("two source rows in one pool of one workspace merge their policy instead of colliding", () => {
    const first = row({ chatgpt_account_id: null, workspace_id: w1, allocator_enabled: false });
    const second = row({
      chatgpt_account_id: null,
      workspace_id: w1,
      allowed_model_ids: ["codex/a"],
    });
    const result = plan([first, second], { [first.id]: "acct-x", [second.id]: "acct-x" });
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]!.policies).toEqual([
      {
        workspaceId: w1,
        pool: "workspace",
        allocatorEnabled: true,
        allowedModelIds: ["codex/a"],
        managedByWorkspaceId: w1,
      },
    ]);
    expect(result.connections[0]!.dispositions).toContain("duplicate_pool_policy_merged");
    const migrated = result.connections[0]!;
    const connection: SubscriptionConnection = {
      id: migrated.id,
      provider: "codex",
      kind: "subscription",
      health: "healthy",
      allocatorEnabled: migrated.allocatorEnabled,
      entitledModelIds: null,
      excludedModelIds: [],
      allowedModelIds: migrated.allowedModelIds,
      refreshGeneration: 1,
      quota: null,
      ownership: {
        kind: "shared",
        managedByWorkspaceId: migrated.managedByWorkspaceId,
        scope: {
          kind: "workspaces",
          workspaceIds: migrated.workspaceIds,
          allowPersonalWorkspaces: false,
        },
      },
      assignmentPolicies: migrated.policies.map((policy) => ({
        ...policy,
        inferencePool: policy.pool,
      })),
    };
    const world: PlacementInput = {
      now: Date.now(),
      workspace: { id: w1, kind: "shared", ownerMembershipId: null, allowedModelIds: null },
      session: {
        id: "session",
        workspaceId: w1,
        visibility: "shared",
        ownerMembershipId: owner,
        preferredModelId: "codex/a",
        reasoningLevel: "medium",
        binding: null,
        onlyThisModel: true,
        reselectionPoints: [],
        personalAuthority: [],
        compactionProviderLock: null,
      },
      settings: {
        rotation: {},
        providers: {},
        crossProviderFailover: false,
        fallbackOrder: {},
        personalConnectionsAllowed: false,
        personalFallbackAllowed: false,
      },
      people: [],
      models: ["codex/a", "codex/b"].map((id) => ({
        id,
        provider: "codex",
        reasoningLevels: ["medium"],
      })),
      connections: [connection],
      cacheFacts: {},
    };
    expect(canServe(world, connection, "codex/a")).toBe(true);
    expect(canServe(world, connection, "codex/b")).toBe(false);
  });

  test("a legacy user snapshot's generation transfers only from its verified canonical row", () => {
    const authorityId = "00000000-0000-4000-8000-0000000000d1";
    const userRow = row({
      workspace_id: null,
      authority_scope: "user",
      owner_organization_membership_id: owner,
      organization_user_resource_authority_id: authorityId,
      organization_user_resource_authority_generation: 1,
      last_refresh_at: new Date("2026-02-01T00:00:00Z"),
    });
    const personalRow = row({ workspace_id: personal });
    const authority = (active: boolean): CutoverLegacyAuthority => ({
      id: authorityId,
      accountId: account,
      membershipId: owner,
      resourceId: userRow.id,
      generation: 1,
      active,
    });
    // Verified and canonical: the generation transfers.
    const verified = plan([userRow, personalRow], {}, {}, { legacyAuthorities: [authority(true)] });
    expect(verified.connections[0]).toMatchObject({
      id: userRow.id,
      authorityGeneration: 1,
      userGenerationCarried: true,
    });
    // The revoked user row is not canonical-worthy proof: a Personal-workspace
    // row canonical at generation 1 must not be named by the old snapshot.
    const revoked = plan(
      [
        { ...userRow, last_refresh_at: null },
        { ...personalRow, last_refresh_at: new Date() },
      ],
      {},
      {},
      { legacyAuthorities: [authority(false)] },
    );
    expect(revoked.connections[0]).toMatchObject({
      id: personalRow.id,
      authorityGeneration: 1,
      userGenerationCarried: false,
    });
  });

  test("a Personal-workspace account becomes its owner's personal connection", () => {
    const [connection] = plan([row({ workspace_id: personal })]).connections;
    expect(connection).toMatchObject({
      ownership: "personal",
      ownerMembershipId: owner,
      ownerSubjectId: "user:owner",
      authorityGeneration: 1,
      authorityActive: true,
      scopeKind: "people",
      originWorkspaceId: personal,
    });
  });

  test("ambiguous identity, ownership, FedRAMP state or status abort with content-free classes", () => {
    const mismatch = row({ chatgpt_account_id: "column" });
    expect(plan([mismatch], { [mismatch.id]: "token" }).conflicts).toEqual([
      { accountId: account, conflictClass: "provider_identity_mismatch" },
    ]);
    const ambiguous = planCodexCutover({
      rows: [row({ workspace_id: personal })],
      identities: new Map(),
      workspaces,
      memberships: [
        ...memberships,
        {
          id: "00000000-0000-4000-8000-0000000000c2",
          accountId: account,
          subjectId: "user:x",
          active: true,
          personalWorkspaceId: personal,
        },
      ],
      legacyAuthorities: [],
    });
    expect(ambiguous.conflicts[0]!.conflictClass).toBe("personal_workspace_owner_ambiguous");
    expect(
      plan([row({ workspace_id: w1, is_fedramp: true }), row({ workspace_id: w2 })]).conflicts[0]!
        .conflictClass,
    ).toBe("fedramp_mismatch");
    expect(plan([row({ status: "revoked" })]).conflicts[0]!.conflictClass).toBe(
      "unrepresentable_status",
    );
  });

  test("rows without any identity are never merged", () => {
    const result = plan([
      row({ chatgpt_account_id: null, workspace_id: w1 }),
      row({ chatgpt_account_id: null, workspace_id: w1 }),
    ]);
    expect(result.connections).toHaveLength(2);
  });

  test("unknown quota stays unknown; stored exhaustion and live plan cooldowns are kept", () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const unknown = plan([row({})]).connections[0]!;
    expect(planCodexCutoverQuota(unknown, 3, now).observedRefreshGeneration).toBeNull();
    const cooled = plan([
      row({
        plan_entitlement_exclusion: {
          planType: "pro",
          models: [
            { modelId: "codex/live", excludedAt: "2026-02-28T12:00:00Z" },
            { modelId: "codex/expired", excludedAt: "2026-02-01T00:00:00Z" },
          ],
        },
      }),
    ]).connections[0]!;
    const quota = planCodexCutoverQuota(cooled, 3, now);
    expect(quota.observedRefreshGeneration).toBe(3);
    expect(quota.quota.modelCooldowns).toEqual({
      "codex/live": new Date("2026-03-01T12:00:00Z").getTime(),
    });
  });
});
