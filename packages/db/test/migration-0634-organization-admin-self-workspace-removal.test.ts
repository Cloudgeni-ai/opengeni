import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFileSync } from "node:fs";

import {
  createDb,
  ensureManagedAccessForUser,
  ensureWorkspaceByExternalIdentity,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  putOrganizationWorkspaceMember,
  removeWorkspaceMember,
  revokeOrganizationWorkspaceMember,
  type DbClient,
} from "../src";

// Organization owners and administrators define shared-workspace access for
// every active member, themselves included, through the organization control
// plane. Workspaces an organization key provisions per tenant are ordinary
// shared workspaces in that inventory; Personal workspaces stay owner-only.

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

type Person = { subject: string; membershipId: string; personalWorkspaceId: string };

async function organizationOwner(label: string): Promise<Person & { organizationId: string }> {
  const userId = crypto.randomUUID();
  const subject = `user:${userId}`;
  await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${label}-${userId}@example.test`,
    name: label,
  });
  const [membership] = await listSelfOrganizationMemberships(client!.db, subject);
  return {
    subject,
    organizationId: membership!.organizationId,
    membershipId: membership!.id,
    personalWorkspaceId: membership!.personalWorkspaceId!,
  };
}

async function organizationMember(
  organizationId: string,
  role: "admin" | "member",
): Promise<Person> {
  const subject = `user:${role}-${crypto.randomUUID()}`;
  const membershipId = crypto.randomUUID();
  const personalWorkspaceId = crypto.randomUUID();
  await shared!.admin`
    insert into workspaces (id, account_id, name)
    values (${personalWorkspaceId}, ${organizationId}, 'Personal')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${personalWorkspaceId}, ${organizationId})`;
  await shared!.admin`
    insert into organization_memberships (
      id, account_id, subject_id, role, status, personal_workspace_id
    ) values (
      ${membershipId}, ${organizationId}, ${subject}, ${role}, 'active', ${personalWorkspaceId}
    )`;
  return { subject, membershipId, personalWorkspaceId };
}

async function tenantWorkspace(organizationId: string): Promise<string> {
  const { workspace } = await ensureWorkspaceByExternalIdentity(client!.db, {
    accountId: organizationId,
    externalSource: "tenant",
    externalId: `tenant-${crypto.randomUUID()}`,
    name: "Embedded tenant",
  });
  expect(workspace.kind).toBe("shared");
  return workspace.id;
}

async function accessRows(workspaceId: string, subject: string) {
  return Array.from(
    await shared!.admin<Array<{ role: string }>>`
      select role from workspace_memberships
      where workspace_id = ${workspaceId} and subject_id = ${subject}`,
  );
}

function grant(
  organizationId: string,
  actor: string,
  workspaceId: string,
  target: string,
  role: "viewer" | "member" | "admin",
  expectedUpdatedAt: string | null = null,
) {
  return putOrganizationWorkspaceMember(client!.db, {
    organizationId,
    actorSubjectId: actor,
    workspaceId,
    targetOrganizationMembershipId: target,
    access: { role, expectedUpdatedAt, operationId: crypto.randomUUID() },
  });
}

function revoke(
  organizationId: string,
  actor: string,
  workspaceId: string,
  target: string,
  expectedUpdatedAt: string,
) {
  return revokeOrganizationWorkspaceMember(client!.db, {
    organizationId,
    actorSubjectId: actor,
    workspaceId,
    targetOrganizationMembershipId: target,
    expectedUpdatedAt,
    operationId: crypto.randomUUID(),
  });
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0634-organization-self-access");
  if (!shared) {
    if (requireRealDatabase) throw new Error("migration 0634 requires real PostgreSQL");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("migration 0634 organization administrator self workspace access", () => {
  test("is a rolling patch of the one removal-actor guard", () => {
    const source = readFileSync(
      new URL("../drizzle/0634_organization_admin_self_workspace_removal.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("assert_workspace_membership_removal_actor");
    expect(source).toContain("AND NOT actor_is_organization_administrator");
  });

  test("an owner grants, changes, and revokes their own access to a key-provisioned workspace", async () => {
    if (!shared || !client) return;
    const owner = await organizationOwner("Owner");
    const tenant = await tenantWorkspace(owner.organizationId);
    expect(await accessRows(tenant, owner.subject)).toEqual([]);

    const joined = await grant(
      owner.organizationId,
      owner.subject,
      tenant,
      owner.membershipId,
      "admin",
    );
    expect(joined).toMatchObject({ subjectId: owner.subject, role: "admin" });
    const narrowed = await grant(
      owner.organizationId,
      owner.subject,
      tenant,
      owner.membershipId,
      "viewer",
      joined.updatedAt,
    );
    expect(narrowed.role).toBe("viewer");

    const removed = await revoke(
      owner.organizationId,
      owner.subject,
      tenant,
      owner.membershipId,
      narrowed.updatedAt,
    );
    expect(removed).toMatchObject({ removed: true, replay: false });
    expect(await accessRows(tenant, owner.subject)).toEqual([]);

    const [events] = await shared.admin<Array<{ grants: number; revokes: number }>>`
      select
        count(*) filter (where kind = 'grant')::int as grants,
        count(*) filter (where kind = 'revoke')::int as revokes
      from organization_workspace_lifecycle_events
      where account_id = ${owner.organizationId} and workspace_id = ${tenant}`;
    expect(events).toEqual({ grants: 2, revokes: 1 });

    // Rejoining after leaving is the same explicit grant.
    expect(
      (await grant(owner.organizationId, owner.subject, tenant, owner.membershipId, "member")).role,
    ).toBe("member");
  }, 180_000);

  test("an organization administrator manages their own access the same way", async () => {
    if (!shared || !client) return;
    const owner = await organizationOwner("Owner");
    const admin = await organizationMember(owner.organizationId, "admin");
    const tenant = await tenantWorkspace(owner.organizationId);
    const joined = await grant(
      owner.organizationId,
      admin.subject,
      tenant,
      admin.membershipId,
      "admin",
    );
    expect(joined.subjectId).toBe(admin.subject);
    expect(
      await revoke(
        owner.organizationId,
        admin.subject,
        tenant,
        admin.membershipId,
        joined.updatedAt,
      ),
    ).toMatchObject({ removed: true });
    expect(await accessRows(tenant, admin.subject)).toEqual([]);
  }, 180_000);

  test("an ordinary member cannot grant or revoke, even for themself", async () => {
    if (!shared || !client) return;
    const owner = await organizationOwner("Owner");
    const member = await organizationMember(owner.organizationId, "member");
    const tenant = await tenantWorkspace(owner.organizationId);
    expect(
      await sqlState(() =>
        grant(owner.organizationId, member.subject, tenant, member.membershipId, "admin"),
      ),
    ).toBe("42501");
    const access = await grant(
      owner.organizationId,
      owner.subject,
      tenant,
      member.membershipId,
      "admin",
    );
    expect(
      await sqlState(() =>
        revoke(owner.organizationId, member.subject, tenant, member.membershipId, access.updatedAt),
      ),
    ).toBe("42501");
    // A workspace admin still cannot remove themself through the workspace's
    // own Members route: only the organization capability waives that guard.
    expect(
      await sqlState(() =>
        removeWorkspaceMember(client!.db, {
          accountId: owner.organizationId,
          workspaceId: tenant,
          actorSubjectId: member.subject,
          targetSubjectId: member.subject,
        }),
      ),
    ).toBe("55000");
    expect(await accessRows(tenant, member.subject)).toEqual([{ role: "admin" }]);
  }, 180_000);

  test("an owner cannot reach another organization's workspaces or anyone's Personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await organizationOwner("Owner");
    const member = await organizationMember(owner.organizationId, "member");
    const foreign = await organizationOwner("Foreign owner");
    const foreignTenant = await tenantWorkspace(foreign.organizationId);

    // Naming the other organization: the owner holds no membership there.
    expect(
      await sqlState(() =>
        grant(foreign.organizationId, owner.subject, foreignTenant, owner.membershipId, "admin"),
      ),
    ).toBe("42501");
    // Naming their own organization: the other organization's workspace is invisible.
    expect(
      await sqlState(() =>
        grant(owner.organizationId, owner.subject, foreignTenant, owner.membershipId, "admin"),
      ),
    ).toBe("P0002");
    expect(await accessRows(foreignTenant, owner.subject)).toEqual([]);

    for (const personal of [owner.personalWorkspaceId, member.personalWorkspaceId]) {
      for (const target of [owner.membershipId, member.membershipId]) {
        expect(
          await sqlState(() =>
            grant(owner.organizationId, owner.subject, personal, target, "viewer"),
          ),
        ).toBe("42501");
      }
    }
  }, 180_000);
});
