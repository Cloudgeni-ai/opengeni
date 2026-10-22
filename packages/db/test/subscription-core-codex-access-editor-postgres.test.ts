import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  ensureManagedAccessForUser,
  getSubscriptionCoreCodexModelConnectionAccess,
  getSubscriptionCoreCodexWorkspaceProjection,
  getSubscriptionCoreOrganizationCodexAccount,
  listOrganizationAdministrationMembers,
  listSubscriptionCoreCodexServingConnections,
  ModelConnectionWorkspaceNotInOrganizationError,
  nestedPostgresSqlState,
  readSubscriptionCoreCodexModelConnectionAccess,
  renameSubscriptionCoreCodexConnection,
  SubscriptionCoreAccessInvalidError,
  SubscriptionCoreAccessPeopleUnlistableError,
  SubscriptionCoreAccessPersonNotInOrganizationError,
  setSubscriptionCoreCodexAllocator,
  updateSubscriptionCoreCodexModelConnectionAccess,
  type DbClient,
  type ModelConnectionTarget,
} from "../src";
import { withWorkspaceSubjectRls } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";

// Editing what a shared Codex connection serves after the drained cutover:
// the organization and workspace access editors write the core (connection
// scope, owner, workspace assignments and the reach kept for workspaces
// created later) and placement follows the saved choice (D-50).

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 47);
const MODEL = "codex/gpt-5.5";
const OTHER_MODEL = "codex/gpt-5.4";

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-codex-access-editor-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Org = {
  accountId: string;
  ownerSubjectId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
  otherWorkspaceId: string;
};

async function workspace(accountId: string, subjectId: string, name: string): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, ${name}) returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${row!.id}::uuid, ${subjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${row!.id}::uuid, ${accountId}::uuid)`;
  return row!.id;
}

async function organization(): Promise<Org> {
  const userId = `core-codex-access-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core Codex access fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await shared!.admin<{ personal_workspace_id: string }[]>`
    select personal_workspace_id::text as personal_workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  return {
    accountId,
    ownerSubjectId,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: await workspace(accountId, ownerSubjectId, "Shared A"),
    otherWorkspaceId: await workspace(accountId, ownerSubjectId, "Shared B"),
  };
}

async function connection(
  org: Org,
  label: string,
  /**
   * `managedByWorkspaceId`: a former workspace account (0689) the workspace
   * manages. `localWorkspaceId`: a workspace's own copy no workspace manages
   * (copies 0689 merged).
   */
  options: { managedByWorkspaceId?: string; localWorkspaceId?: string } = {},
): Promise<string> {
  const local = options.managedByWorkspaceId ?? options.localWorkspaceId;
  const scope = local ? "workspaces" : "organization";
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      allow_personal_workspaces, provider_account_id, plan_type, provider_state, expires_at,
      label, managed_by_workspace_id
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription',
      ${encryptEnvironmentValue(key, JSON.stringify({ access_token: label, refresh_token: label }))},
      'shared', ${scope}, ${!local}, ${`chatgpt-${label}`}, 'pro',
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz,
      ${label}, ${options.managedByWorkspaceId ?? null}::uuid
    ) returning id::text as id`;
  if (local) {
    await shared!.admin`insert into subscription_connection_workspaces
      (account_id, connection_id, workspace_id)
      values (${org.accountId}::uuid, ${row!.id}::uuid, ${local}::uuid)`;
  }
  return row!.id;
}

function organizationTarget(org: Org, connectionId: string): ModelConnectionTarget {
  return {
    kind: "codex",
    connectionId,
    accountId: org.accountId,
    workspaceId: null,
    subjectId: org.ownerSubjectId,
  };
}

async function stored(org: Org, connectionId: string) {
  const [row] = await shared!.admin<
    { scope_kind: string; allow_personal_workspaces: boolean; allowed_model_ids: string[] | null }[]
  >`select scope_kind, allow_personal_workspaces, allowed_model_ids from subscription_connections
    where account_id = ${org.accountId}::uuid and id = ${connectionId}::uuid`;
  const workspaces = await shared!.admin<{ workspace_id: string }[]>`
    select workspace_id::text as workspace_id from subscription_connection_workspaces
    where connection_id = ${connectionId}::uuid order by workspace_id`;
  const [reach] = await shared!.admin<
    {
      shared_workspaces: boolean;
      personal_workspaces: boolean;
      allowed_model_ids: string[] | null;
    }[]
  >`select shared_workspaces, personal_workspaces, allowed_model_ids
    from opengeni_private.subscription_core_auto_assignments where connection_id = ${connectionId}::uuid`;
  return {
    ...row!,
    workspaces: workspaces.map((entry) => entry.workspace_id),
    reach: reach ?? null,
  };
}

