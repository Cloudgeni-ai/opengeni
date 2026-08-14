import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessContext, Workspace } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createApiKey,
  createDb,
  managedPersonalWorkspacePermissions,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let userId = "";
let accountId = "";
let personalWorkspaceId = "";
let accountAdminToken = "";
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
    shared = await acquireSharedTestDatabase("api-personal-workspace-access");
  }
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[api-personal-workspace-access] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (!shared) return;

  client = createDb(shared.appUrl);
  userId = `personal-workspace-owner-${crypto.randomUUID()}`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;

  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Personal workspace owner', ${email}, true)`;
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
  registerWorkspaceRoutes(app, {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed" }),
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: authSessionId },
            user: { id: userId, email, name: "Personal workspace owner" },
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

describe("managed personal workspace access", () => {
  test("projects only the owning managed human and preserves the legacy default", async () => {
    if (!shared || !client || !app) return;

    const accessResponse = await app.request("http://x/v1/access/me", {
      headers: { cookie: "session=present" },
    });
    expect(accessResponse.status).toBe(200);
    const access = (await accessResponse.json()) as AccessContext;
    expect(access.workspaceGrants).toHaveLength(2);
    expect(access.workspaceGrants[0]?.workspaceId).toBe(access.defaultWorkspaceId);

    accountId = access.defaultAccountId!;
    const [storedMembership] = await shared.admin<Array<{ personalWorkspaceId: string }>>`
      select personal_workspace_id as "personalWorkspaceId"
      from organization_memberships
      where account_id = ${accountId}
        and subject_id = ${access.subjectId}`;
    personalWorkspaceId = storedMembership!.personalWorkspaceId;

    expect(access.workspaceGrants[1]).toEqual({
      workspaceId: personalWorkspaceId,
      accountId,
      subjectId: access.subjectId,
      subjectLabel: access.subjectLabel,
      permissions: managedPersonalWorkspacePermissions,
      principalKind: "human_session",
    });

    const listResponse = await app.request("http://x/v1/workspaces", {
      headers: { cookie: "session=present" },
    });
    expect(listResponse.status).toBe(200);
    const workspaces = (await listResponse.json()) as Workspace[];
    expect(workspaces.map(({ id }) => id)).toEqual([
      access.defaultWorkspaceId,
      personalWorkspaceId,
    ]);

    const personalResponse = await app.request(`http://x/v1/workspaces/${personalWorkspaceId}`, {
      headers: { cookie: "session=present" },
    });
    expect(personalResponse.status).toBe(200);
    expect((await personalResponse.json()) as Workspace).toMatchObject({
      id: personalWorkspaceId,
      accountId,
      name: "Personal workspace",
    });

    const [personalMembershipCount] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from workspace_memberships
      where workspace_id = ${personalWorkspaceId}`;
    expect(personalMembershipCount).toEqual({ count: 0 });

    accountAdminToken = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client.db, {
      accountId,
      workspaceId: null,
      name: "Account admin without personal access",
      prefix: accountAdminToken.slice(0, 14),
      keyHash: await sha256Hex(accountAdminToken),
      permissions: ["account:read", "account:admin"],
    });
    const denied = await app.request(`http://x/v1/workspaces/${personalWorkspaceId}`, {
      headers: { authorization: `Bearer ${accountAdminToken}` },
    });
    expect(denied.status).toBe(403);
  });
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
