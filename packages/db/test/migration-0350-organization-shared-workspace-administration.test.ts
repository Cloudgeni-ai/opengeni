import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import {
  assertWorkspaceMemberManagementCandidate,
  createDb,
  createOrganizationWorkspace,
  ensureManagedAccessForUser,
  getOrganizationAdministrationOverview,
  listWorkspaceMemberManagementCandidates,
  listOrganizationAdministrationMembers,
  listOrganizationMembers,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  putOrganizationWorkspaceMember,
  requireWorkspace,
  revokeOrganizationWorkspaceMember,
  updateOrganizationMember,
  updateOrganizationWorkspace,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { FORCE_RLS_TABLES, PROTECTED_NO_DIRECT_DML_TABLES } from "../src/runtime-posture";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let app: postgres.Sql | null = null;

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0350-workspace-administration");
  if (!owned) {
    if (requireRealDatabase) throw new Error("migration 0350 requires real PostgreSQL");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), {
    max: 2,
    prepare: false,
    onnotice: () => undefined,
  });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await app?.end({ timeout: 5 }).catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("migration 0350 organization shared-workspace administration", () => {
  test("keeps the legacy projection while adding a capability-only safe authority", async () => {
    const source = readFileSync(
      new URL("../drizzle/0350_organization_shared_workspace_administration.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).not.toContain("CREATE OR REPLACE FUNCTION list_organization_members");
    expect(source).toContain("CREATE FUNCTION list_organization_administration_members");
    expect(source).toContain("organization_memberships.personal_workspace_id");
    expect(FORCE_RLS_TABLES).toEqual(
      expect.arrayContaining([
        "organization_workspace_lifecycle_events",
        "organization_workspace_operation_receipts",
      ]),
    );
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toEqual(
      expect.arrayContaining([
        "organization_workspace_lifecycle_events",
        "organization_workspace_operation_receipts",
      ]),
    );
    if (!owned || !client || !app) return;

    const [identity] = await owned.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${owned.ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });
    const forced = await owned.admin<Array<{ relation: string; forced: boolean }>>`
      select relation.relname::text as relation, relation.relforcerowsecurity as forced
      from pg_class relation
      where relation.oid in (
        'organization_workspace_lifecycle_events'::regclass,
        'organization_workspace_operation_receipts'::regclass
      ) order by relation`;
    expect(Array.from(forced)).toEqual([
      { relation: "organization_workspace_lifecycle_events", forced: true },
      { relation: "organization_workspace_operation_receipts", forced: true },
    ]);
    const [acl] = await owned.admin<
      Array<{
        eventsDml: boolean;
        receiptsDml: boolean;
        command: boolean;
        workspaceCandidate: boolean;
        safeList: boolean;
      }>
    >`
      select
        has_table_privilege(
          'opengeni_app', 'organization_workspace_lifecycle_events',
          'INSERT,UPDATE,DELETE,TRUNCATE'
        ) as "eventsDml",
        has_table_privilege(
          'opengeni_app', 'organization_workspace_operation_receipts',
          'INSERT,UPDATE,DELETE,TRUNCATE'
        ) as "receiptsDml",
        has_function_privilege(
          'opengeni_app', 'organization_workspace_command(jsonb)', 'EXECUTE'
        ) as command,
        has_function_privilege(
          'opengeni_app',
          'assert_workspace_member_management_candidate(uuid,uuid,text,text)', 'EXECUTE'
        ) as "workspaceCandidate",
        has_function_privilege(
          'opengeni_app', 'list_organization_administration_members(uuid,text)', 'EXECUTE'
        ) as "safeList"`;
    expect(acl).toEqual({
      eventsDml: false,
      receiptsDml: false,
      command: true,
      workspaceCandidate: true,
      safeList: true,
    });

    const ownerUserId = crypto.randomUUID();
    const ownerSubject = `user:${ownerUserId}`;
    const ownerEmail = `owner-${ownerUserId}@example.test`;
    await ensureManagedAccessForUser(client.db, {
      userId: ownerUserId,
      email: ownerEmail,
      name: "Workspace Owner",
    });
    await owned.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${ownerUserId}, 'Workspace Owner', ${ownerEmail}, true)
      on conflict (id) do update set name = excluded.name, email = excluded.email`;
    const [ownerMembership] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    expect(ownerMembership).toBeDefined();
    const organizationId = ownerMembership!.organizationId;

    const targetUserId = crypto.randomUUID();
    const targetSubject = `user:${targetUserId}`;
    const targetEmail = `member-${targetUserId}@example.test`;
    const targetPersonalWorkspaceId = crypto.randomUUID();
    const targetMembershipId = crypto.randomUUID();
    await owned.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${targetUserId}, 'Ada Member', ${targetEmail}, true)`;
    await owned.admin`
      insert into workspaces (id, account_id, name)
      values (${targetPersonalWorkspaceId}, ${organizationId}, 'Ada Personal')`;
    await owned.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${targetPersonalWorkspaceId}, ${organizationId})`;
    await owned.admin`
      insert into organization_memberships (
        id, account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${targetMembershipId}, ${organizationId}, ${targetSubject}, 'member', 'active',
        ${targetPersonalWorkspaceId}
      )`;

    expect((await requireWorkspace(client.db, ownerMembership!.personalWorkspaceId!)).kind).toBe(
      "personal",
    );
    expect((await requireWorkspace(client.db, targetPersonalWorkspaceId)).kind).toBe("personal");

    const createOperationId = crypto.randomUUID();
    const workspace = await createOrganizationWorkspace(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      name: "Product engineering",
      operationId: createOperationId,
    });
    expect((await requireWorkspace(client.db, workspace.id)).kind).toBe("shared");
    expect(workspace.members).toEqual([]);
    expect(
      (
        await createOrganizationWorkspace(client.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          name: "Product engineering",
          operationId: createOperationId,
        })
      ).id,
    ).toBe(workspace.id);
    await expectSqlState(
      () =>
        createOrganizationWorkspace(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          name: "Reused operation",
          operationId: createOperationId,
        }),
      "23505",
    );

    const overview = await getOrganizationAdministrationOverview(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
    });
    expect(overview.roles.map(({ role }) => role)).toEqual(["viewer", "member", "admin"]);
    expect(overview.roles.find(({ role }) => role === "viewer")!.permissions).toEqual([
      "workspace:read",
      "sessions:read",
      "stream:view",
      "files:read",
      "documents:search",
      "variable-sets:list",
      "connections:read",
      "rigs:use",
      "artifacts:read",
    ]);
    for (const definition of overview.roles) {
      expect(definition.permissions).toContain("workspace:read");
      expect(definition.permissions).not.toContain("secrets:read");
      expect(definition.permissions).not.toContain("account:admin");
    }

    await putOrganizationWorkspaceMember(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      workspaceId: workspace.id,
      targetOrganizationMembershipId: ownerMembership!.id,
      access: {
        role: "admin",
        expectedUpdatedAt: null,
        operationId: crypto.randomUUID(),
      },
    });
    expect(
      await listWorkspaceMemberManagementCandidates(client.db, {
        accountId: organizationId,
        workspaceId: workspace.id,
        actorSubjectId: ownerSubject,
      }),
    ).toEqual([
      expect.objectContaining({
        organizationMembershipId: targetMembershipId,
        subjectId: targetSubject,
        name: "Ada Member",
        email: targetEmail,
        organizationRole: "member",
      }),
    ]);
    await assertWorkspaceMemberManagementCandidate(client.db, {
      accountId: organizationId,
      workspaceId: workspace.id,
      actorSubjectId: ownerSubject,
      targetSubjectId: targetSubject,
    });
    await expectSqlState(
      () =>
        assertWorkspaceMemberManagementCandidate(client!.db, {
          accountId: organizationId,
          workspaceId: workspace.id,
          actorSubjectId: ownerSubject,
          targetSubjectId: `user:${crypto.randomUUID()}`,
        }),
      "P0002",
    );
    await expectSqlState(
      () =>
        assertWorkspaceMemberManagementCandidate(client!.db, {
          accountId: organizationId,
          workspaceId: ownerMembership!.personalWorkspaceId!,
          actorSubjectId: ownerSubject,
          targetSubjectId: targetSubject,
        }),
      "42501",
    );

    const grantOperationId = crypto.randomUUID();
    const viewer = await putOrganizationWorkspaceMember(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      workspaceId: workspace.id,
      targetOrganizationMembershipId: targetMembershipId,
      access: {
        role: "viewer",
        expectedUpdatedAt: null,
        operationId: grantOperationId,
      },
    });
    expect(viewer).toMatchObject({
      organizationMembershipId: targetMembershipId,
      name: "Ada Member",
      email: targetEmail,
      organizationRole: "member",
      role: "viewer",
    });
    expect(viewer.permissions).toEqual(
      overview.roles.find(({ role }) => role === "viewer")!.permissions,
    );
    expect(
      await listWorkspaceMemberManagementCandidates(client.db, {
        accountId: organizationId,
        workspaceId: workspace.id,
        actorSubjectId: ownerSubject,
      }),
    ).toEqual([]);
    expect(
      (
        await putOrganizationWorkspaceMember(client.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          workspaceId: workspace.id,
          targetOrganizationMembershipId: targetMembershipId,
          access: {
            role: "viewer",
            expectedUpdatedAt: null,
            operationId: grantOperationId,
          },
        })
      ).membershipId,
    ).toBe(viewer.membershipId);
    await expectSqlState(
      () =>
        putOrganizationWorkspaceMember(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          workspaceId: workspace.id,
          targetOrganizationMembershipId: targetMembershipId,
          access: {
            role: "admin",
            expectedUpdatedAt: null,
            operationId: grantOperationId,
          },
        }),
      "23505",
    );

    const member = await putOrganizationWorkspaceMember(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      workspaceId: workspace.id,
      targetOrganizationMembershipId: targetMembershipId,
      access: {
        role: "member",
        expectedUpdatedAt: viewer.updatedAt,
        operationId: crypto.randomUUID(),
      },
    });
    expect(member.role).toBe("member");
    await expectSqlState(
      () =>
        putOrganizationWorkspaceMember(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          workspaceId: workspace.id,
          targetOrganizationMembershipId: targetMembershipId,
          access: {
            role: "viewer",
            expectedUpdatedAt: viewer.updatedAt,
            operationId: crypto.randomUUID(),
          },
        }),
      "40001",
    );

    const custom = await putOrganizationWorkspaceMember(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      workspaceId: workspace.id,
      targetOrganizationMembershipId: targetMembershipId,
      access: {
        role: "custom",
        permissions: ["workspace:read", "sessions:read", "files:write"],
        expectedUpdatedAt: member.updatedAt,
        operationId: crypto.randomUUID(),
      },
    });
    expect(custom).toMatchObject({ role: "custom" });
    expect(custom.permissions).toEqual(["workspace:read", "sessions:read", "files:write"]);
    await expectSqlState(async () => {
      await app!.unsafe(
        `select set_config('opengeni.account_id', $1, false),
             set_config('opengeni.subject_id', $2, false),
             organization_workspace_command($3::jsonb)`,
        [
          organizationId,
          ownerSubject,
          JSON.stringify({
            action: "grant",
            organizationId,
            actorSubjectId: ownerSubject,
            workspaceId: workspace.id,
            targetOrganizationMembershipId: targetMembershipId,
            role: "custom",
            permissions: ["account:admin"],
            expectedUpdatedAt: custom.updatedAt,
            operationId: crypto.randomUUID(),
          }),
        ],
      );
    }, "22023");

    const renamed = await updateOrganizationWorkspace(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      workspaceId: workspace.id,
      name: "Product systems",
      expectedUpdatedAt: workspace.updatedAt,
      operationId: crypto.randomUUID(),
    });
    expect(renamed.name).toBe("Product systems");
    const personal = await requireWorkspace(client.db, targetPersonalWorkspaceId);
    await expectSqlState(
      () =>
        updateOrganizationWorkspace(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          workspaceId: personal.id,
          name: "Forbidden personal rename",
          expectedUpdatedAt: personal.updatedAt,
          operationId: crypto.randomUUID(),
        }),
      "42501",
    );
    await expectSqlState(
      () =>
        revokeOrganizationWorkspaceMember(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          workspaceId: personal.id,
          targetOrganizationMembershipId: targetMembershipId,
          expectedUpdatedAt: custom.updatedAt,
          operationId: crypto.randomUUID(),
        }),
      "42501",
    );
    await expectSqlState(
      () =>
        putOrganizationWorkspaceMember(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          workspaceId: personal.id,
          targetOrganizationMembershipId: targetMembershipId,
          access: {
            role: "viewer",
            expectedUpdatedAt: null,
            operationId: crypto.randomUUID(),
          },
        }),
      "42501",
    );

    const legacy = await listOrganizationMembers(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
    });
    expect(legacy.find(({ id }) => id === targetMembershipId)).toMatchObject({
      personalWorkspaceId: targetPersonalWorkspaceId,
    });
    const safe = await listOrganizationAdministrationMembers(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
    });
    const safeTarget = safe.find(({ id }) => id === targetMembershipId);
    expect(safeTarget).toMatchObject({
      name: "Ada Member",
      email: targetEmail,
      sharedWorkspaceAccess: [{ workspaceId: workspace.id, role: "custom" }],
    });
    expect(safeTarget).not.toHaveProperty("personalWorkspaceId");
    expect(safeTarget).not.toHaveProperty("personalRetentionUntil");

    await expectSqlState(
      () =>
        putOrganizationWorkspaceMember(client!.db, {
          organizationId,
          actorSubjectId: targetSubject,
          workspaceId: workspace.id,
          targetOrganizationMembershipId: targetMembershipId,
          access: {
            role: "admin",
            expectedUpdatedAt: custom.updatedAt,
            operationId: crypto.randomUUID(),
          },
        }),
      "42501",
    );
    const foreignUserId = crypto.randomUUID();
    const foreignSubject = `user:${foreignUserId}`;
    await ensureManagedAccessForUser(client.db, {
      userId: foreignUserId,
      email: `${foreignUserId}@example.test`,
      name: "Foreign Owner",
    });
    const [foreignMembership] = await listSelfOrganizationMemberships(client.db, foreignSubject);
    await expectSqlState(
      () =>
        putOrganizationWorkspaceMember(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          workspaceId: workspace.id,
          targetOrganizationMembershipId: foreignMembership!.id,
          access: {
            role: "viewer",
            expectedUpdatedAt: null,
            operationId: crypto.randomUUID(),
          },
        }),
      "P0002",
    );

    await expectSqlState(
      () =>
        updateOrganizationMember(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          operationId: crypto.randomUUID(),
          membershipId: ownerMembership!.id,
          transition: {
            kind: "suspend",
            expectedAuthorizationRevision: ownerMembership!.authorizationRevision,
            operationId: crypto.randomUUID(),
          },
        }),
      "55000",
    );

    const promotedAdmin = await updateOrganizationMember(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      membershipId: targetMembershipId,
      transition: {
        kind: "change_role",
        role: "admin",
        expectedAuthorizationRevision: safeTarget!.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    expect(promotedAdmin.role).toBe("admin");
    const adminAccess = await putOrganizationWorkspaceMember(client.db, {
      organizationId,
      actorSubjectId: targetSubject,
      workspaceId: workspace.id,
      targetOrganizationMembershipId: targetMembershipId,
      access: {
        role: "admin",
        expectedUpdatedAt: custom.updatedAt,
        operationId: crypto.randomUUID(),
      },
    });
    expect(adminAccess.role).toBe("admin");
    await expectSqlState(
      () =>
        revokeOrganizationWorkspaceMember(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          workspaceId: workspace.id,
          targetOrganizationMembershipId: targetMembershipId,
          expectedUpdatedAt: custom.updatedAt,
          operationId: crypto.randomUUID(),
        }),
      "40001",
    );

    const revokeOperationId = crypto.randomUUID();
    expect(
      await revokeOrganizationWorkspaceMember(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        workspaceId: workspace.id,
        targetOrganizationMembershipId: targetMembershipId,
        expectedUpdatedAt: adminAccess.updatedAt,
        operationId: revokeOperationId,
      }),
    ).toEqual({ removed: true, replay: false });
    expect(
      await revokeOrganizationWorkspaceMember(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        workspaceId: workspace.id,
        targetOrganizationMembershipId: targetMembershipId,
        expectedUpdatedAt: adminAccess.updatedAt,
        operationId: revokeOperationId,
      }),
    ).toEqual({ removed: true, replay: true });
    expect(
      (
        await listOrganizationAdministrationMembers(client.db, {
          organizationId,
          actorSubjectId: ownerSubject,
        })
      ).find(({ id }) => id === targetMembershipId)?.sharedWorkspaceAccess,
    ).toEqual([]);

    const [audit] = await owned.admin<Array<{ events: number; receipts: number }>>`
      select
        (select count(*)::int from organization_workspace_lifecycle_events
         where account_id = ${organizationId}) as events,
        (select count(*)::int from organization_workspace_operation_receipts
         where account_id = ${organizationId}) as receipts`;
    expect(audit).toEqual({ events: 8, receipts: 8 });
    await expectSqlState(
      () => client!.db.execute(sql`delete from organization_workspace_lifecycle_events`),
      "42501",
    );
  }, 900_000);
});
