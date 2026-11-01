// Migration 1159: a Personal workspace has exactly one member, its owner. The
// database refuses every other row, and the runtime's membership readers never
// count a row in a Personal workspace as membership (only the verified owner
// reaches it, through the organization membership's pointer).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  bootstrapWorkspace,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getWorkspaceGrant,
  grantWorkspaceAccess,
  listWorkspaceMembers,
  listWorkspacesForSubject,
  managedPersonalWorkspacePermissions,
  namedSubjectHasLiveWorkspaceAuthority,
  type DbClient,
} from "../src";
import { resolveAppActionTargets } from "../src/app-action-targets";

setDefaultTimeout(120_000);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
// The runtime role, which writes workspace_memberships in production.
let runtime: postgres.Sql | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("personal-workspace-single-member");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[personal-single-member] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }
  client = createDb(shared.appUrl);
  runtime = postgres(shared.appUrl, { max: 1, prepare: false, onnotice: () => undefined });
}, 180_000);

afterAll(async () => {
  await runtime?.end({ timeout: 5 }).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

type Organization = {
  organizationId: string;
  owner: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

async function organization(): Promise<Organization> {
  if (!client) throw new Error("database unavailable");
  const userId = `single-member-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Organization owner",
  });
  const membership = provisioned.organizationMemberships[0]!;
  const sharedWorkspaceId = provisioned.accessContext.workspaceGrants.find(
    (grant) =>
      grant.accountId === membership.organizationId &&
      grant.workspaceId !== membership.personalWorkspaceId,
  )?.workspaceId;
  if (!sharedWorkspaceId) throw new Error("fixture has no shared workspace");
  return {
    organizationId: membership.organizationId,
    owner: `user:${userId}`,
    personalWorkspaceId: membership.personalWorkspaceId!,
    sharedWorkspaceId,
  };
}

/** Invite `subjectId` (a new person unless given) into `org`; returns their Personal workspace there. */
async function join(
  org: Organization,
  role: "member" | "admin",
  subjectId?: string,
): Promise<{ subjectId: string; personalWorkspaceId: string }> {
  if (!client) throw new Error("database unavailable");
  let member = subjectId;
  if (!member) {
    const userId = `single-member-joiner-${crypto.randomUUID()}`;
    member = `user:${userId}`;
    await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Joiner",
    });
  }
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: org.organizationId,
    actorSubjectId: org.owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${member.slice("user:".length)}@example.test`,
    role,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const accepted = await acceptOrganizationInvitation(client.db, {
    organizationId: org.organizationId,
    actorSubjectId: member,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  return { subjectId: member, personalWorkspaceId: accepted.membership.personalWorkspaceId! };
}

const ownerPermissions = JSON.stringify(managedPersonalWorkspacePermissions);
const PERSONAL_WORKSPACE_EXTERNAL_SOURCE = "opengeni:organization-membership";

/** The SQLSTATE a statement fails with, or null when it succeeds. */
async function sqlState(statement: Promise<unknown>): Promise<string | null> {
  return await statement.then(
    () => null,
    (error: unknown) => {
      const code = (error as { code?: unknown }).code;
      return typeof code === "string" ? code : String(error);
    },
  );
}

/** Insert a membership row as the runtime role. */
async function insertMembership(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  role?: string;
  permissions?: string;
}): Promise<string | null> {
  return await sqlState(
    runtime!`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${input.accountId}, ${input.workspaceId}, ${input.subjectId},
        ${input.role ?? "member"}, ${input.permissions ?? ownerPermissions}::text::jsonb)`,
  );
}

async function rowCount(workspaceId: string): Promise<number> {
  const [row] = await shared!.admin<Array<{ count: number }>>`
    select count(*)::int as count from workspace_memberships where workspace_id = ${workspaceId}`;
  return row!.count;
}

describe("a Personal workspace has exactly one member, its owner", () => {
  test("the owner's own row is accepted; nobody else's is", async () => {
    if (!client) return;
    const org = await organization();
    const member = await join(org, "member");

    // Another member of the same organization.
    expect(
      await insertMembership({
        accountId: org.organizationId,
        workspaceId: org.personalWorkspaceId,
        subjectId: member.subjectId,
      }),
    ).toBe("42501");
    // A subject that isn't anyone's.
    expect(
      await insertMembership({
        accountId: org.organizationId,
        workspaceId: org.personalWorkspaceId,
        subjectId: "api_key:00000000-0000-0000-0000-000000000000",
      }),
    ).toBe("42501");
    expect(await rowCount(org.personalWorkspaceId)).toBe(0);

    expect(
      await insertMembership({
        accountId: org.organizationId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.owner,
      }),
    ).toBeNull();
    // A second member next to the owner is still refused.
    expect(
      await insertMembership({
        accountId: org.organizationId,
        workspaceId: org.personalWorkspaceId,
        subjectId: member.subjectId,
      }),
    ).toBe("42501");
    expect(await rowCount(org.personalWorkspaceId)).toBe(1);
  });

  test("an organization owner or admin can't add themselves to a member's Personal workspace", async () => {
    if (!client) return;
    const org = await organization();
    const admin = await join(org, "admin");
    const member = await join(org, "member");

    for (const subjectId of [org.owner, admin.subjectId]) {
      for (const role of ["admin", "member"]) {
        expect(
          await insertMembership({
            accountId: org.organizationId,
            workspaceId: member.personalWorkspaceId,
            subjectId,
            role,
            permissions: JSON.stringify(
              role === "admin" ? ["workspace:admin"] : ["workspace:read"],
            ),
          }),
        ).toBe("42501");
      }
      // Through the application's own member writer too.
      const error = await grantWorkspaceAccess(client.db, {
        accountId: org.organizationId,
        workspaceId: member.personalWorkspaceId,
        subjectId,
        role: "admin",
        permissions: ["workspace:admin"],
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).not.toBeNull();
    }
    expect(await rowCount(member.personalWorkspaceId)).toBe(0);
  });

  test("the owner's row can never administer members, workspace API keys or usage allowances", async () => {
    if (!client) return;
    const org = await organization();
    for (const permission of [
      "workspace:admin",
      "members:manage",
      "api_keys:manage",
      "usage_allowances:manage",
    ]) {
      expect(
        await insertMembership({
          accountId: org.organizationId,
          workspaceId: org.personalWorkspaceId,
          subjectId: org.owner,
          permissions: JSON.stringify(["workspace:read", permission]),
        }),
      ).toBe("42501");
    }
    for (const role of ["owner", "admin"]) {
      expect(
        await insertMembership({
          accountId: org.organizationId,
          workspaceId: org.personalWorkspaceId,
          subjectId: org.owner,
          role,
        }),
      ).toBe("42501");
    }
    expect(
      await insertMembership({
        accountId: org.organizationId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.owner,
      }),
    ).toBeNull();
    // Nor can it be widened afterwards.
    expect(
      await sqlState(runtime!`
        update workspace_memberships
        set permissions = permissions || '["members:manage"]'::jsonb
        where workspace_id = ${org.personalWorkspaceId}`),
    ).toBe("42501");
    expect(
      await sqlState(runtime!`
        update workspace_memberships set role = 'admin'
        where workspace_id = ${org.personalWorkspaceId}`),
    ).toBe("42501");
  });

  test("a row can't move into, out of, or within a Personal workspace", async () => {
    if (!client) return;
    const org = await organization();
    const member = await join(org, "member");
    expect(
      await insertMembership({
        accountId: org.organizationId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.owner,
      }),
    ).toBeNull();

    // The owner's row handed to someone else.
    expect(
      await sqlState(runtime!`
        update workspace_memberships set subject_id = ${member.subjectId}
        where workspace_id = ${org.personalWorkspaceId}`),
    ).toBe("42501");
    // The owner's row moved to a shared workspace.
    expect(
      await sqlState(runtime!`
        update workspace_memberships set workspace_id = ${org.sharedWorkspaceId}
        where workspace_id = ${org.personalWorkspaceId} and subject_id = ${org.owner}`),
    ).toBe("42501");
    // A shared-workspace row moved into someone's Personal workspace, even
    // one that would name the right person.
    const [memberShared] = await shared!.admin<Array<{ id: string }>>`
      select id from workspace_memberships
      where workspace_id = ${org.sharedWorkspaceId} and subject_id = ${member.subjectId}`;
    const sharedRowId =
      memberShared?.id ??
      (
        await shared!.admin<Array<{ id: string }>>`
          insert into workspace_memberships (account_id, workspace_id, subject_id, permissions)
          values (${org.organizationId}, ${org.sharedWorkspaceId}, ${member.subjectId},
            '["workspace:read"]'::jsonb)
          returning id`
      )[0]!.id;
    for (const target of [org.personalWorkspaceId, member.personalWorkspaceId]) {
      expect(
        await sqlState(runtime!`
          update workspace_memberships set workspace_id = ${target} where id = ${sharedRowId}`),
      ).toBe("42501");
    }
    expect(await rowCount(member.personalWorkspaceId)).toBe(0);
    const [owned] = await shared!.admin<Array<{ subjectId: string }>>`
      select subject_id as "subjectId" from workspace_memberships
      where workspace_id = ${org.personalWorkspaceId}`;
    expect(owned?.subjectId).toBe(org.owner);
    // Ordinary edits of the owner's row still work.
    expect(
      await sqlState(runtime!`
        update workspace_memberships set subject_label = 'Owner', updated_at = now()
        where workspace_id = ${org.personalWorkspaceId}`),
    ).toBeNull();
  });

  test("nothing crosses organizations, and a person in two organizations has one row in each", async () => {
    if (!client) return;
    const first = await organization();
    const second = await organization();
    // The first organization's owner joins the second one too.
    const inSecond = await join(second, "member", first.owner);
    expect(inSecond.personalWorkspaceId).not.toBe(first.personalWorkspaceId);

    // Each Personal workspace accepts its owner's row under its own organization.
    expect(
      await insertMembership({
        accountId: first.organizationId,
        workspaceId: first.personalWorkspaceId,
        subjectId: first.owner,
      }),
    ).toBeNull();
    expect(
      await insertMembership({
        accountId: second.organizationId,
        workspaceId: inSecond.personalWorkspaceId,
        subjectId: first.owner,
      }),
    ).toBeNull();
    const rows = await shared!.admin<Array<{ accountId: string; workspaceId: string }>>`
      select account_id as "accountId", workspace_id as "workspaceId"
      from workspace_memberships
      where subject_id = ${first.owner}
        and workspace_id in (${first.personalWorkspaceId}, ${inSecond.personalWorkspaceId})
      order by account_id = ${first.organizationId} desc`;
    expect([...rows]).toEqual([
      { accountId: first.organizationId, workspaceId: first.personalWorkspaceId },
      { accountId: second.organizationId, workspaceId: inSecond.personalWorkspaceId },
    ]);

    // A row naming one organization can't sit in the other's Personal workspace.
    expect(
      await insertMembership({
        accountId: first.organizationId,
        workspaceId: second.personalWorkspaceId,
        subjectId: second.owner,
      }),
    ).not.toBeNull();
    expect(
      await sqlState(runtime!`
        update workspace_memberships set account_id = ${second.organizationId}
        where workspace_id = ${first.personalWorkspaceId}`),
    ).not.toBeNull();
    // An organization membership can't point at someone else's Personal
    // workspace, or at one in another organization.
    for (const target of [inSecond.personalWorkspaceId, second.personalWorkspaceId]) {
      expect(
        await sqlState(shared!.admin`
          update organization_memberships set personal_workspace_id = ${target}
          where account_id = ${first.organizationId} and subject_id = ${first.owner}`),
      ).not.toBeNull();
    }
    const member = await join(first, "member");
    expect(
      await sqlState(shared!.admin`
        update organization_memberships set personal_workspace_id = ${member.personalWorkspaceId}
        where account_id = ${first.organizationId} and subject_id = ${first.owner}`),
    ).toBe("42501");
    // Nor can a membership move to another person while it points at one.
    expect(
      await shared!.admin`
        update organization_memberships set subject_id = ${`user:moved-${crypto.randomUUID()}`}
        where account_id = ${first.organizationId} and subject_id = ${first.owner}`.then(
        () => null,
        (error: unknown) => (error as Error).message,
      ),
    ).toBe("an organization membership can't point at someone else's Personal workspace");
  });

  test("a Personal workspace keeps its identity, and no workspace takes one on", async () => {
    if (!client) return;
    const org = await organization();
    expect(
      await sqlState(runtime!`
        update workspaces set external_id = ${`${org.organizationId}:user:someone-else`}
        where id = ${org.personalWorkspaceId}`),
    ).toBe("42501");
    expect(
      await sqlState(runtime!`
        update workspaces set external_source = 'opengeni:shared'
        where id = ${org.personalWorkspaceId}`),
    ).toBe("42501");
    expect(
      await sqlState(runtime!`
        update workspaces set external_source = ${PERSONAL_WORKSPACE_EXTERNAL_SOURCE},
          external_id = ${`${org.organizationId}:user:someone-else`}
        where id = ${org.sharedWorkspaceId}`),
    ).toBe("42501");
    // Other workspace edits are unaffected.
    expect(
      await sqlState(runtime!`
        update workspaces set updated_at = now() where id = ${org.personalWorkspaceId}`),
    ).toBeNull();
  });
});

describe("a row in a Personal workspace is never membership to the runtime", () => {
  test("bare membership readers ignore the owner's row; the pointer stays the only way in", async () => {
    if (!client) return;
    const org = await organization();
    expect(
      await insertMembership({
        accountId: org.organizationId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.owner,
      }),
    ).toBeNull();

    // Whoever names the owner's subject gets no grant from the row.
    expect(await getWorkspaceGrant(client.db, org.owner, org.personalWorkspaceId)).toBeNull();
    expect(
      (await listWorkspacesForSubject(client.db, org.owner)).map((workspace) => workspace.id),
    ).not.toContain(org.personalWorkspaceId);
    expect(await listWorkspaceMembers(client.db, org.personalWorkspaceId)).toEqual([]);
    const bootstrapped = await bootstrapWorkspace(client.db, {
      accountExternalSource: "opengeni:configured",
      accountExternalId: `bootstrap-${crypto.randomUUID()}`,
      accountName: "Bootstrap",
      workspaceExternalSource: "opengeni:configured",
      workspaceExternalId: `bootstrap-${crypto.randomUUID()}`,
      workspaceName: "Bootstrap",
      subjectId: org.owner,
    });
    expect(bootstrapped.workspaceGrants.map((grant) => grant.workspaceId)).not.toContain(
      org.personalWorkspaceId,
    );
    // The shared workspace's membership is unaffected.
    expect(await getWorkspaceGrant(client.db, org.owner, org.sharedWorkspaceId)).not.toBeNull();

    // An approval card in a shared chat names nothing inside the Personal
    // workspace, and a Personal workspace has no member to name.
    const connectionId = await shared!.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${org.organizationId}, true),
        set_config('opengeni.workspace_id', ${org.personalWorkspaceId}, true),
        set_config('opengeni.subject_id', ${org.owner}, true)`;
      const [row] = await tx<{ id: string }[]>`
        insert into connections (account_id, workspace_id, subject_id, provider_domain, kind,
          status, credential_encrypted, metadata)
        values (${org.organizationId}, ${org.personalWorkspaceId}, ${org.owner},
          'gmail.example', 'oauth2', 'active', 'sealed',
          ${tx.json({ email: "owner@example.test" })})
        returning id::text as id`;
      return row!.id;
    });
    const removal = {
      id: "deleteConnection",
      pathParameters: { workspaceId: org.personalWorkspaceId, connectionId },
      body: { expectedVersion: 1 },
    };
    const fromShared = {
      accountId: org.organizationId,
      workspaceId: org.sharedWorkspaceId,
      subjectId: org.owner,
    };
    expect(await resolveAppActionTargets(client.db, fromShared, removal)).toEqual({});
    const fromPersonal = { ...fromShared, workspaceId: org.personalWorkspaceId };
    expect(
      (
        await resolveAppActionTargets(client.db, fromPersonal, {
          id: "removeWorkspaceMember",
          pathParameters: { workspaceId: org.personalWorkspaceId, subjectId: org.owner },
        })
      ).subjectId,
    ).toEqual({ kind: "member" });
    // The owner's own chat in Personal still names the connection.
    expect(
      (await resolveAppActionTargets(client.db, fromPersonal, removal)).connectionId,
    ).toMatchObject({ kind: "connection", account: "owner@example.test" });

    // The owner's live authority still comes from the pointer.
    expect(
      await namedSubjectHasLiveWorkspaceAuthority(client.db, {
        accountId: org.organizationId,
        workspaceId: org.personalWorkspaceId,
        subjectId: org.owner,
      }),
    ).toBe(true);
  });
});
