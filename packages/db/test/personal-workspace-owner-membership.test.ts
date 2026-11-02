// Migration 1231: a managed human's Personal workspace has exactly one
// workspace_memberships row, its owner's, and the row follows the owner's
// organization membership. The 1159 guard still refuses every other row.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  checkOrganizationTenancyParity,
  createAdditionalManagedOrganization,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getWorkspaceGrant,
  grantWorkspaceAccess,
  managedPersonalWorkspacePermissions,
  updateOrganizationMember,
  type DbClient,
} from "../src";

setDefaultTimeout(120_000);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
// The runtime role, which writes workspace_memberships in production.
let runtime: postgres.Sql | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("personal-workspace-owner-membership");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[personal-owner-row] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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

type Person = { userId: string; subjectId: string };
type Organization = { organizationId: string; owner: Person; personalWorkspaceId: string };

function person(label: string): Person {
  const userId = `owner-row-${label}-${crypto.randomUUID()}`;
  return { userId, subjectId: `user:${userId}` };
}

async function provision(who: Person) {
  return await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId: who.userId,
    email: `${who.userId}@example.test`,
    name: "Owner row",
  });
}

async function organization(): Promise<Organization> {
  const owner = person("owner");
  const membership = (await provision(owner)).organizationMemberships[0]!;
  return {
    organizationId: membership.organizationId,
    owner,
    personalWorkspaceId: membership.personalWorkspaceId!,
  };
}