async function servedIn(org: Org, workspaceId: string, subjectId: string | null = null) {
  return (
    await listSubscriptionCoreCodexServingConnections(client!.db, {
      accountId: org.accountId,
      workspaceId,
      subjectId,
    })
  ).map((row) => row.connectionId);
}

describe.skipIf(!realDb)("Codex access editor on the shared core", () => {
  test("an organization account can be limited to chosen workspaces and models", async () => {
    const org = await organization();
    const id = await connection(org, "org-limited");
    const target = organizationTarget(org, id);
    const before = await getSubscriptionCoreCodexModelConnectionAccess(client!.db, target);
    expect(before).toEqual({
      allowedModels: null,
      allowedWorkspaces: null,
      allowPersonalWorkspaces: true,
      version: 1,
    });
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([id]);

    const saved = await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: [MODEL],
      allowedWorkspaces: [org.sharedWorkspaceId],
      allowPersonalWorkspaces: false,
      version: 1,
    });
    expect(saved).toEqual({
      allowedModels: [MODEL],
      allowedWorkspaces: [org.sharedWorkspaceId],
      allowPersonalWorkspaces: false,
      version: 2,
    });
    expect(await getSubscriptionCoreCodexModelConnectionAccess(client!.db, target)).toEqual(saved);
    const row = await stored(org, id);
    expect(row).toMatchObject({
      scope_kind: "workspaces",
      allow_personal_workspaces: false,
      allowed_model_ids: [MODEL],
      workspaces: [org.sharedWorkspaceId],
      reach: null,
    });
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
  });

  test("a stale version or a workspace outside the organization changes nothing", async () => {
    const org = await organization();
    const id = await connection(org, "org-stale");
    const target = organizationTarget(org, id);
    const policy = {
      allowedModels: null,
      allowedWorkspaces: [org.sharedWorkspaceId],
      allowPersonalWorkspaces: true,
      version: 1,
    };
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, policy),
    ).not.toBeNull();
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, policy),
    ).toBeNull();
    // A Personal workspace is not a shared workspace to choose.
    await expect(
      updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        ...policy,
        allowedWorkspaces: [org.personalWorkspaceId],
        version: 2,
      }),
    ).rejects.toBeInstanceOf(ModelConnectionWorkspaceNotInOrganizationError);
    expect((await getSubscriptionCoreCodexModelConnectionAccess(client!.db, target))?.version).toBe(
      2,
    );
  });

  test("a token refresh does not make a pending edit conflict", async () => {
    const org = await organization();
    const id = await connection(org, "org-refreshed");
    const target = organizationTarget(org, id);
    await shared!.admin`update subscription_connections set version = version + 1,
      refresh_generation = refresh_generation + 1 where id = ${id}::uuid`;
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        version: 1,
      }),
    ).toMatchObject({ allowedModels: [MODEL], version: 2 });
  });

  test("all shared workspaces, without Personal ones, keeps reaching workspaces created later", async () => {
    const org = await organization();
    const id = await connection(org, "org-shared-only");
    const target = organizationTarget(org, id);
    const saved = await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: [OTHER_MODEL],
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
      version: 1,
    });
    expect(saved).toEqual({
      allowedModels: [OTHER_MODEL],
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
      version: 2,
    });
    const row = await stored(org, id);
    expect(row.scope_kind).toBe("workspaces");
    expect(row.reach).toEqual({
      shared_workspaces: true,
      personal_workspaces: false,
      allowed_model_ids: [OTHER_MODEL],
    });
    expect(row.workspaces).toContain(org.sharedWorkspaceId);
    expect(row.workspaces).toContain(org.otherWorkspaceId);
    expect(row.workspaces).not.toContain(org.personalWorkspaceId);
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([]);

    const later = await workspace(org.accountId, org.ownerSubjectId, "Created later");
    expect(await servedIn(org, later)).toEqual([id]);
    expect((await stored(org, id)).workspaces).toContain(later);

    // Back to everywhere: organization scope, no leftover rows or reach.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        version: 2,
      }),
    ).toEqual({
      allowedModels: null,
      allowedWorkspaces: null,
      allowPersonalWorkspaces: true,
      version: 3,
    });
    expect(await stored(org, id)).toMatchObject({
      scope_kind: "organization",
      workspaces: [],
      reach: null,
    });
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([id]);
  });

  test("chosen workspaces plus Personal ones lists today's Personal workspaces and keeps the reach", async () => {
    const org = await organization();
    const id = await connection(org, "org-personal");
    const target = organizationTarget(org, id);
    const saved = await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: null,
      allowedWorkspaces: [org.otherWorkspaceId],
      allowPersonalWorkspaces: true,
      version: 1,
    });
    // The Personal workspace's assignment is storage, not a shared choice.
    expect(saved?.allowedWorkspaces).toEqual([org.otherWorkspaceId]);
    const row = await stored(org, id);
    expect(row.workspaces.sort()).toEqual([org.otherWorkspaceId, org.personalWorkspaceId].sort());
    expect(row.reach).toMatchObject({ shared_workspaces: false, personal_workspaces: true });
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([id]);
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([]);
  });

  test("widening a workspace's own account makes it the organization's; its own reach keeps it the workspace's", async () => {
    const org = await organization();
    const id = await connection(org, "own", { managedByWorkspaceId: org.sharedWorkspaceId });
    const manager = await member(org, "member", "admin");
    const owner = async () => {
      const [row] = await shared!.admin<{ managed_by_workspace_id: string | null }[]>`
        select managed_by_workspace_id::text as managed_by_workspace_id
        from subscription_connections where id = ${id}::uuid`;
      return row!.managed_by_workspace_id;
    };
    const target = organizationTarget(org, id);
    // Saving the reach it already has (only its workspace) keeps it the workspace's.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: [org.sharedWorkspaceId],
        allowPersonalWorkspaces: false,
        version: 1,
      }),
    ).toMatchObject({ allowedModels: [MODEL], version: 2 });
    expect(await owner()).toBe(org.sharedWorkspaceId);
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
    // Giving it to another workspace makes it the organization's: one owner,
    // used exactly where it reaches.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: [org.otherWorkspaceId, org.sharedWorkspaceId],
        allowPersonalWorkspaces: false,
        version: 2,
      }),
    ).toMatchObject({ version: 3 });
    expect(await owner()).toBeNull();
    const row = await stored(org, id);
    expect(row.workspaces.sort()).toEqual([org.otherWorkspaceId, org.sharedWorkspaceId].sort());
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([id]);
    // Its former workspace's administrators no longer manage it.
    expect(
      (
        await setSubscriptionCoreCodexAllocator(client!.db, {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
          subjectId: manager.subjectId,
          connectionId: id,
          enabled: false,
          expectedVersion: 1,
        })
      ).result,
    ).toEqual({ kind: "not_found" });
  });

  test("a workspace admin changes the models of the account their workspace manages", async () => {
    const org = await organization();
    const id = await connection(org, "local", { managedByWorkspaceId: org.sharedWorkspaceId });
    const adminSubjectId = `user:core-codex-access-ws-admin-${crypto.randomUUID()}`;
    const [personal] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${org.accountId}::uuid, 'Personal workspace')
      returning id::text as id`;
    await shared!.admin`insert into organization_memberships
      (account_id, subject_id, role, status, personal_workspace_id)
      values (${org.accountId}::uuid, ${adminSubjectId}, 'member', 'active', ${personal!.id}::uuid)`;
    await shared!
      .admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${adminSubjectId}, 'admin')`;
    const target: ModelConnectionTarget = {
      kind: "codex",
      connectionId: id,
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      subjectId: adminSubjectId,
    };
    expect(await getSubscriptionCoreCodexModelConnectionAccess(client!.db, target)).toEqual({
      allowedModels: null,
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
      version: 1,
    });
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: 1,
      }),
    ).toMatchObject({ allowedModels: [MODEL], version: 2 });
    expect(await stored(org, id)).toMatchObject({
      allowed_model_ids: [MODEL],
      workspaces: [org.sharedWorkspaceId],
    });
    // Its scope and other organization decisions stay organization-admin only.
    const refused = await withWorkspaceSubjectRls(
      client!.db,
      org.sharedWorkspaceId,
      adminSubjectId,
      (tx) =>
        tx.execute(sql`update subscription_connections set allow_personal_workspaces = true
          where id = ${id}::uuid`),
    ).then(
      () => null,
      (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
    );
    expect(refused).toMatch(/only organization administrators/);
  });

  test("one switch per account: off stops it everywhere it reaches, on resumes it", async () => {
    const org = await organization();
    const id = await connection(org, "org-switch");
    const target = organizationTarget(org, id);
    await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: null,
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
      version: 1,
    });
    const flip = async (enabled: boolean, expectedVersion: number) =>
      (
        await setSubscriptionCoreCodexAllocator(client!.db, {
          accountId: org.accountId,
          workspaceId: null,
          subjectId: org.ownerSubjectId,
          connectionId: id,
          enabled,
          expectedVersion,
        })
      ).result;
    expect(await flip(false, 1)).toMatchObject({ kind: "updated", allocatorEnabled: false });
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
    // A workspace created while it is off is reached, and served once it is on.
    const later = await workspace(org.accountId, org.ownerSubjectId, "Created while off");
    expect(await servedIn(org, later)).toEqual([]);
    expect(await flip(false, 2)).toMatchObject({ kind: "unchanged", allocatorEnabled: false });
    expect(await flip(true, 99)).toMatchObject({ kind: "conflict", allocatorEnabled: false });
    expect(await flip(true, 2)).toMatchObject({ kind: "updated", allocatorEnabled: true });
    for (const workspaceId of [org.sharedWorkspaceId, org.otherWorkspaceId, later])
      expect(await servedIn(org, workspaceId)).toEqual([id]);
    // No per-workspace copies exist to disagree with the connection's switch.
    const [policies] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_connection_assignment_policies
      where connection_id = ${id}::uuid`;
    expect(policies?.count).toBe(0);
  });

  test("a workspace's own account is switched on its workspace's route, not another's", async () => {
    const org = await organization();
    const id = await connection(org, "own-switch", { managedByWorkspaceId: org.sharedWorkspaceId });
    const manager = await member(org, "member", "admin");
    const flip = async (
      workspaceId: string | null,
      subjectId: string,
      enabled: boolean,
      expectedVersion: number,
    ) =>
      (
        await setSubscriptionCoreCodexAllocator(client!.db, {
          accountId: org.accountId,
          workspaceId,
          subjectId,
          connectionId: id,
          enabled,
          expectedVersion,
        })
      ).result;
    // The workspace's page lists it once, as the workspace's own.
    const ownPage = async () =>
      (
        await getSubscriptionCoreCodexWorkspaceProjection(client!.db, {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
        })
      ).accounts.filter((account) => account.id === id);
    expect(await ownPage()).toEqual([
      expect.objectContaining({ id, source: "workspace", allocatorEnabled: true }),
    ]);
    expect(await flip(org.sharedWorkspaceId, manager.subjectId, false, 1)).toMatchObject({
      kind: "updated",
      allocatorEnabled: false,
    });
    expect(await ownPage()).toEqual([expect.objectContaining({ allocatorEnabled: false })]);
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([]);
    // Another workspace's route cannot reach it, even for an organization administrator.
    expect(await flip(org.otherWorkspaceId, org.ownerSubjectId, true, 2)).toEqual({
      kind: "not_found",
    });
    // The organization's route can switch it (organization administrators manage everything).
    expect(await flip(null, org.ownerSubjectId, true, 2)).toMatchObject({
      kind: "updated",
      allocatorEnabled: true,
    });
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
  });

  test("an organization account is switched only on the organization's route", async () => {
    const org = await organization();
    const id = await connection(org, "org-route-only");
    const manager = await member(org, "member", "admin");
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    const flip = async (subjectId: string) =>
      await setSubscriptionCoreCodexAllocator(client!.db, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        subjectId,
        connectionId: id,
        enabled: false,
        expectedVersion: 1,
      });
    // A workspace page lists it read-only: its route refuses the switch, even
    // for an organization administrator, whose switch is on the organization's page.
    expect((await flip(org.ownerSubjectId)).result).toEqual({ kind: "not_found" });
    expect((await flip(manager.subjectId)).result).toEqual({ kind: "not_found" });
    const [row] = await shared!.admin<{ allocator_enabled: boolean; allocator_version: number }[]>`
      select allocator_enabled, allocator_version from subscription_connections
      where id = ${id}::uuid`;
    expect(row).toEqual({ allocator_enabled: true, allocator_version: 1 });
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
  });

  test("the organization route renames a workspace-managed account and reads it back", async () => {
    const org = await organization();
    const id = await connection(org, "managed-label", {
      managedByWorkspaceId: org.sharedWorkspaceId,
    });
    const orgAdmin = { accountId: org.accountId, workspaceId: null, subjectId: org.ownerSubjectId };
    expect(
      await renameSubscriptionCoreCodexConnection(client!.db, {
        ...orgAdmin,
        connectionId: id,
        label: "Renamed by the organization",
      }),
    ).toBe(id);
    // Not in the organization's list (the Accounts page change lists it), so
    // the route reads the renamed account itself, with the organization's switch.
    const read = () =>
      getSubscriptionCoreOrganizationCodexAccount(client!.db, {
        organizationId: org.accountId,
        subjectId: org.ownerSubjectId,
        connectionId: id,
      });
    expect(await read()).toMatchObject({
      id,
      label: "Renamed by the organization",
      allocatorEnabled: true,
    });
    await shared!.admin`update subscription_connections set allocator_enabled = false
      where id = ${id}::uuid`;
    expect(await read()).toMatchObject({ id, allocatorEnabled: false });
    // A workspace member is no organization administrator: nothing.
    const outsider = await member(org);
    expect(
      await getSubscriptionCoreOrganizationCodexAccount(client!.db, {
        organizationId: org.accountId,
        subjectId: outsider.subjectId,
        connectionId: id,
      }),
    ).toBeNull();
  });
});

async function member(org: Org, role: "admin" | "member" = "member", workspaceRole?: "admin") {
  const subjectId = `user:core-codex-access-member-${crypto.randomUUID()}`;
  const [personal] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${org.accountId}::uuid, 'Personal workspace')
    returning id::text as id`;
  const [membership] = await shared!.admin<{ id: string }[]>`
    insert into organization_memberships
      (account_id, subject_id, role, status, personal_workspace_id)
    values (${org.accountId}::uuid, ${subjectId}, ${role}, 'active', ${personal!.id}::uuid)
    returning id::text as id`;
  if (workspaceRole)
    await shared!
      .admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${subjectId}, ${workspaceRole})`;
  return { subjectId, membershipId: membership!.id, personalWorkspaceId: personal!.id };
}

async function personalConnection(org: Org, owner: { subjectId: string; membershipId: string }) {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await shared!.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (${authorityId}::uuid, ${org.accountId}::uuid, ${owner.membershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, 1, 'active')`;
  await shared!.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state
    ) values (${connectionId}::uuid, ${org.accountId}::uuid, 'codex',
      ${encryptEnvironmentValue(key, JSON.stringify({ access_token: connectionId }))},
      'personal', 'people', ${owner.membershipId}::uuid, ${owner.subjectId},
      ${authorityId}::uuid, 'subscription_connection', 1, ${`chatgpt-${connectionId}`},
      ${shared!.admin.json({ isFedramp: false })}::jsonb)`;
  return connectionId;
}

/** Every subscription row of the organization, in every table that carries one. */
async function coreSnapshot(accountId: string) {
  const tables = await shared!.admin<{ schema: string; name: string }[]>`
    select table_schema as schema, table_name as name from information_schema.columns
    where column_name = 'account_id' and table_name like 'subscription%'
      and table_schema in (current_schema(), 'opengeni_private')
    order by table_schema, table_name`;
  const snapshot: Record<string, unknown> = {};
  for (const table of tables) {
    const [row] = await shared!.admin.unsafe<{ rows: unknown }[]>(
      `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) as rows
       from "${table.schema}"."${table.name}" t where t.account_id = $1::uuid`,
      [accountId],
    );
    snapshot[`${table.schema}.${table.name}`] = row!.rows;
  }
  return snapshot;
}

describe.skipIf(!realDb)("Workspace-managed Codex accounts are organization accounts", () => {
  test("the runtime role is neither superuser nor able to bypass row-level security", async () => {
    const [role] = await client!.db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  test("a workspace's own account reads as its reach and serves only that workspace", async () => {
    const org = await organization();
    const id = await connection(org, "former", { managedByWorkspaceId: org.sharedWorkspaceId });
    const access = await readSubscriptionCoreCodexModelConnectionAccess(
      client!.db,
      organizationTarget(org, id),
    );
    expect(access).toEqual({
      policy: {
        allowedModels: null,
        allowedWorkspaces: [org.sharedWorkspaceId],
        allowPersonalWorkspaces: false,
        allowedPeople: null,
        version: 1,
      },
      localWorkspaceIds: [org.sharedWorkspaceId],
      managedByWorkspaceId: org.sharedWorkspaceId,
      peopleSupported: false,
    });
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([]);
  });

  test("an organization administrator gives it to chosen workspaces, all of them, and back", async () => {
    const org = await organization();
    const id = await connection(org, "granted", { managedByWorkspaceId: org.sharedWorkspaceId });
    const target = organizationTarget(org, id);
    const [credentialBefore] = await shared!.admin<{ credential_encrypted: string }[]>`
      select credential_encrypted from subscription_connections where id = ${id}::uuid`;

    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: [org.otherWorkspaceId],
        allowPersonalWorkspaces: false,
        version: 1,
      }),
    ).toEqual({
      allowedModels: [MODEL],
      allowedWorkspaces: [org.otherWorkspaceId],
      allowPersonalWorkspaces: false,
      version: 2,
    });
    // It now reaches exactly the chosen workspace, as the organization's.
    expect(await stored(org, id)).toMatchObject({
      scope_kind: "workspaces",
      allowed_model_ids: [MODEL],
      workspaces: [org.otherWorkspaceId],
      reach: null,
    });
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([]);

    // Every shared workspace, including later ones.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: 2,
      }),
    ).toMatchObject({ allowedWorkspaces: null, version: 3 });
    expect((await stored(org, id)).reach).toMatchObject({
      shared_workspaces: true,
      personal_workspaces: false,
    });
    const later = await workspace(org.accountId, org.ownerSubjectId, "Created later");
    expect(await servedIn(org, later)).toEqual([id]);
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([]);

    // The whole organization.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        version: 3,
      }),
    ).toMatchObject({ allowedWorkspaces: null, allowPersonalWorkspaces: true, version: 4 });
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([id]);

    // Back to only its first workspace: it stays the organization's.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: [org.sharedWorkspaceId],
        allowPersonalWorkspaces: false,
        version: 4,
      }),
    ).toMatchObject({ allowedWorkspaces: [org.sharedWorkspaceId], version: 5 });
    expect(await stored(org, id)).toMatchObject({
      scope_kind: "workspaces",
      allow_personal_workspaces: false,
      workspaces: [org.sharedWorkspaceId],
      reach: null,
    });
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
    const [after] = await shared!.admin<
      { credential_encrypted: string; managed_by_workspace_id: string | null }[]
    >`select credential_encrypted, managed_by_workspace_id::text as managed_by_workspace_id
      from subscription_connections where id = ${id}::uuid`;
    expect(after).toEqual({
      credential_encrypted: credentialBefore!.credential_encrypted,
      managed_by_workspace_id: null,
    });
  });

  test("a workspace's delegated managers keep it: people scope is refused while a workspace manages it", async () => {
    const org = await organization();
    const id = await connection(org, "managed", { managedByWorkspaceId: org.sharedWorkspaceId });
    const target = organizationTarget(org, id);
    const person = await member(org);
    expect(
      (await readSubscriptionCoreCodexModelConnectionAccess(client!.db, target))?.peopleSupported,
    ).toBe(false);
    await expect(
      updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: [person.membershipId],
        version: 1,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCoreAccessInvalidError);
    expect(await stored(org, id)).toMatchObject({
      scope_kind: "workspaces",
      workspaces: [org.sharedWorkspaceId],
      reach: null,
    });
    const [chosen] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_connection_people where connection_id = ${id}::uuid`;
    expect(chosen?.count).toBe(0);
  });

  test("chosen people: active members only, workspaces cleared, and an older form cannot replace them", async () => {
    const org = await organization();
    // A workspace's own copy that no workspace manages (copies 0689 merged).
    const id = await connection(org, "people", { localWorkspaceId: org.sharedWorkspaceId });
    const target = organizationTarget(org, id);
    expect(
      (await readSubscriptionCoreCodexModelConnectionAccess(client!.db, target))?.peopleSupported,
    ).toBe(true);
    const person = await member(org);
    const [owner] = await shared!.admin<{ id: string }[]>`
      select id::text as id from organization_memberships
      where account_id = ${org.accountId}::uuid and subject_id = ${org.ownerSubjectId}`;
    await expect(
      updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: [org.otherWorkspaceId],
        allowPersonalWorkspaces: false,
        allowedPeople: [person.membershipId],
        version: 1,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCoreAccessInvalidError);
    const left = await member(org);
    await shared!.admin`update organization_memberships set status = 'revoked', revoked_at = now()
      where id = ${left.membershipId}::uuid`;
    await expect(
      updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: [left.membershipId],
        version: 1,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCoreAccessPersonNotInOrganizationError);
    await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: null,
      allowedWorkspaces: [org.otherWorkspaceId],
      allowPersonalWorkspaces: false,
      version: 1,
    });

    const people = [person.membershipId, owner!.id].sort();
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: people,
        version: 2,
      }),
    ).toEqual({
      allowedModels: null,
      allowedWorkspaces: [],
      allowPersonalWorkspaces: false,
      allowedPeople: people,
      version: 3,
    });
    const row = await stored(org, id);
    expect(row).toMatchObject({
      scope_kind: "people",
      allow_personal_workspaces: false,
      reach: null,
    });
    // People scope reaches no workspace.
    expect(row.workspaces).toEqual([]);
    const [peopleRow] = await shared!.admin<{ chosen: string[] }[]>`
      select array_agg(organization_membership_id::text order by organization_membership_id) as chosen
      from subscription_connection_people where connection_id = ${id}::uuid`;
    expect(peopleRow?.chosen).toEqual(people);
    // The catalog (no session owner) never lists a people-scoped account.
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);

    // A form that never saw people is a stale form.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        version: 3,
      }),
    ).toBeNull();
    expect((await stored(org, id)).scope_kind).toBe("people");
    // A person who left may stay chosen; they are not served (memberships must be active).
    await shared!.admin`update organization_memberships set status = 'revoked', revoked_at = now()
      where id = ${person.membershipId}::uuid`;
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: people,
        version: 3,
      }),
    ).toMatchObject({ allowedPeople: people, version: 4 });
    // Back to workspaces: people are removed.
    await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: null,
      allowedWorkspaces: [org.otherWorkspaceId],
      allowPersonalWorkspaces: false,
      allowedPeople: null,
      version: 4,
    });
    const [remaining] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_connection_people where connection_id = ${id}::uuid`;
    expect(remaining?.count).toBe(0);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([id]);
  });

  test("above the member list's bound, chosen people stay editable but no one can be added", async () => {
    const org = await organization();
    const id = await connection(org, "bounded-people");
    const target = organizationTarget(org, id);
    const person = await member(org);
    await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: null,
      allowedWorkspaces: [],
      allowPersonalWorkspaces: false,
      allowedPeople: [person.membershipId],
      version: 1,
    });
    const newcomer = await member(org);
    // Revoked memberships count toward the member list's bound (1000).
    await shared!.admin`
      insert into organization_memberships (account_id, subject_id, role, status, revoked_at)
      select ${org.accountId}::uuid, 'user:bounded-' || ${id} || '-' || n, 'member', 'revoked', now()
      from generate_series(1, 1001) n`;
    // The real refusal is SQLSTATE 54000 from the database, which the
    // organization editor's read treats as "people not offered".
    const refusal = await listOrganizationAdministrationMembers(client!.db, {
      organizationId: org.accountId,
      actorSubjectId: org.ownerSubjectId,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(nestedPostgresSqlState(refusal)).toBe("54000");

    // Models change with the people already chosen.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: [person.membershipId],
        version: 2,
      }),
    ).toMatchObject({ allowedModels: [MODEL], allowedPeople: [person.membershipId], version: 3 });
    // Adding someone needs the member list: refused, nothing written.
    await expect(
      updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: [person.membershipId, newcomer.membershipId],
        version: 3,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCoreAccessPeopleUnlistableError);
    const chosen = await shared!.admin<{ membership_id: string }[]>`
      select organization_membership_id::text as membership_id
      from subscription_connection_people where connection_id = ${id}::uuid`;
    expect(chosen.map((row) => row.membership_id)).toEqual([person.membershipId]);
    expect((await stored(org, id)).allowed_model_ids).toEqual([MODEL]);
    // Back to workspaces still works.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        allowedPeople: null,
        version: 3,
      }),
    ).toMatchObject({ allowedWorkspaces: null, allowPersonalWorkspaces: true, version: 4 });
    expect((await stored(org, id)).scope_kind).toBe("organization");
  });

  test("workspace admins and members gain nothing", async () => {
    const org = await organization();
    const id = await connection(org, "manager", { managedByWorkspaceId: org.sharedWorkspaceId });
    const manager = await member(org, "member", "admin");
    const plain = await member(org);
    for (const subjectId of [manager.subjectId, plain.subjectId]) {
      const target = { ...organizationTarget(org, id), subjectId };
      await expect(
        readSubscriptionCoreCodexModelConnectionAccess(client!.db, target),
      ).rejects.toThrow();
      await expect(
        updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
          allowedModels: null,
          allowedWorkspaces: null,
          allowPersonalWorkspaces: true,
          version: 1,
        }),
      ).rejects.toThrow();
    }
    // The manager keeps exactly the workspace route: models only.
    const workspaceTarget: ModelConnectionTarget = {
      kind: "codex",
      connectionId: id,
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      subjectId: manager.subjectId,
    };
    expect(
      await readSubscriptionCoreCodexModelConnectionAccess(client!.db, workspaceTarget),
    ).toEqual({
      policy: {
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        allowedPeople: null,
        version: 1,
      },
      localWorkspaceIds: [],
      managedByWorkspaceId: null,
      peopleSupported: false,
    });
    await expect(
      updateSubscriptionCoreCodexModelConnectionAccess(client!.db, workspaceTarget, {
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        allowedPeople: [manager.membershipId],
        version: 1,
      }),
    ).rejects.toBeInstanceOf(SubscriptionCoreAccessInvalidError);
    const refusals = await withWorkspaceSubjectRls(
      client!.db,
      org.sharedWorkspaceId,
      manager.subjectId,
      async (tx) => {
        const attempts = [
          sql`select opengeni_private.set_subscription_core_reach('codex',
            ${org.accountId}::uuid, ${id}::uuid, true, true)`,
          sql`update subscription_connections set scope_kind = 'organization' where id = ${id}::uuid`,
          sql`insert into subscription_connection_people
            (account_id, connection_id, organization_membership_id)
            values (${org.accountId}::uuid, ${id}::uuid, ${manager.membershipId}::uuid)`,
          sql`insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
            values (${org.accountId}::uuid, ${id}::uuid, ${org.otherWorkspaceId}::uuid)`,
        ];
        const messages: string[] = [];
        for (const attempt of attempts) {
          try {
            await tx.transaction(async (savepoint) => {
              await savepoint.execute(attempt);
            });
            messages.push("allowed");
          } catch {
            messages.push("refused");
          }
        }
        return messages;
      },
    );
    expect(refusals).toEqual(["refused", "refused", "refused", "refused"]);
    expect(await stored(org, id)).toMatchObject({
      scope_kind: "workspaces",
      workspaces: [org.sharedWorkspaceId],
      reach: null,
    });
    // Neither a member's own Personal workspace nor another workspace is served.
    expect(await servedIn(org, plain.personalWorkspaceId, plain.subjectId)).toEqual([]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
  });

  test("personal connections and Personal-workspace-managed rows stay outside the organization editor", async () => {
    const org = await organization();
    const owner = await member(org);
    const personal = await personalConnection(org, owner);
    const strayed = await connection(org, "personal-managed", {
      managedByWorkspaceId: org.personalWorkspaceId,
    });
    const before = await coreSnapshot(org.accountId);
    for (const id of [personal, strayed]) {
      const target = organizationTarget(org, id);
      expect(await readSubscriptionCoreCodexModelConnectionAccess(client!.db, target)).toBeNull();
      expect(
        await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
          allowedModels: null,
          allowedWorkspaces: null,
          allowPersonalWorkspaces: true,
          version: 1,
        }),
      ).toBeNull();
    }
    expect(await coreSnapshot(org.accountId)).toEqual(before);
  });
});
