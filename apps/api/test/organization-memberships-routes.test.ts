import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
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
            user: { id: userId, email, name: "Organization member" },
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
    const targetInvitations = await targetApp.request("http://x/v1/organization-invitations", {
      headers: { cookie: "session=present" },
    });
    expect(targetInvitations.status).toBe(200);
    expect(await targetInvitations.json()).toMatchObject({
      invitations: [expect.objectContaining({ id: invitation.id })],
      nextCursor: null,
    });
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
          expectedRevision: invitation.revision,
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
