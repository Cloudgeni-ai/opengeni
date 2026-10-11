import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  ensureManagedAccessForUser,
  getSubscriptionCoreCodexModelConnectionAccess,
  listOrganizationAdministrationMembers,
  listSubscriptionCoreCodexServingConnections,
  ModelConnectionWorkspaceNotInOrganizationError,
  nestedPostgresSqlState,
  readSubscriptionCoreCodexModelConnectionAccess,
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
// scope, workspace assignments, organization-pool rows and the reach kept for
// workspaces created later) and placement follows the saved choice.

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
    await shared!.admin`insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool, managed_by_workspace_id
      ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${local}::uuid,
        'workspace', ${options.managedByWorkspaceId ?? null}::uuid)`;
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
  const policies = await shared!.admin<
    { workspace_id: string; inference_pool: string; allowed_model_ids: string[] | null }[]
  >`select workspace_id::text as workspace_id, inference_pool, allowed_model_ids
    from subscription_connection_assignment_policies
    where connection_id = ${connectionId}::uuid order by workspace_id, inference_pool`;
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
    policies: [...policies],
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
      policies: [
        {
          workspace_id: org.sharedWorkspaceId,
          inference_pool: "organization",
          allowed_model_ids: [MODEL],
        },
      ],
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
    expect((await stored(org, id)).policies).toContainEqual({
      workspace_id: later,
      inference_pool: "organization",
      allowed_model_ids: [OTHER_MODEL],
    });

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
      policies: [],
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

  test("a workspace's own copy survives organization edits and both pools follow the models", async () => {
    const org = await organization();
    const id = await connection(org, "org-with-local");
    await shared!.admin`insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool, managed_by_workspace_id
      ) values (${org.accountId}::uuid, ${id}::uuid, ${org.sharedWorkspaceId}::uuid,
        'workspace', ${org.sharedWorkspaceId}::uuid)`;
    await shared!.admin`insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool
      ) values (${org.accountId}::uuid, ${id}::uuid, ${org.sharedWorkspaceId}::uuid, 'organization')`;
    const target = organizationTarget(org, id);
    const saved = await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: [MODEL],
      allowedWorkspaces: [org.otherWorkspaceId],
      allowPersonalWorkspaces: false,
      version: 1,
    });
    // The local copy's workspace stays assigned, but is not an organization choice.
    expect(saved?.allowedWorkspaces).toEqual([org.otherWorkspaceId]);
    const row = await stored(org, id);
    expect([...row.policies]).toEqual(
      [
        {
          workspace_id: org.otherWorkspaceId,
          inference_pool: "organization",
          allowed_model_ids: [MODEL],
        },
        {
          workspace_id: org.sharedWorkspaceId,
          inference_pool: "workspace",
          allowed_model_ids: null,
        },
      ].sort((a, b) => (a.workspace_id < b.workspace_id ? -1 : 1)),
    );
    expect(row.workspaces.sort()).toEqual([org.otherWorkspaceId, org.sharedWorkspaceId].sort());
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
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
      policies: [
        {
          workspace_id: org.sharedWorkspaceId,
          inference_pool: "workspace",
          allowed_model_ids: [MODEL],
        },
      ],
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

  test("an organization rotation switch also switches its organization-pool copies", async () => {
    const org = await organization();
    const id = await connection(org, "org-rotation");
    const target = organizationTarget(org, id);
    await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: null,
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
      version: 1,
    });
    const off = await setSubscriptionCoreCodexAllocator(client!.db, {
      accountId: org.accountId,
      workspaceId: null,
      subjectId: org.ownerSubjectId,
      connectionId: id,
      enabled: false,
      expectedVersion: 1,
    });
    expect(off.result.kind).toBe("updated");
    const [copies] = await shared!.admin<{ enabled: boolean[]; reach: boolean }[]>`
      select array_agg(distinct policy.allocator_enabled) as enabled,
        (select allocator_enabled from opengeni_private.subscription_core_auto_assignments
          where connection_id = ${id}::uuid) as reach
      from subscription_connection_assignment_policies policy
      where policy.connection_id = ${id}::uuid and policy.inference_pool = 'organization'`;
    expect(copies).toEqual({ enabled: [false], reach: false });
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([]);
    const on = await setSubscriptionCoreCodexAllocator(client!.db, {
      accountId: org.accountId,
      workspaceId: null,
      subjectId: org.ownerSubjectId,
      connectionId: id,
      enabled: true,
      expectedVersion: 2,
    });
    expect(on.result.kind).toBe("updated");
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
  });

  test("the organization and the managing workspace flip one rotation switch and one model list", async () => {
    const org = await organization();
    const id = await connection(org, "one-switch", { managedByWorkspaceId: org.sharedWorkspaceId });
    const admin = await member(org, "member", "admin");
    await updateSubscriptionCoreCodexModelConnectionAccess(
      client!.db,
      organizationTarget(org, id),
      {
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: 1,
      },
    );
    const flip = async (from: "organization" | "workspace", enabled: boolean, version: number) =>
      await setSubscriptionCoreCodexAllocator(client!.db, {
        accountId: org.accountId,
        workspaceId: from === "organization" ? null : org.sharedWorkspaceId,
        subjectId: from === "organization" ? org.ownerSubjectId : admin.subjectId,
        connectionId: id,
        enabled,
        expectedVersion: version,
      });
    const copies = async () => {
      const [row] = await shared!.admin<
        { connection: boolean; policies: boolean[]; reach: boolean; models: string[] }[]
      >`select connection.allocator_enabled as connection,
          (select array_agg(distinct policy.allocator_enabled)
            from subscription_connection_assignment_policies policy
            where policy.connection_id = connection.id) as policies,
          (select auto.allocator_enabled from opengeni_private.subscription_core_auto_assignments auto
            where auto.connection_id = connection.id) as reach,
          (select array_agg(distinct coalesce(array_to_string(models.allowed_model_ids, ','), 'all'))
            from (select policy.allowed_model_ids from subscription_connection_assignment_policies policy
                where policy.connection_id = connection.id
              union all select connection.allowed_model_ids
              union all select auto.allowed_model_ids
                from opengeni_private.subscription_core_auto_assignments auto
                where auto.connection_id = connection.id) models) as models
        from subscription_connections connection where connection.id = ${id}::uuid`;
      return row!;
    };
    const served = async () => ({
      own: await servedIn(org, org.sharedWorkspaceId),
      other: await servedIn(org, org.otherWorkspaceId),
    });
    expect(await served()).toEqual({ own: [id], other: [id] });

    // The organization switches it off, then the managing workspace on.
    expect((await flip("organization", false, 1)).result.kind).toBe("updated");
    expect(await copies()).toMatchObject({ connection: false, policies: [false], reach: false });
    expect(await served()).toEqual({ own: [], other: [] });
    expect((await flip("workspace", true, 2)).result.kind).toBe("updated");
    expect(await copies()).toMatchObject({ connection: true, policies: [true], reach: true });
    expect(await served()).toEqual({ own: [id], other: [id] });
    // The managing workspace switches it off, then the organization on.
    expect((await flip("workspace", false, 3)).result.kind).toBe("updated");
    expect(await copies()).toMatchObject({ connection: false, policies: [false], reach: false });
    expect(await served()).toEqual({ own: [], other: [] });
    expect((await flip("organization", true, 4)).result.kind).toBe("updated");
    expect(await copies()).toMatchObject({ connection: true, policies: [true], reach: true });
    expect(await served()).toEqual({ own: [id], other: [id] });

    // Models: one list, whichever editor saves it.
    await updateSubscriptionCoreCodexModelConnectionAccess(
      client!.db,
      organizationTarget(org, id),
      {
        allowedModels: [MODEL],
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: 2,
      },
    );
    expect((await copies()).models).toEqual([MODEL]);
    await updateSubscriptionCoreCodexModelConnectionAccess(
      client!.db,
      {
        ...organizationTarget(org, id),
        workspaceId: org.sharedWorkspaceId,
        subjectId: admin.subjectId,
      },
      {
        allowedModels: [OTHER_MODEL],
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: 3,
      },
    );
    expect((await copies()).models).toEqual([OTHER_MODEL]);

    // Copies an older release left disagreeing are repaired by flipping the
    // switch to the value it shows, from either side.
    await shared!.admin`update subscription_connection_assignment_policies
      set allocator_enabled = false where connection_id = ${id}::uuid and inference_pool = 'organization'`;
    expect((await served()).other).toEqual([]);
    const repaired = await flip("organization", true, 5);
    expect(repaired.result.kind).toBe("unchanged");
    expect(repaired.wake).not.toBeNull();
    expect(await copies()).toMatchObject({ connection: true, policies: [true], reach: true });
    expect((await served()).other).toEqual([id]);
    await shared!.admin`update subscription_connection_assignment_policies
      set allocator_enabled = false where connection_id = ${id}::uuid and inference_pool = 'organization'`;
    expect((await flip("workspace", true, 5)).result.kind).toBe("unchanged");
    expect(await copies()).toMatchObject({ policies: [true] });
    // A consistent account repairs nothing and wakes no one.
    expect((await flip("organization", true, 5)).wake).toBeNull();
    // Someone who may not manage it is refused, as before, and changes nothing.
    const outsider = await member(org);
    const refused = await setSubscriptionCoreCodexAllocator(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      subjectId: outsider.subjectId,
      connectionId: id,
      enabled: true,
      expectedVersion: 5,
    }).catch((error: unknown) => error);
    expect(refused).toBeDefined();
    expect(await copies()).toMatchObject({ connection: true, policies: [true], reach: true });
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

async function source(
  org: Org,
  workspaceId: string,
  inferenceSource: "workspace" | "organization" | "automatic",
) {
  await shared!.admin`delete from subscription_settings
    where account_id = ${org.accountId}::uuid and workspace_id = ${workspaceId}::uuid`;
  // Automatic is the absence of a saved choice.
  if (inferenceSource === "automatic") return;
  await shared!.admin`insert into subscription_settings (account_id, workspace_id, providers)
    values (${org.accountId}::uuid, ${workspaceId}::uuid,
      ${shared!.admin.json({ codex: { inferenceSource } })}::jsonb)`;
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

  test("a former workspace account reads as its current reach and serves the same sources", async () => {
    const org = await organization();
    const id = await connection(org, "former", { managedByWorkspaceId: org.sharedWorkspaceId });
    const access = await readSubscriptionCoreCodexModelConnectionAccess(
      client!.db,
      organizationTarget(org, id),
    );
    expect(access).toEqual({
      policy: {
        allowedModels: null,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: null,
        version: 1,
      },
      localWorkspaceIds: [org.sharedWorkspaceId],
      managedByWorkspaceId: org.sharedWorkspaceId,
      peopleSupported: false,
    });
    // Explicit sources select exactly what they selected before any edit.
    await source(org, org.sharedWorkspaceId, "workspace");
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    await source(org, org.sharedWorkspaceId, "organization");
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([]);
    await source(org, org.otherWorkspaceId, "organization");
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([]);
  });

  test("an organization administrator gives it to chosen workspaces, all of them, and back", async () => {
    const org = await organization();
    const id = await connection(org, "granted", { managedByWorkspaceId: org.sharedWorkspaceId });
    const target = organizationTarget(org, id);
    const [credentialBefore] = await shared!.admin<{ credential_encrypted: string }[]>`
      select credential_encrypted from subscription_connections where id = ${id}::uuid`;
    await source(org, org.sharedWorkspaceId, "workspace");
    await source(org, org.otherWorkspaceId, "organization");

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
    expect(await stored(org, id)).toMatchObject({
      scope_kind: "workspaces",
      workspaces: [org.otherWorkspaceId, org.sharedWorkspaceId].sort(),
      reach: null,
    });
    // One model list: the managing workspace's own copy follows it too.
    expect((await stored(org, id)).policies).toContainEqual({
      workspace_id: org.sharedWorkspaceId,
      inference_pool: "workspace",
      allowed_model_ids: [MODEL],
    });
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);

    // Every shared workspace, including later ones: the reach helper accepts it now.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: [MODEL],
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: 2,
      }),
    ).toMatchObject({ allowedWorkspaces: null, version: 3 });
    expect((await stored(org, id)).reach).toEqual({
      shared_workspaces: true,
      personal_workspaces: false,
      allowed_model_ids: [MODEL],
    });
    const later = await workspace(org.accountId, org.ownerSubjectId, "Created later");
    expect(await servedIn(org, later)).toEqual([id]);
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([]);

    // The whole organization; the managing workspace keeps its own copy.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        version: 3,
      }),
    ).toMatchObject({ allowedWorkspaces: null, allowPersonalWorkspaces: true, version: 4 });
    const everywhere = await stored(org, id);
    expect(everywhere).toMatchObject({ scope_kind: "organization", reach: null });
    expect(everywhere.policies).toEqual([
      {
        workspace_id: org.sharedWorkspaceId,
        inference_pool: "organization",
        allowed_model_ids: null,
      },
      { workspace_id: org.sharedWorkspaceId, inference_pool: "workspace", allowed_model_ids: null },
    ]);
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([id]);

    // Back to only its workspace: exactly the original shape.
    expect(
      await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
        allowedModels: null,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        version: 4,
      }),
    ).toMatchObject({ allowedWorkspaces: [], version: 5 });
    expect(await stored(org, id)).toMatchObject({
      scope_kind: "workspaces",
      allow_personal_workspaces: false,
      workspaces: [org.sharedWorkspaceId],
      policies: [
        {
          workspace_id: org.sharedWorkspaceId,
          inference_pool: "workspace",
          allowed_model_ids: null,
        },
      ],
      reach: null,
    });
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
    const [after] = await shared!.admin<
      { credential_encrypted: string; managed_by_workspace_id: string }[]
    >`select credential_encrypted, managed_by_workspace_id::text as managed_by_workspace_id
      from subscription_connections where id = ${id}::uuid`;
    expect(after).toEqual({
      credential_encrypted: credentialBefore!.credential_encrypted,
      managed_by_workspace_id: org.sharedWorkspaceId,
    });
  });

  test("an older own copy without policy rows survives every organization save", async () => {
    const org = await organization();
    const id = await connection(org, "plain", { managedByWorkspaceId: org.sharedWorkspaceId });
    // An older shape: the managing workspace's assignment without policy rows.
    await shared!.admin`delete from subscription_connection_assignment_policies
      where connection_id = ${id}::uuid`;
    const target = organizationTarget(org, id);
    await source(org, org.sharedWorkspaceId, "workspace");
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(
      (await readSubscriptionCoreCodexModelConnectionAccess(client!.db, target))?.localWorkspaceIds,
    ).toEqual([org.sharedWorkspaceId]);

    for (const [version, choice] of [
      [1, { allowedWorkspaces: [org.otherWorkspaceId], allowPersonalWorkspaces: false }],
      [2, { allowedWorkspaces: [org.sharedWorkspaceId], allowPersonalWorkspaces: false }],
      [3, { allowedWorkspaces: null, allowPersonalWorkspaces: false }],
      [4, { allowedWorkspaces: null, allowPersonalWorkspaces: true }],
      [5, { allowedWorkspaces: [], allowPersonalWorkspaces: false }],
    ] as const) {
      expect(
        await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
          allowedModels: null,
          ...choice,
          allowedWorkspaces: choice.allowedWorkspaces ? [...choice.allowedWorkspaces] : null,
          version,
        }),
      ).toMatchObject({ version: version + 1 });
      const state = await stored(org, id);
      // The own copy keeps its assignment and stays policy-free, so placement
      // still reads it as the workspace's own.
      expect(state.workspaces).toContain(org.sharedWorkspaceId);
      expect(state.policies.filter((row) => row.workspace_id === org.sharedWorkspaceId)).toEqual(
        [],
      );
      expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    }
  });

  test("automatic source mode keeps the workspace's own copy and follows the organization's reach", async () => {
    const org = await organization();
    const id = await connection(org, "automatic", { managedByWorkspaceId: org.sharedWorkspaceId });
    const target = organizationTarget(org, id);
    await source(org, org.sharedWorkspaceId, "automatic");
    await source(org, org.otherWorkspaceId, "automatic");
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);

    await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: null,
      allowedWorkspaces: [org.otherWorkspaceId],
      allowPersonalWorkspaces: false,
      version: 1,
    });
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([]);

    await updateSubscriptionCoreCodexModelConnectionAccess(client!.db, target, {
      allowedModels: null,
      allowedWorkspaces: [],
      allowPersonalWorkspaces: false,
      version: 2,
    });
    expect(await servedIn(org, org.sharedWorkspaceId)).toEqual([id]);
    expect(await servedIn(org, org.otherWorkspaceId)).toEqual([]);
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
    // No organization-pool row is left; the workspace's own copy stays.
    expect(row.policies).toEqual([
      { workspace_id: org.sharedWorkspaceId, inference_pool: "workspace", allowed_model_ids: null },
    ]);
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
          sql`select opengeni_private.set_subscription_codex_reach(
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
