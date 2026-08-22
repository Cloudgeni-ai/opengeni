import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let userId = "";
let subjectId = "";
let accountId = "";
let authSessionId = "";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-organization-memberships");
  if (!shared) return;

  client = createDb(shared.appUrl);
  userId = `organization-membership-${crypto.randomUUID()}`;
  subjectId = `user:${userId}`;
  authSessionId = `session-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;

  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Organization member', ${email}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at,
      identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;

  app = new Hono();
  registerOrganizationMembershipRoutes(app, {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed" }),
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: authSessionId },
            user: { id: userId, email, name: "Organization member", emailVerified: true },
          },
        }),
      },
    } as never,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (shared && accountId) {
    await shared.admin`delete from managed_accounts where id = ${accountId}`.catch(() => undefined);
  }
  if (shared && userId) {
    await shared.admin`delete from auth_users where id = ${userId}`.catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("organization membership routes", () => {
  test("denies non-managed and delegated principals before database access", async () => {
    const configured = new Hono();
    registerOrganizationMembershipRoutes(configured, {
      db: {} as never,
      settings: testSettings({ productAccessMode: "configured" }),
      managedAuth: null,
    } as ApiRouteDeps);
    expect((await configured.request("http://x/v1/organization-memberships")).status).toBe(401);

    const delegated = new Hono();
    registerOrganizationMembershipRoutes(delegated, {
      db: {} as never,
      settings: testSettings({ productAccessMode: "managed" }),
      managedAuth: {} as never,
    } as ApiRouteDeps);
    expect(
      (
        await delegated.request("http://x/v1/organization-memberships", {
          headers: {
            authorization: "Bearer delegated",
            cookie: "session=present",
          },
        })
      ).status,
    ).toBe(401);
  });

  test("supports registered-user invite, subject-bound acceptance, listing and suspension", async () => {
    if (!shared || !client || !app) return;
    const ownerMembershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const ownerMembershipBody = (await ownerMembershipResponse.json()) as {
      memberships: Array<{ organizationId: string }>;
    };
    accountId = ownerMembershipBody.memberships[0]!.organizationId;

    const targetUserId = `organization-invite-target-${crypto.randomUUID()}`;
    const targetEmail = `${targetUserId}@example.test`;
    const targetSessionId = `session-${crypto.randomUUID()}`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${targetUserId}, 'Invitation target', ${targetEmail}, true)`;
    await shared.admin`
      insert into auth_identities (id, user_id, provider_id, account_id)
      values (${crypto.randomUUID()}, ${targetUserId}, 'credential', ${targetUserId})`;
    const targetIdentity = await synchronizeCanonicalHumanLoginBindings(client.db, targetUserId);
    await shared.admin`
      insert into auth_sessions (
        id, user_id, token, expires_at,
        identity_id, identity_revision, auth_revision
      ) values (
        ${targetSessionId}, ${targetUserId}, ${crypto.randomUUID()}, now() + interval '1 hour',
        ${targetIdentity.identityId}, ${targetIdentity.identityRevision}, ${targetIdentity.authRevision}
      )`;
    const targetApp = new Hono();
    registerOrganizationMembershipRoutes(targetApp, {
      db: client.db,
      settings: testSettings({ productAccessMode: "managed" }),
      managedAuth: {
        api: {
          getSession: async () => ({
            headers: new Headers(),
            response: {
              session: { id: targetSessionId },
              user: {
                id: targetUserId,
                email: targetEmail,
                name: "Invitation target",
                emailVerified: true,
              },
            },
          }),
        },
      } as never,
    } as ApiRouteDeps);

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const inviteResponse = await app.request(`http://x/v1/organizations/${accountId}/invitations`, {
      method: "POST",
      headers: {
        cookie: "session=present",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: targetEmail,
        role: "member",
        expiresAt,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(inviteResponse.status).toBe(201);
    const invitation = (await inviteResponse.json()) as {
      id: string;
      revision: number;
    };
    expect(invitation).not.toHaveProperty("targetRegistrationStatus");
    const [storedBeforeBinding] = await shared.admin<Array<{ targetSubjectId: string | null }>>`
      select target_subject_id as "targetSubjectId"
      from organization_membership_invitations
      where id = ${invitation.id}`;
    expect(storedBeforeBinding?.targetSubjectId).toBeNull();
    const targetInvitations = await targetApp.request("http://x/v1/organization-invitations", {
      headers: { cookie: "session=present" },
    });
    expect(targetInvitations.status).toBe(200);
    const targetInvitationsBody = (await targetInvitations.json()) as {
      invitations: Array<{ id: string; revision: number }>;
      nextCursor: string | null;
    };
    expect(targetInvitationsBody.nextCursor).toBeNull();
    const listedInvitation = targetInvitationsBody.invitations.find(
      (candidate) => candidate.id === invitation.id,
    );
    expect(listedInvitation).toBeDefined();
    expect(listedInvitation).not.toHaveProperty("targetRegistrationStatus");
    const [storedAfterBinding] = await shared.admin<Array<{ targetSubjectId: string | null }>>`
      select target_subject_id as "targetSubjectId"
      from organization_membership_invitations
      where id = ${invitation.id}`;
    expect(storedAfterBinding?.targetSubjectId).toBe(`user:${targetUserId}`);
    expect(
      (
        await targetApp.request("http://x/v1/organization-invitations?limit=101", {
          headers: { cookie: "session=present" },
        })
      ).status,
    ).toBe(422);

    const acceptResponse = await targetApp.request(
      `http://x/v1/organization-invitations/${invitation.id}/accept`,
      {
        method: "POST",
        headers: {
          cookie: "session=present",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedRevision: listedInvitation!.revision,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(acceptResponse.status).toBe(200);
    const accepted = (await acceptResponse.json()) as {
      membership: {
        id: string;
        authorizationRevision: number;
        subjectId: string;
      };
    };
    expect(accepted.membership.subjectId).toBe(`user:${targetUserId}`);

    const memberList = await app.request(`http://x/v1/organizations/${accountId}/members`, {
      headers: { cookie: "session=present" },
    });
    expect(memberList.status).toBe(200);
    expect(((await memberList.json()) as { members: unknown[] }).members).toHaveLength(2);
    const organizationInvitations = await app.request(
      `http://x/v1/organizations/${accountId}/invitations?limit=1`,
      { headers: { cookie: "session=present" } },
    );
    expect(organizationInvitations.status).toBe(200);
    expect(
      ((await organizationInvitations.json()) as { invitations: unknown[] }).invitations,
    ).toHaveLength(1);
    const memberEnumeration = await targetApp.request(
      `http://x/v1/organizations/${accountId}/invitations`,
      { headers: { cookie: "session=present" } },
    );
    expect(memberEnumeration.status).toBe(403);
    const memberEmailProbe = await targetApp.request(
      `http://x/v1/organizations/${accountId}/invitations`,
      {
        method: "POST",
        headers: {
          cookie: "session=present",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: `${crypto.randomUUID()}@example.test`,
          role: "member",
          expiresAt,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(memberEmailProbe.status).toBe(403);
    const suspendResponse = await app.request(
      `http://x/v1/organizations/${accountId}/members/${accepted.membership.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: "session=present",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "suspend",
          expectedAuthorizationRevision: accepted.membership.authorizationRevision,
          operationId: crypto.randomUUID(),
          reason: "temporary leave",
        }),
      },
    );
    expect(suspendResponse.status).toBe(200);
    expect((await suspendResponse.json()) as { status: string }).toMatchObject({
      status: "suspended",
    });
    for (const retentionDays of [29, 91]) {
      const rejectedRetention = await app.request(
        `http://x/v1/organizations/${accountId}/retention-policy`,
        {
          method: "PATCH",
          headers: {
            cookie: "session=present",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "delete_after",
            retentionDays,
            expectedVersion: 1,
            operationId: crypto.randomUUID(),
          }),
        },
      );
      expect(rejectedRetention.status).toBe(422);
    }
  });

  test("creates a non-enumerating invitation before the email is registered", async () => {
    if (!app) return;
    const membershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const membershipBody = (await membershipResponse.json()) as {
      memberships: Array<{ organizationId: string }>;
    };
    accountId = membershipBody.memberships[0]!.organizationId;
    const email = `not-registered-${crypto.randomUUID()}@example.test`;
    const response = await app.request(`http://x/v1/organizations/${accountId}/invitations`, {
      method: "POST",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Future teammate",
        initialWorkspaceIds: [],
        role: "member",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        operationId: crypto.randomUUID(),
      }),
    });
    expect(response.status).toBe(201);
    const invitation = await response.json();
    expect(invitation).toMatchObject({
      targetEmail: email,
      targetName: "Future teammate",
      initialWorkspaceIds: [],
      status: "pending",
    });
    expect(invitation).not.toHaveProperty("targetRegistrationStatus");
  });

  test("exposes owner-managed private-session settings behind readiness", async () => {
    if (!shared || !client || !app) return;
    const membershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const membershipBody = (await membershipResponse.json()) as {
      memberships: Array<{ organizationId: string }>;
    };
    accountId = membershipBody.memberships[0]!.organizationId;
    const endpoint = `http://x/v1/organizations/${accountId}/private-session-settings`;
    const [ownerMembership] = await shared.admin<Array<{ id: string }>>`
      select id from organization_memberships
      where account_id = ${accountId} and subject_id = ${subjectId}`;
    if (!ownerMembership) throw new Error("owner membership missing");

    const otherUserId = `private-settings-idor-${crypto.randomUUID()}`;
    const otherAccess = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: otherUserId,
      email: `${otherUserId}@example.test`,
      name: "Other organization owner",
    });
    const otherOrganizationId = otherAccess.organizationMemberships[0]?.accountId;
    if (!otherOrganizationId) throw new Error("other organization missing");
    const otherEndpoint = `http://x/v1/organizations/${otherOrganizationId}/private-session-settings`;
    expect(
      (await app.request(otherEndpoint, { headers: { cookie: "session=present" } })).status,
    ).toBe(403);
    expect(
      (
        await app.request(otherEndpoint, {
          method: "PATCH",
          headers: { cookie: "session=present", "content-type": "application/json" },
          body: JSON.stringify({
            enabled: false,
            expectedVersion: 0,
            operationId: crypto.randomUUID(),
          }),
        })
      ).status,
    ).toBe(403);

    const initial = await app.request(endpoint, { headers: { cookie: "session=present" } });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      organizationId: accountId,
      enabled: false,
      available: false,
      version: 0,
    });

    const beforeReadiness = await app.request(endpoint, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(beforeReadiness.status).toBe(409);

    const memberShapedRequest = await app.request(endpoint, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
        membershipId: crypto.randomUUID(),
      }),
    });
    expect(memberShapedRequest.status).toBe(422);

    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'api-settings-test')`;
    const enabled = await app.request(endpoint, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      organizationId: accountId,
      enabled: true,
      available: true,
      version: 1,
      changed: true,
    });

    await shared.admin`
      update organization_memberships set role = 'member'
      where id = ${ownerMembership.id}`;
    const memberGet = await app.request(endpoint, { headers: { cookie: "session=present" } });
    const memberPatch = await app.request(endpoint, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        expectedVersion: 1,
        operationId: crypto.randomUUID(),
      }),
    });
    await shared.admin`
      update organization_memberships set role = 'owner'
      where id = ${ownerMembership.id}`;
    expect(memberGet.status).toBe(403);
    expect(memberPatch.status).toBe(403);
  });

  test("renames the canonical organization and inventories every shared workspace without Personal workspaces", async () => {
    if (!shared || !app) return;
    const membershipResponse = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const membershipBody = (await membershipResponse.json()) as {
      memberships: Array<{ organizationId: string; personalWorkspaceId: string }>;
    };
    accountId = membershipBody.memberships[0]!.organizationId;
    const personalWorkspaceId = membershipBody.memberships[0]!.personalWorkspaceId;
    const sharedWorkspaceId = crypto.randomUUID();
    const serviceSubject = `service:${crypto.randomUUID()}`;
    await shared.admin`
      insert into workspaces (id, account_id, name, external_source, external_id)
      values (
        ${sharedWorkspaceId}, ${accountId}, 'Company platform', 'test', ${crypto.randomUUID()}
      )`;
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${accountId}, ${sharedWorkspaceId}, ${subjectId}, 'Organization member', 'admin',
        ${shared.admin.json(["sessions:read", "workspace:read"])}::jsonb
      ), (
        ${accountId}, ${sharedWorkspaceId}, ${serviceSubject}, 'Deployment automation', 'service',
        ${shared.admin.json(["workspace:read"])}::jsonb
      )`;

    const overviewResponse = await app.request(`http://x/v1/organizations/${accountId}/overview`, {
      headers: { cookie: "session=present" },
    });
    expect(overviewResponse.status).toBe(200);
    const overview = (await overviewResponse.json()) as {
      organization: { name: string; updatedAt: string };
      workspaces: Array<{
        id: string;
        name: string;
        members: Array<{ subjectId: string; subjectLabel: string; principalKind: string }>;
      }>;
    };
    expect(overview.workspaces.map((workspace) => workspace.id)).toContain(sharedWorkspaceId);
    expect(overview.workspaces.map((workspace) => workspace.id)).not.toContain(personalWorkspaceId);
    expect(
      overview.workspaces.find((workspace) => workspace.id === sharedWorkspaceId),
    ).toMatchObject({
      name: "Company platform",
      members: [
        expect.objectContaining({
          subjectId: serviceSubject,
          subjectLabel: "Deployment automation",
          principalKind: "service",
        }),
        expect.objectContaining({
          subjectId,
          subjectLabel: "Organization member",
          principalKind: "human",
        }),
      ],
    });

    const operationId = crypto.randomUUID();
    const rename = await app.request(`http://x/v1/organizations/${accountId}`, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Acme Engineering",
        expectedUpdatedAt: overview.organization.updatedAt,
        operationId,
      }),
    });
    expect(rename.status).toBe(200);
    const renamed = (await rename.json()) as { name: string; updatedAt: string };
    expect(renamed).toMatchObject({ name: "Acme Engineering" });

    const secondRename = await app.request(`http://x/v1/organizations/${accountId}`, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Acme Product",
        expectedUpdatedAt: renamed.updatedAt,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(secondRename.status).toBe(200);
    expect(await secondRename.json()).toMatchObject({ name: "Acme Product" });

    const replay = await app.request(`http://x/v1/organizations/${accountId}`, {
      method: "PATCH",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Acme Engineering",
        expectedUpdatedAt: overview.organization.updatedAt,
        operationId,
      }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(renamed);

    // An ordinary managed-session bootstrap must not overwrite the name with
    // the user's profile name after an administrator has deliberately renamed it.
    await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    const afterBootstrap = await app.request(`http://x/v1/organizations/${accountId}/overview`, {
      headers: { cookie: "session=present" },
    });
    expect(await afterBootstrap.json()).toMatchObject({
      organization: { name: "Acme Product" },
    });
  }, 180_000);

  test("returns only the current active membership and denies terminal membership state", async () => {
    if (!shared || !app) return;

    const response = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      memberships: Array<{
        id: string;
        organizationId: string;
        status: string;
        personalWorkspaceId: string;
      }>;
    };
    expect(body.memberships).toHaveLength(1);
    accountId = body.memberships[0]!.organizationId;

    const [stored] = await shared.admin<
      Array<{
        id: string;
        accountId: string;
        status: string;
        personalWorkspaceId: string;
      }>
    >`
      select
        id,
        account_id as "accountId",
        status,
        personal_workspace_id as "personalWorkspaceId"
      from organization_memberships
      where account_id = ${accountId}
        and subject_id = ${subjectId}`;
    expect(body).toEqual({
      memberships: [
        {
          id: stored!.id,
          organizationId: stored!.accountId,
          status: "active",
          personalWorkspaceId: stored!.personalWorkspaceId,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(subjectId);
    expect(JSON.stringify(body)).not.toContain("retention");

    await shared.admin`
      update organization_memberships
      set status = 'suspended', revoked_at = null
      where account_id = ${accountId}
        and subject_id = ${subjectId}`;
    const denied = await app.request("http://x/v1/organization-memberships", {
      headers: { cookie: "session=present" },
    });
    expect(denied.status).toBe(403);
    // This minimal route harness has no application-level JSON error adapter,
    // so bare Hono renders HTTPException messages as plain text.
    expect(await denied.text()).toBe("organization membership is not active");
  });
});