/** Invite a new person (or `who`) into `org` and return their membership there. */
async function join(org: Organization, role: "member" | "admin", who = person("joiner")) {
  await provision(who);
  const invitation = await createOrganizationInvitation(client!.db, {
    organizationId: org.organizationId,
    actorSubjectId: org.owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: who.subjectId,
    targetEmail: `${who.userId}@example.test`,
    role,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const accepted = await acceptOrganizationInvitation(client!.db, {
    organizationId: org.organizationId,
    actorSubjectId: who.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  return { ...who, membership: accepted.membership };
}

type Row = {
  accountId: string;
  subjectId: string;
  role: string;
  permissions: string[];
};

async function rows(workspaceId: string): Promise<Row[]> {
  return [
    ...(await shared!.admin<Row[]>`
      select account_id as "accountId", subject_id as "subjectId", role, permissions
      from workspace_memberships where workspace_id = ${workspaceId} order by subject_id`),
  ];
}

function ownerRow(accountId: string, subjectId: string): Row {
  return { accountId, subjectId, role: "member", permissions: managedPersonalWorkspacePermissions };
}

async function sqlState(statement: Promise<unknown>): Promise<string | null> {
  return await statement.then(
    () => null,
    (error: unknown) => {
      const code = (error as { code?: unknown }).code;
      return typeof code === "string" ? code : String(error);
    },
  );
}

async function transition(
  org: Organization,
  member: { membership: { id: string } },
  kind: "suspend" | "reactivate" | "offboard",
) {
  const [current] = await shared!.admin<Array<{ revision: number }>>`
    select authorization_revision::int as revision from organization_memberships
    where id = ${member.membership.id}`;
  return await updateOrganizationMember(client!.db, {
    organizationId: org.organizationId,
    actorSubjectId: org.owner.subjectId,
    operationId: crypto.randomUUID(),
    membershipId: member.membership.id,
    transition: {
      kind,
      expectedAuthorizationRevision: current!.revision,
      operationId: crypto.randomUUID(),
    },
  });
}

describe("a Personal workspace's owner has one real membership row", () => {
  test("the SQL owner permissions are the TypeScript managed Personal permissions", async () => {
    if (!client) return;
    const [row] = await shared!.admin<Array<{ permissions: string[] }>>`
      select personal_workspace_owner_permissions() as permissions`;
    expect(row!.permissions).toEqual(managedPersonalWorkspacePermissions);
    for (const administering of [
      "workspace:admin",
      "members:manage",
      "api_keys:manage",
      "usage_allowances:manage",
    ]) {
      expect(row!.permissions).not.toContain(administering);
    }
  });

  test("provisioning creates exactly the owner's row, and provisioning again keeps it", async () => {
    if (!client) return;
    const org = await organization();
    expect(await rows(org.personalWorkspaceId)).toEqual([
      ownerRow(org.organizationId, org.owner.subjectId),
    ]);
    // Signing in again runs the same provisioning; it accepts its own row.
    const again = await provision(org.owner);
    expect(again.organizationMemberships[0]!.personalWorkspaceId).toBe(org.personalWorkspaceId);
    expect(await rows(org.personalWorkspaceId)).toEqual([
      ownerRow(org.organizationId, org.owner.subjectId),
    ]);
    // The runtime still reaches Personal only through the verified pointer.
    expect(
      await getWorkspaceGrant(client.db, org.owner.subjectId, org.personalWorkspaceId),
    ).toBeNull();
    // The tenancy parity gate accepts exactly this row.
    const parity = await checkOrganizationTenancyParity(client.db, {
      organizationId: org.organizationId,
    });
    expect(
      parity.gates.find((gate) => gate.id === "personal_workspace_has_no_membership_row")?.status,
    ).toBe("pass");
  });

  test("the owner's permissions in another order are still the owner's row", async () => {
    if (!client) return;
    const org = await organization();
    // The guard compares the permission sets, so a reordered row is accepted;
    // provisioning and the parity gate must compare them the same way.
    await shared!.admin`
      update workspace_memberships
      set permissions = (select jsonb_agg(value order by ordinality desc)
        from jsonb_array_elements(permissions) with ordinality)
      where workspace_id = ${org.personalWorkspaceId}`;
    const [reordered] = await shared!.admin<Array<{ permissions: string[] }>>`
      select permissions from workspace_memberships where workspace_id = ${org.personalWorkspaceId}`;
    expect(reordered!.permissions).toEqual([...managedPersonalWorkspacePermissions].reverse());
    const again = await provision(org.owner);
    expect(again.organizationMemberships[0]!.personalWorkspaceId).toBe(org.personalWorkspaceId);
    const parity = await checkOrganizationTenancyParity(client.db, {
      organizationId: org.organizationId,
    });
    expect(
      parity.gates.find((gate) => gate.id === "personal_workspace_has_no_membership_row")?.status,
    ).toBe("pass");
  });

  test("a second member, an organization admin, or a moved row is refused", async () => {
    if (!client) return;
    const org = await organization();
    const admin = await join(org, "admin");
    const member = await join(org, "member");
    for (const subjectId of [member.subjectId, admin.subjectId, org.owner.subjectId]) {
      // The owner already has the one row (23505); anyone else is refused (42501).
      expect(
        await sqlState(runtime!`
          insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
          values (${org.organizationId}, ${member.membership.personalWorkspaceId}, ${subjectId},
            'member', ${JSON.stringify(managedPersonalWorkspacePermissions)}::text::jsonb)`),
      ).toBe(subjectId === member.subjectId ? "23505" : "42501");
      const error = await grantWorkspaceAccess(client.db, {
        accountId: org.organizationId,
        workspaceId: member.membership.personalWorkspaceId!,
        subjectId,
        role: "admin",
        permissions: ["workspace:admin"],
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).not.toBeNull();
    }
    // The owner's row can't be handed to someone else, moved, or reshaped.
    for (const change of [
      runtime!`update workspace_memberships set subject_id = ${admin.subjectId}
        where workspace_id = ${member.membership.personalWorkspaceId}`,
      runtime!`update workspace_memberships set workspace_id = ${org.personalWorkspaceId}
        where workspace_id = ${member.membership.personalWorkspaceId}`,
      runtime!`update workspace_memberships set permissions = '["workspace:read"]'::jsonb
        where workspace_id = ${member.membership.personalWorkspaceId}`,
      runtime!`update workspace_memberships set role = 'viewer'
        where workspace_id = ${member.membership.personalWorkspaceId}`,
    ]) {
      expect(await sqlState(change)).toBe("42501");
    }
    expect(await rows(member.membership.personalWorkspaceId!)).toEqual([
      ownerRow(org.organizationId, member.subjectId),
    ]);
  });

  test("the row follows suspension, reactivation and offboarding", async () => {
    if (!client) return;
    const org = await organization();
    const member = await join(org, "member");
    const personal = member.membership.personalWorkspaceId!;
    expect(await rows(personal)).toEqual([ownerRow(org.organizationId, member.subjectId)]);

    await transition(org, member, "suspend");
    expect(await rows(personal)).toEqual([]);
    await transition(org, member, "reactivate");
    expect(await rows(personal)).toEqual([ownerRow(org.organizationId, member.subjectId)]);

    const offboarded = await transition(org, member, "offboard");
    expect(offboarded.status).toBe("revoked");
    // The retained Personal workspace keeps its data but has no member.
    const [workspace] = await shared!.admin<Array<{ id: string }>>`
      select id from workspaces where id = ${personal}`;
    expect(workspace?.id).toBe(personal);
    expect(await rows(personal)).toEqual([]);
  });

  test("the row follows the membership's pointer", async () => {
    if (!client) return;
    const org = await organization();
    const member = await join(org, "member");
    const personal = member.membership.personalWorkspaceId!;
    // Pointing the membership elsewhere (here: suspended, so it may be unset)
    // removes the row, and pointing it back while active restores it.
    await shared!.admin`
      update organization_memberships set status = 'suspended', personal_workspace_id = null
      where id = ${member.membership.id}`;
    expect(await rows(personal)).toEqual([]);
    await shared!.admin`
      update organization_memberships set status = 'active', personal_workspace_id = ${personal}
      where id = ${member.membership.id}`;
    expect(await rows(personal)).toEqual([ownerRow(org.organizationId, member.subjectId)]);
  });

  test("nothing crosses organizations: a person in two organizations has a row in each", async () => {
    if (!client) return;
    const first = await organization();
    const second = await organization();
    const inSecond = await join(second, "member", first.owner);
    const secondPersonal = inSecond.membership.personalWorkspaceId!;
    expect(secondPersonal).not.toBe(first.personalWorkspaceId);
    expect(await rows(first.personalWorkspaceId)).toEqual([
      ownerRow(first.organizationId, first.owner.subjectId),
    ]);
    expect(await rows(secondPersonal)).toEqual([
      ownerRow(second.organizationId, first.owner.subjectId),
    ]);
    const everywhere = await shared!.admin<Array<{ accountId: string; workspaceId: string }>>`
      select account_id as "accountId", workspace_id as "workspaceId" from workspace_memberships
      where subject_id = ${first.owner.subjectId}
        and workspace_id in (${first.personalWorkspaceId}, ${secondPersonal},
          ${second.personalWorkspaceId})
      order by account_id = ${first.organizationId} desc`;
    expect([...everywhere]).toEqual([
      { accountId: first.organizationId, workspaceId: first.personalWorkspaceId },
      { accountId: second.organizationId, workspaceId: secondPersonal },
    ]);
    // Suspending them in one organization leaves the other row alone.
    await transition(second, inSecond, "suspend");
    expect(await rows(secondPersonal)).toEqual([]);
    expect(await rows(first.personalWorkspaceId)).toEqual([
      ownerRow(first.organizationId, first.owner.subjectId),
    ]);
    // A row naming one organization can't sit in the other's Personal workspace.
    expect(
      await sqlState(runtime!`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
        values (${first.organizationId}, ${secondPersonal}, ${first.owner.subjectId},
          'member', ${JSON.stringify(managedPersonalWorkspacePermissions)}::text::jsonb)`),
    ).not.toBeNull();
  });

  test("a new organization's setup creates the creator's Personal row and passes its graph check", async () => {
    if (!client) return;
    const org = await organization();
    await shared!.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${org.owner.userId}, 'Owner row', ${`${org.owner.userId}@example.test`}, true)
      on conflict (id) do update set email_verified = true`;
    const created = await createAdditionalManagedOrganization(client.db, {
      subjectId: org.owner.subjectId,
      subjectLabel: "Owner row",
      name: `Second ${crypto.randomUUID().slice(0, 8)}`,
      workspaceName: "Team",
      operationId: crypto.randomUUID(),
    });
    // Setup checks the new organization's exact graph (one Personal and one
    // shared workspace, only the creator's rows) before activating it; it
    // refused the owner's Personal row before 1231.
    expect(await rows(created.personalWorkspaceId)).toEqual([
      ownerRow(created.organization.id, org.owner.subjectId),
    ]);
    // The new organization's shared workspace keeps only the creator's admin row.
    const team = await rows(created.workspaceId);
    expect(team.map((row) => [row.subjectId, row.role])).toEqual([[org.owner.subjectId, "admin"]]);
  });

  test("the parity gate reports any other row in a Personal workspace", async () => {
    if (!client) return;
    const org = await organization();
    const member = await join(org, "member");
    // A row written before 1159's guard existed (the guard is bypassed here).
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
        values (${org.organizationId}, ${member.membership.personalWorkspaceId}, ${org.owner.subjectId},
          'admin', '["workspace:admin"]'::jsonb)`;
    });
    const parity = await checkOrganizationTenancyParity(client.db, {
      organizationId: org.organizationId,
    });
    const gate = parity.gates.find(
      (entry) => entry.id === "personal_workspace_has_no_membership_row",
    );
    expect(gate?.status).toBe("fail");
    expect(gate?.evidence).toEqual([member.membership.personalWorkspaceId!]);
  });
});
