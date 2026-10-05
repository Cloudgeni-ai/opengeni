import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type OwnerMigratedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { splitStatements } from "../../../scripts/migration-rls-backfills";
import { migrate } from "../src/migrate";

import {
  assertWorkspaceMemberManagementCandidate,
  createDb,
  ensureManagedAccessForUser,
  ensureWorkspaceByExternalIdentity,
  listSelfOrganizationMemberships,
  listWorkspaceMemberManagementCandidates,
  nestedPostgresSqlState,
  removeWorkspaceMember,
  upsertWorkspaceMemberAsWorkspaceManager,
  type DbClient,
} from "../src";

// The workspace Members surface's candidate inventory and add/change check
// admit an active organization owner or administrator for any shared
// workspace in their organization, with or without their own workspace row.
// Ordinary members still need members:manage/workspace:admin on their own
// row; Personal workspaces, other organizations, and non-human actors are
// refused exactly as before.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let migrationOwner: postgres.Sql | null = null;

const migrationSource = () =>
  readFileSync(
    new URL("../drizzle/0635_organization_admin_workspace_member_management.sql", import.meta.url),
    "utf8",
  );

async function sqlState(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
  } catch (error) {
    return nestedPostgresSqlState(error) ?? null;
  }
  return null;
}

async function organizationOwner() {
  const userId = crypto.randomUUID();
  const subject = `user:${userId}`;
  await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `owner-${userId}@example.test`,
    name: "Owner",
  });
  const [membership] = await listSelfOrganizationMemberships(client!.db, subject);
  return {
    subject,
    organizationId: membership!.organizationId,
    personalWorkspaceId: membership!.personalWorkspaceId!,
  };
}

async function organizationMember(organizationId: string, role: "admin" | "member") {
  const subject = `user:${role}-${crypto.randomUUID()}`;
  const personalWorkspaceId = crypto.randomUUID();
  await shared!.admin`
    insert into workspaces (id, account_id, name)
    values (${personalWorkspaceId}, ${organizationId}, 'Personal')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${personalWorkspaceId}, ${organizationId})`;
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${organizationId}, ${subject}, ${role}, 'active', ${personalWorkspaceId})`;
  return { subject, personalWorkspaceId };
}

async function tenantWorkspace(organizationId: string): Promise<string> {
  const { workspace } = await ensureWorkspaceByExternalIdentity(client!.db, {
    accountId: organizationId,
    externalSource: "tenant",
    externalId: `tenant-${crypto.randomUUID()}`,
    name: "Embedded tenant",
  });
  return workspace.id;
}

async function giveRow(
  organizationId: string,
  workspaceId: string,
  subject: string,
  permissions: string[],
) {
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${organizationId}, ${workspaceId}, ${subject}, 'member', ${shared!.admin.json(permissions)})`;
}

const candidates = (accountId: string, workspaceId: string, actorSubjectId: string) =>
  listWorkspaceMemberManagementCandidates(client!.db, { accountId, workspaceId, actorSubjectId });

const assertCandidate = (
  accountId: string,
  workspaceId: string,
  actorSubjectId: string,
  targetSubjectId: string,
) =>
  assertWorkspaceMemberManagementCandidate(client!.db, {
    accountId,
    workspaceId,
    actorSubjectId,
    targetSubjectId,
  });

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0635-organization-member-management");
  if (!shared) {
    if (requireRealDatabase) throw new Error("migration 0635 requires real PostgreSQL");
    return;
  }
  client = createDb(shared.appUrl);
  owned = await acquireOwnerMigratedTestDatabase("migration-0635-catalog-owner");
  if (!owned) throw new Error("migration 0635 owner fixture is unavailable");
  await migrate(owned.ownerUrl);
  migrationOwner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await migrationOwner?.end({ timeout: 5 });
  await shared?.release();
  await owned?.release();
}, 60_000);

