import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Permission } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  ensureManagedAccessForUser,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getSelfServiceOrganizationOnboardingState,
  listWorkspacesForSubject,
  managedPersonalWorkspacePermissions,
  nestedPostgresSqlState,
  resolveNamedManagedPersonalWorkspaceGrant,
  setRlsContext,
  type DbClient,
} from "../src";
import { rawRows, type Database } from "../src/database";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0219_organization_tenancy_managed_human_provisioning.sql",
);
const posturePath = join(dirname(fileURLToPath(import.meta.url)), "../src/runtime-posture.ts");
const provisionerPath = join(dirname(fileURLToPath(import.meta.url)), "../src/provision-roles.ts");
const tenancyTables = [
  "organization_memberships",
  "organization_user_retention_policies",
  "organization_user_resource_authorities",
  "organization_user_resource_grants",
] as const;
const expectedManagedPersonalWorkspacePermissions: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "connections:read",
  "connections:write",
  "capabilities:manage",
  "variable-sets:list",
  "variable-sets:read",
  "variable-sets:write",
  "variable-sets:manage",
  "variable-sets:attach",
  "variable-sets:use",
  "secrets:list",
  "secrets:read",
  "secrets:write",
  "mcp_servers:attach",
  "goals:manage",
  "enrollments:read",
  "enrollments:manage",
  "rigs:use",
  "artifacts:read",
  "artifacts:publish",
];

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL;
const externalAppUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_APP_URL;

beforeAll(async () => {
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL and OPENGENI_ORG_TENANCY_POSTGRES_APP_URL",
    );
  }
  if (externalAdminUrl && externalAppUrl) {
    const admin = postgres(externalAdminUrl, { max: 8 });
    shared = {
      admin,
      adminUrl: externalAdminUrl,
      appUrl: externalAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("migration-0219-organization-tenancy");
  }
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0219-organization-tenancy] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

async function callLifecycle(
  accountId: string,
  subjectId: string,
  personalWorkspaceId: string,
): Promise<unknown> {
  if (!client) throw new Error("test database unavailable");
  return await client.db.transaction(async (tx) => {
    await setRlsContext(tx as unknown as Database, { accountId, workspaceId: null });
    return await rawRows(
      tx,
      sql`
        select * from ensure_managed_human_personal_workspace(
          ${accountId},
          ${subjectId},
          ${personalWorkspaceId}
        )
      `,
    );
  });
}

