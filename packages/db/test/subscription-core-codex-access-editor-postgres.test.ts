import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  ensureManagedAccessForUser,
  getSubscriptionCoreCodexModelConnectionAccess,
  listSubscriptionCoreCodexServingConnections,
  ModelConnectionWorkspaceNotInOrganizationError,
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
  options: { managedByWorkspaceId?: string } = {},
): Promise<string> {
  const scope = options.managedByWorkspaceId ? "workspaces" : "organization";
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      allow_personal_workspaces, provider_account_id, plan_type, provider_state, expires_at,
      label, managed_by_workspace_id
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription',
      ${encryptEnvironmentValue(key, JSON.stringify({ access_token: label, refresh_token: label }))},
      'shared', ${scope}, ${!options.managedByWorkspaceId}, ${`chatgpt-${label}`}, 'pro',
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz,
      ${label}, ${options.managedByWorkspaceId ?? null}::uuid
    ) returning id::text as id`;
  if (options.managedByWorkspaceId) {
    await shared!.admin`insert into subscription_connection_workspaces
      (account_id, connection_id, workspace_id)
      values (${org.accountId}::uuid, ${row!.id}::uuid, ${options.managedByWorkspaceId}::uuid)`;
    await shared!.admin`insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool, managed_by_workspace_id
      ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${options.managedByWorkspaceId}::uuid,
        'workspace', ${options.managedByWorkspaceId}::uuid)`;
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
    from opengeni_private.subscription_codex_auto_assignments where connection_id = ${connectionId}::uuid`;
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
        (select allocator_enabled from opengeni_private.subscription_codex_auto_assignments
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
});