describe("migration 0635 organization administrator workspace member management", () => {
  test("is a rolling patch of the two workspace member management checks", () => {
    const source = migrationSource();
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("assert_workspace_member_management_candidate");
    expect(source).toContain("list_workspace_member_management_candidates");
  });

  test("catalog-only patch preserves exact routine text, security, and FORCE-RLS as a restricted owner", async () => {
    if (!owned || !migrationOwner) return;
    const [identity] = await migrationOwner`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(identity).toEqual({ rolsuper: false, rolbypassrls: false });
    const [posture] = await migrationOwner`
      select relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) as owner
      from pg_class where oid = 'organization_memberships'::regclass`;
    expect(posture).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
      owner: owned.ownerRole,
    });

    // Restore only the original routine bodies, preserving identity and ACLs.
    for (const file of [
      "0370_workspace_member_management_scope.sql",
      "0371_workspace_member_candidate_inventory.sql",
    ]) {
      const statement = splitStatements(
        readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
      ).find((candidate) => candidate.startsWith("CREATE FUNCTION"));
      expect(statement).toBeDefined();
      await migrationOwner.unsafe(
        statement!.replace(/^CREATE FUNCTION/u, "CREATE OR REPLACE FUNCTION"),
      );
    }

    const definitions = () => migrationOwner!`
      select oid, pg_get_functiondef(oid) as definition, proowner, proacl, prosecdef, proconfig
      from pg_proc where oid in (
        'assert_workspace_member_management_candidate(uuid,uuid,text,text)'::regprocedure,
        'list_workspace_member_management_candidates(uuid,uuid,text)'::regprocedure
      ) order by proname`;
    const before = await definitions();
    const anchor =
      "  IF NOT EXISTS (\n" +
      "    SELECT 1\n" +
      "    FROM organization_memberships organization_membership\n" +
      "    JOIN workspace_memberships workspace_membership\n";
    const replacement =
      "  IF NOT EXISTS (\n" +
      "    SELECT 1 FROM organization_memberships organization_administrator\n" +
      "    WHERE organization_administrator.account_id = p_account_id\n" +
      "      AND organization_administrator.subject_id = p_actor_subject_id\n" +
      "      AND organization_administrator.subject_id LIKE 'user:%'\n" +
      "      AND organization_administrator.status = 'active'\n" +
      "      AND organization_administrator.role IN ('owner', 'admin')\n" +
      "  ) AND NOT EXISTS (\n" +
      "    SELECT 1\n" +
      "    FROM organization_memberships organization_membership\n" +
      "    JOIN workspace_memberships workspace_membership\n";
    for (const routine of before) expect(routine.definition.split(anchor)).toHaveLength(2);
    await migrationOwner.begin(async (transaction) => {
      await transaction.unsafe(migrationSource());
    });
    const after = await definitions();
    expect(Array.from(after)).toEqual(
      Array.from(before, (routine) => ({
        ...routine,
        definition: routine.definition.replace(anchor, replacement),
      })),
    );

    // The unchanged one-match assertion still rejects drift and rolls back.
    expect(
      await sqlState(() =>
        migrationOwner!.begin((transaction) => transaction.unsafe(migrationSource())),
      ),
    ).toBe("55000");
    expect(Array.from(await definitions())).toEqual(Array.from(after));
    const [forced] = await migrationOwner`
      select relforcerowsecurity from pg_class where oid = 'organization_memberships'::regclass`;
    expect(forced?.relforcerowsecurity).toBe(true);
    const [app] = await migrationOwner`
      select rolsuper, rolbypassrls,
        has_table_privilege('opengeni_app', 'organization_memberships', 'INSERT,UPDATE,DELETE') as dml
      from pg_roles where rolname = 'opengeni_app'`;
    expect(app).toEqual({ rolsuper: false, rolbypassrls: false, dml: false });
  }, 180_000);

  test("an owner without a workspace row lists, adds, changes, and removes members", async () => {
    if (!shared || !client) return;
    const owner = await organizationOwner();
    const target = await organizationMember(owner.organizationId, "member");
    const tenant = await tenantWorkspace(owner.organizationId);

    const listed = await candidates(owner.organizationId, tenant, owner.subject);
    expect(listed.map((candidate) => candidate.subjectId)).toEqual(
      expect.arrayContaining([owner.subject, target.subject]),
    );
    await assertCandidate(owner.organizationId, tenant, owner.subject, target.subject);

    const write = (mode: "add" | "update", permissions: string[]) =>
      upsertWorkspaceMemberAsWorkspaceManager(client!.db, {
        accountId: owner.organizationId,
        workspaceId: tenant,
        actorSubjectId: owner.subject,
        targetSubjectId: target.subject,
        mode,
        role: "member",
        permissions: permissions as never,
      });
    await write("add", ["workspace:read"]);
    await write("update", ["workspace:read", "sessions:read"]);
    const [row] = await shared.admin<Array<{ permissions: string[] }>>`
      select permissions from workspace_memberships
      where workspace_id = ${tenant} and subject_id = ${target.subject}`;
    expect(row?.permissions).toEqual(["workspace:read", "sessions:read"]);

    // Removal proves the same authority through the organization capability.
    expect(
      await removeWorkspaceMember(client.db, {
        accountId: owner.organizationId,
        workspaceId: tenant,
        actorSubjectId: owner.subject,
        targetSubjectId: target.subject,
        requireOrganizationSharedWorkspaceAdministration: true,
      }),
    ).toBe(true);
  }, 180_000);

  test("an organization admin holding only a viewer row is admitted", async () => {
    if (!shared || !client) return;
    const owner = await organizationOwner();
    const admin = await organizationMember(owner.organizationId, "admin");
    const target = await organizationMember(owner.organizationId, "member");
    const tenant = await tenantWorkspace(owner.organizationId);
    await giveRow(owner.organizationId, tenant, admin.subject, ["workspace:read"]);
    expect(
      (await candidates(owner.organizationId, tenant, admin.subject)).map(
        (candidate) => candidate.subjectId,
      ),
    ).toContain(target.subject);
    await assertCandidate(owner.organizationId, tenant, admin.subject, target.subject);
  }, 180_000);

  test("an ordinary member needs members:manage on their own row", async () => {
    if (!shared || !client) return;
    const owner = await organizationOwner();
    const member = await organizationMember(owner.organizationId, "member");
    const target = await organizationMember(owner.organizationId, "member");
    const tenant = await tenantWorkspace(owner.organizationId);
    expect(await sqlState(() => candidates(owner.organizationId, tenant, member.subject))).toBe(
      "42501",
    );
    await giveRow(owner.organizationId, tenant, member.subject, ["workspace:read"]);
    expect(await sqlState(() => candidates(owner.organizationId, tenant, member.subject))).toBe(
      "42501",
    );
    expect(
      await sqlState(() =>
        assertCandidate(owner.organizationId, tenant, member.subject, target.subject),
      ),
    ).toBe("42501");
    await shared.admin`
      update workspace_memberships set permissions = '["workspace:read","members:manage"]'::jsonb
      where workspace_id = ${tenant} and subject_id = ${member.subject}`;
    await assertCandidate(owner.organizationId, tenant, member.subject, target.subject);
  }, 180_000);

  test("other organizations, Personal workspaces, and non-human actors stay refused", async () => {
    if (!shared || !client) return;
    const owner = await organizationOwner();
    const member = await organizationMember(owner.organizationId, "member");
    const foreign = await organizationOwner();
    const tenant = await tenantWorkspace(owner.organizationId);

    // The foreign owner holds no membership in this organization.
    expect(await sqlState(() => candidates(owner.organizationId, tenant, foreign.subject))).toBe(
      "42501",
    );
    expect(
      await sqlState(() =>
        assertCandidate(owner.organizationId, tenant, foreign.subject, member.subject),
      ),
    ).toBe("42501");
    // Naming their own organization, the workspace does not exist there.
    expect(
      await sqlState(() => candidates(foreign.organizationId, tenant, foreign.subject)),
    ).not.toBeNull();

    for (const personal of [owner.personalWorkspaceId, member.personalWorkspaceId]) {
      expect(await sqlState(() => candidates(owner.organizationId, personal, owner.subject))).toBe(
        "42501",
      );
      expect(
        await sqlState(() =>
          assertCandidate(owner.organizationId, personal, owner.subject, member.subject),
        ),
      ).toBe("42501");
    }

    const keySubject = `api_key:${crypto.randomUUID()}`;
    await giveRow(owner.organizationId, tenant, keySubject, ["workspace:admin"]);
    expect(await sqlState(() => candidates(owner.organizationId, tenant, keySubject))).toBe(
      "42501",
    );
  }, 180_000);
});
