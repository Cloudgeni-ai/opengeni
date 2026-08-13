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
    expect(await denied.json()).toEqual({
      message: "organization membership is not active",
    });
  });
});
