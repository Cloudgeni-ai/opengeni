import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFileSync } from "node:fs";

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
let client: DbClient | null = null;

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
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("migration 0635 organization administrator workspace member management", () => {
  test("is a rolling patch of the two workspace member management checks", () => {
    const source = readFileSync(
      new URL(
        "../drizzle/0635_organization_admin_workspace_member_management.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("assert_workspace_member_management_candidate");
    expect(source).toContain("list_workspace_member_management_candidates");
  });

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