describe("migration 0219 managed-human organization provisioning", () => {
  test("pins the personal workspace projection to a closed permission allowlist", () => {
    expect(managedPersonalWorkspacePermissions).toEqual(
      expectedManagedPersonalWorkspacePermissions,
    );
    expect(managedPersonalWorkspacePermissions).not.toContain("workspace:admin");
    expect(managedPersonalWorkspacePermissions).not.toContain("members:manage");
    expect(managedPersonalWorkspacePermissions).not.toContain("api_keys:manage");
    expect(managedPersonalWorkspacePermissions).not.toContain("rigs:manage");
  });

  test("pins the rolling lifecycle capability, posture contract, and exact role grant", async () => {
    const [migration, posture, provisioner] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(posturePath, "utf8"),
      readFile(provisionerPath, "utf8"),
    ]);

    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of tenancyTables) {
      expect(migration).toContain(`CREATE POLICY organization_tenancy_lifecycle ON "${table}"`);
      expect(migration).toContain(
        `current_setting('opengeni.organization_tenancy_lifecycle', true)`,
      );
    }
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION %1$I.ensure_managed_human_personal_workspace(",
    );
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = %1$I, pg_catalog");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION %I.ensure_managed_human_personal_workspace(uuid,text,uuid) FROM PUBLIC",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION %I.ensure_managed_human_personal_workspace",
    );
    expect(migration).toContain("status IN ('suspended', 'revoked')");
    expect(migration).toContain("managed-human personal workspace already has runtime access");
    expect(posture).toContain('"ensure_managed_human_personal_workspace(uuid, text, uuid)"');
    expect(posture).toContain("RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES");
    expect(provisioner).toContain("ensure_managed_human_personal_workspace(uuid,text,uuid)");
    expect(provisioner).toContain(
      "REVOKE ALL ON FUNCTION %I.ensure_managed_human_personal_workspace(uuid, text, uuid) FROM PUBLIC",
    );
  });

  test("converges one membership and projects owner-only personal runtime access", async () => {
    if (!shared || !client) return;

    const userId = `slice-b-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const input = {
      userId,
      email: `${userId}@example.test`,
      name: "Slice B managed human",
    };
    const first = await ensureManagedAccessForUser(client.db, input);
    const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(
      client.db,
      input,
    );
    const repeated = await ensureManagedAccessForUser(client.db, input);
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => ensureManagedAccessForUser(client!.db, input)),
    );

    expect(repeated).toEqual(first);
    expect(provisioned.accessContext).toEqual(first);
    expect(concurrent).toEqual(Array.from({ length: 6 }, () => first));
    expect(first.workspaceGrants).toHaveLength(2);
    expect((await listWorkspacesForSubject(client.db, subjectId)).map((row) => row.id)).toEqual([
      first.defaultWorkspaceId!,
    ]);

    const [account] = await shared.admin<{ id: string }[]>`
      select id
      from managed_accounts
      where external_source = 'better-auth:user'
        and external_id = ${userId}
    `;
    const [defaultWorkspace] = await shared.admin<{ id: string }[]>`
      select id
      from workspaces
      where external_source = 'better-auth:user'
        and external_id = ${`${userId}:default`}
    `;
    const [personalWorkspace] = await shared.admin<
      {
        id: string;
        accountId: string;
        name: string;
        externalSource: string;
        externalId: string;
      }[]
    >`
      select
        id,
        account_id as "accountId",
        name,
        external_source as "externalSource",
        external_id as "externalId"
      from workspaces
      where external_source = 'opengeni:organization-membership'
        and external_id = ${`${account!.id}:${subjectId}`}
    `;
    const [membership] = await shared.admin<
      {
        id: string;
        accountId: string;
        subjectId: string;
        status: string;
        personalWorkspaceId: string;
      }[]
    >`
      select
        id,
        account_id as "accountId",
        subject_id as "subjectId",
        status,
        personal_workspace_id as "personalWorkspaceId"
      from organization_memberships
      where account_id = ${account!.id}
        and subject_id = ${subjectId}
    `;
    const [control] = await shared.admin<{ accountId: string }[]>`
      select account_id as "accountId"
      from workspace_inference_controls
      where workspace_id = ${personalWorkspace!.id}
    `;
    const [personalAccess] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from workspace_memberships
      where workspace_id = ${personalWorkspace!.id}
    `;
    const [defaultAccess] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from workspace_memberships
      where workspace_id = ${defaultWorkspace!.id}
        and subject_id = ${subjectId}
    `;
    const [authorityCount] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from organization_user_resource_authorities
      where account_id = ${account!.id}
    `;
    const [grantCount] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from organization_user_resource_grants
      where account_id = ${account!.id}
    `;

    expect(account?.id).toBe(first.accountGrants[0]?.accountId);
    expect(defaultWorkspace?.id).toBe(first.defaultWorkspaceId!);
    expect(personalWorkspace).toEqual({
      id: membership!.personalWorkspaceId,
      accountId: account!.id,
      name: "Personal workspace",
      externalSource: "opengeni:organization-membership",
      externalId: `${account!.id}:${subjectId}`,
    });
    expect(first.workspaceGrants[0]?.workspaceId).toBe(first.defaultWorkspaceId!);
    expect(first.workspaceGrants[1]).toEqual({
      workspaceId: personalWorkspace!.id,
      accountId: account!.id,
      subjectId,
      subjectLabel: input.email,
      permissions: expectedManagedPersonalWorkspacePermissions,
      principalKind: "human_session",
    });
    expect(first.workspaceGrants[1]?.permissions).not.toContain("workspace:admin");
    expect(first.workspaceGrants[1]?.permissions).not.toContain("members:manage");
    expect(first.workspaceGrants[1]?.permissions).not.toContain("api_keys:manage");
    expect(
      await resolveNamedManagedPersonalWorkspaceGrant(client.db, {
        accountId: account!.id,
        workspaceId: personalWorkspace!.id,
        subjectId,
      }),
    ).toEqual({
      workspaceId: personalWorkspace!.id,
      accountId: account!.id,
      subjectId,
      permissions: expectedManagedPersonalWorkspacePermissions,
      principalKind: "human_session",
    });
    expect(
      await resolveNamedManagedPersonalWorkspaceGrant(client.db, {
        accountId: account!.id,
        workspaceId: defaultWorkspace!.id,
        subjectId,
      }),
    ).toBeNull();
    expect(membership).toMatchObject({
      accountId: account!.id,
      subjectId,
      status: "active",
      personalWorkspaceId: personalWorkspace!.id,
    });
    expect(provisioned.organizationMemberships).toEqual([
      {
        id: membership!.id,
        organizationId: account!.id,
        status: "active",
        personalWorkspaceId: personalWorkspace!.id,
      },
    ]);
    expect(control).toEqual({ accountId: account!.id });
    expect(personalAccess).toEqual({ count: 0 });
    expect(defaultAccess).toEqual({ count: 1 });
    expect(authorityCount).toEqual({ count: 0 });
    expect(grantCount).toEqual({ count: 0 });
  });

  test("keeps the capability narrow and fails closed for fabricated, foreign, and terminal authority", async () => {
    if (!shared || !client) return;

    const firstUserId = `slice-b-adversarial-${crypto.randomUUID()}`;
    const firstSubjectId = `user:${firstUserId}`;
    const firstAccess = await ensureManagedAccessForUser(client.db, {
      userId: firstUserId,
      email: `${firstUserId}@example.test`,
      name: "Adversarial managed human",
    });
    const firstAccountId = firstAccess.accountGrants[0]!.accountId;
    const firstPersonalWorkspaceId = (
      await shared.admin<{ id: string }[]>`
        select id
        from workspaces
        where account_id = ${firstAccountId}
          and external_source = 'opengeni:organization-membership'
          and external_id = ${`${firstAccountId}:${firstSubjectId}`}
      `
    )[0]!.id;

    await expectSqlState(
      () => callLifecycle(firstAccountId, `user:${crypto.randomUUID()}`, firstPersonalWorkspaceId),
      "42501",
    );
    await expectSqlState(
      () => callLifecycle(firstAccountId, "", firstPersonalWorkspaceId),
      "42501",
    );
    await expectSqlState(
      () => callLifecycle(firstAccountId, `user:${"x".repeat(1024)}`, firstPersonalWorkspaceId),
      "42501",
    );
    await expectSqlState(
      () => callLifecycle(firstAccountId, firstSubjectId, firstAccess.defaultWorkspaceId!),
      "42501",
    );
    await expectSqlState(
      () => callLifecycle(crypto.randomUUID(), firstSubjectId, firstPersonalWorkspaceId),
      "42501",
    );

    const secondUserId = `slice-b-foreign-${crypto.randomUUID()}`;
    const secondAccess = await ensureManagedAccessForUser(client.db, {
      userId: secondUserId,
      email: `${secondUserId}@example.test`,
      name: "Foreign managed human",
    });
    const secondAccountId = secondAccess.accountGrants[0]!.accountId;
    const secondPersonalWorkspaceId = (
      await shared.admin<{ id: string }[]>`
        select id
        from workspaces
        where account_id = ${secondAccountId}
          and external_source = 'opengeni:organization-membership'
          and external_id = ${`${secondAccountId}:user:${secondUserId}`}
      `
    )[0]!.id;
    await expectSqlState(
      () => callLifecycle(firstAccountId, firstSubjectId, secondPersonalWorkspaceId),
      "42501",
    );

    // The current onboarding state resolver verifies the managed-auth identity
    // before binding invitations. This historical provisioning fixture predates
    // `auth_users`, so materialize the verified identity whose cookie the
    // terminal projection represents.
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (
        ${firstUserId}, 'Adversarial managed human',
        ${`${firstUserId}@example.test`}, true
      )
      on conflict (id) do nothing`;
    const terminalInput = {
      userId: firstUserId,
      email: `${firstUserId}@example.test`,
      name: "Adversarial managed human",
      emailVerified: true,
      provisionFallbackOrganization: false,
    } as const;
    const durableShape = async () => {
      const [shape] = await shared!.admin<
        Array<{
          accounts: number;
          workspaces: number;
          workspaceMemberships: number;
          organizationMemberships: number;
          authorities: number;
          grants: number;
        }>
      >`
        select
          (select count(*)::int from managed_accounts
            where id = ${firstAccountId}) as accounts,
          (select count(*)::int from workspaces
            where account_id = ${firstAccountId}) as workspaces,
          (select count(*)::int from workspace_memberships
            where account_id = ${firstAccountId}
              and subject_id = ${firstSubjectId}) as "workspaceMemberships",
          (select count(*)::int from organization_memberships
            where account_id = ${firstAccountId}
              and subject_id = ${firstSubjectId}) as "organizationMemberships",
          (select count(*)::int from organization_user_resource_authorities
            where account_id = ${firstAccountId}) as authorities,
          (select count(*)::int from organization_user_resource_grants
            where account_id = ${firstAccountId}) as grants`;
      return shape;
    };
    const expectedDurableShape = {
      accounts: 1,
      workspaces: 2,
      workspaceMemberships: 1,
      organizationMemberships: 1,
      authorities: 0,
      grants: 0,
    };
    expect(await durableShape()).toEqual(expectedDurableShape);

    const expectBoundedUnavailableProjection = async () => {
      // Migration 0348 removed implicit fallback provisioning from the
      // managed-cookie resolver. A non-active membership is authenticated but
      // has no projected authority: it returns a bounded empty context and the
      // onboarding surface reports `unavailable` instead of retrying the 0219
      // provisioning seam or presenting the human with a create flow.
      expect(
        await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, terminalInput),
      ).toEqual({
        accessContext: {
          mode: "managed",
          subjectId: firstSubjectId,
          subjectLabel: terminalInput.email,
          accountGrants: [],
          workspaceGrants: [],
          defaultAccountId: null,
          defaultWorkspaceId: null,
        },
        organizationMemberships: [],
      });
      expect(
        await getSelfServiceOrganizationOnboardingState(client!.db, {
          authUserId: firstUserId,
          email: terminalInput.email,
          emailVerified: true,
        }),
      ).toBe("unavailable");
      // Projection and onboarding reads cannot mint a replacement account,
      // workspace, membership, authority, or grant for the terminal subject.
      expect(await durableShape()).toEqual(expectedDurableShape);
    };

    await shared.admin`
      update organization_memberships
      set status = 'suspended', revoked_at = null
      where account_id = ${firstAccountId}
        and subject_id = ${firstSubjectId}
    `;
    await expectBoundedUnavailableProjection();

    await shared.admin`
      update organization_memberships
      set status = 'revoked', revoked_at = now()
      where account_id = ${firstAccountId}
        and subject_id = ${firstSubjectId}
    `;
    await expectBoundedUnavailableProjection();

    await shared.admin`
      update organization_memberships
      set status = 'provisioning',
          personal_workspace_id = ${firstAccess.defaultWorkspaceId!},
          revoked_at = null
      where account_id = ${firstAccountId}
        and subject_id = ${firstSubjectId}
    `;
    await expectBoundedUnavailableProjection();

    await shared.admin`
      update organization_memberships
      set status = 'active',
          personal_workspace_id = ${firstPersonalWorkspaceId},
          revoked_at = null
      where account_id = ${firstAccountId}
        and subject_id = ${firstSubjectId}
    `;
    const [fabricatedAccess] = await shared.admin<{ id: string }[]>`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, role, permissions
      ) values (
        ${firstAccountId}, ${firstPersonalWorkspaceId}, 'user:fabricated', 'owner', '[]'::jsonb
      ) returning id
    `;
    await expectSqlState(
      () => callLifecycle(firstAccountId, firstSubjectId, firstPersonalWorkspaceId),
      "42501",
    );
    await shared.admin`delete from workspace_memberships where id = ${fabricatedAccess!.id}`;

    const app = postgres(shared.appUrl, { max: 2 });
    try {
      for (const table of tenancyTables) {
        await expectSqlState(
          async () => await app.unsafe(`select * from "${table}" limit 1`),
          "42501",
        );
        await expectSqlState(
          async () => await app.unsafe(`insert into "${table}" default values`),
          "42501",
        );
        await expectSqlState(
          async () => await app.unsafe(`update "${table}" set updated_at = updated_at`),
          "42501",
        );
        await expectSqlState(async () => await app.unsafe(`delete from "${table}"`), "42501");
      }
    } finally {
      await app.end();
    }
  });

  test("records one lifecycle policy and exact routine ACL in native PostgreSQL", async () => {
    if (!shared) return;

    const [functionRow] = await shared.admin<
      {
        owner: string;
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        functionDef: string;
      }[]
    >`
      select
        pg_get_userbyid(p.proowner)::text as owner,
        p.prosecdef as "securityDefiner",
        has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        pg_get_functiondef(p.oid)::text as "functionDef"
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = current_schema()
        and p.oid = to_regprocedure(
          format('%I.ensure_managed_human_personal_workspace(uuid,text,uuid)', current_schema())
        )
    `;
    expect(functionRow).toMatchObject({
      securityDefiner: true,
      appExecute: true,
      publicExecute: false,
    });
    expect(functionRow?.functionDef).toContain("SET search_path");

    const policyRows = await shared.admin<
      {
        tableName: string;
        policyName: string;
        usingExpression: string;
        checkExpression: string;
        appSelect: boolean;
        appInsert: boolean;
        appUpdate: boolean;
        appDelete: boolean;
      }[]
    >`
      select
        c.relname as "tableName",
        p.polname as "policyName",
        pg_get_expr(p.polqual, p.polrelid) as "usingExpression",
        pg_get_expr(p.polwithcheck, p.polrelid) as "checkExpression",
        has_table_privilege('opengeni_app', c.oid, 'SELECT') as "appSelect",
        has_table_privilege('opengeni_app', c.oid, 'INSERT') as "appInsert",
        has_table_privilege('opengeni_app', c.oid, 'UPDATE') as "appUpdate",
        has_table_privilege('opengeni_app', c.oid, 'DELETE') as "appDelete"
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_policy p
        on p.polrelid = c.oid
        and p.polname = 'organization_tenancy_lifecycle'
      where n.nspname = current_schema()
        and c.relname = any(${shared.admin.array([...tenancyTables])})
      order by c.relname
    `;
    expect(policyRows).toHaveLength(tenancyTables.length);
    for (const row of policyRows) {
      expect(row.policyName).toBe("organization_tenancy_lifecycle");
      expect(row.usingExpression).toContain("opengeni.organization_tenancy_lifecycle");
      expect(row.checkExpression).toContain("opengeni.organization_tenancy_lifecycle");
      expect(row).toMatchObject({
        appSelect: false,
        appInsert: false,
        appUpdate: false,
        appDelete: false,
      });
    }
  });
});
