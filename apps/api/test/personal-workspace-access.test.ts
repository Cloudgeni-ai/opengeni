import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessContext, Workspace } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createApiKey,
  createDb,
  createWorkspace,
  ensureManagedAccessForUserWithOrganizationMemberships,
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
import { registerApiKeyRoutes, organizationApiKeyPermissions } from "../src/routes/api-keys";
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
  // Before 0348 the managed-cookie access resolver materialised this
  // organization implicitly on the first `/v1/access/me`. That implicit
  // provisioning is exactly what the post-sign-in onboarding gate replaces, so
  // this fixture now states the premise it always relied on.
  await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email,
    name: "Personal workspace owner",
    emailVerified: true,
  });
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
  const deps = {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed" }),
    managedAuth: {
      api: {
        getSession: async (input: { headers: Headers }) =>
          input.headers.get("cookie")
            ? {
                headers: new Headers(),
                response: {
                  session: { id: authSessionId },
                  user: { id: userId, email, name: "Personal workspace owner" },
                },
              }
            : { headers: new Headers(), response: null },
      },
    } as never,
  } as ApiRouteDeps;
  registerApiKeyRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
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

  test("organization API keys manage shared workspaces while personal workspaces stay excluded", async () => {
    if (!shared || !client || !app) return;

    const sharedWorkspace = await createWorkspace(client.db, {
      accountId,
      name: "External tenant workspace",
    });
    expect(
      (
        await app.request(`http://x/v1/workspaces/${sharedWorkspace.id}`, {
          headers: { authorization: `Bearer ${accountAdminToken}` },
        })
      ).status,
    ).toBe(403);
    const legacyAccountInventory = await app.request("http://x/v1/workspaces", {
      headers: { authorization: `Bearer ${accountAdminToken}` },
    });
    expect(legacyAccountInventory.status).toBe(200);
    expect(await legacyAccountInventory.json()).toEqual([]);

    const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client.db, {
      accountId,
      workspaceId: null,
      name: "Organization workspace operator",
      prefix: token.slice(0, 14),
      keyHash: await sha256Hex(token),
      permissions: organizationApiKeyPermissions,
    });
    const headers = { authorization: `Bearer ${token}` };

    const accessResponse = await app.request("http://x/v1/access/me", { headers });
    expect(accessResponse.status).toBe(200);
    const keyAccess = (await accessResponse.json()) as AccessContext;
    expect(keyAccess.workspaceGrants).toEqual([]);
    expect(keyAccess.accountGrants[0]?.permissions).toEqual([
      "account:read",
      "workspace:create",
      "api_keys:manage",
    ]);

    const listResponse = await app.request("http://x/v1/workspaces", { headers });
    expect(listResponse.status).toBe(200);
    const workspaces = (await listResponse.json()) as Workspace[];
    expect(workspaces.map((workspace) => workspace.id)).toContain(sharedWorkspace.id);
    expect(workspaces.map((workspace) => workspace.id)).not.toContain(personalWorkspaceId);
    expect(workspaces.every((workspace) => workspace.kind === "shared")).toBe(true);

    expect(
      (
        await app.request(`http://x/v1/workspaces/${sharedWorkspace.id}`, {
          headers,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`http://x/v1/workspaces/${personalWorkspaceId}`, {
          headers,
        })
      ).status,
    ).toBe(403);

    const personalKeyResponse = await app.request(
      `http://x/v1/workspaces/${personalWorkspaceId}/api-keys`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "forbidden", permissions: ["workspace:read"] }),
      },
    );
    expect(personalKeyResponse.status).toBe(403);

    const firstEnsure = await app.request("http://x/v1/workspaces/external", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        externalSource: "personal-workspace-access-test",
        externalId: "tenant-1",
        name: "Tenant one",
        slug: "tenant-one",
      }),
    });
    expect(firstEnsure.status).toBe(201);
    const firstBody = (await firstEnsure.json()) as { workspace: Workspace; created: boolean };
    expect(firstBody.created).toBe(true);
    expect(firstBody.workspace).toMatchObject({
      accountId,
      kind: "shared",
      name: "Tenant one",
      slug: "tenant-one",
    });

    const replayEnsure = await app.request("http://x/v1/workspaces/external", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        externalSource: "personal-workspace-access-test",
        externalId: "tenant-1",
        name: "Stale renamed tenant",
        slug: "stale-slug",
      }),
    });
    expect(replayEnsure.status).toBe(200);
    const replayBody = (await replayEnsure.json()) as { workspace: Workspace; created: boolean };
    expect(replayBody.created).toBe(false);
    expect(replayBody.workspace.id).toBe(firstBody.workspace.id);
    expect(replayBody.workspace.name).toBe("Tenant one");
    expect(replayBody.workspace.slug).toBe("tenant-one");

    const [membershipCount] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from workspace_memberships
      where workspace_id = ${firstBody.workspace.id}`;
    expect(membershipCount).toEqual({ count: 0 });
  });

  test("organization API key routes isolate null-workspace keys and support rotation", async () => {
    if (!shared || !client || !app) return;

    const createdResponse = await app.request(`http://x/v1/organizations/${accountId}/api-keys`, {
      method: "POST",
      headers: { cookie: "session=present", "content-type": "application/json" },
      body: JSON.stringify({ name: "Primary integration", description: "External product" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      apiKey: { id: string; workspaceId: string | null; permissions: string[] };
      token: string;
    };
    expect(created.apiKey.workspaceId).toBeNull();
    expect(created.apiKey.permissions).toEqual(organizationApiKeyPermissions);
    expect(created.token).toStartWith("ogk_");

    const workspace = await createWorkspace(client.db, {
      accountId,
      name: "Workspace-key isolation",
    });
    const workspaceToken = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    const workspaceKey = await createApiKey(client.db, {
      accountId,
      workspaceId: workspace.id,
      name: "Narrow workspace key",
      prefix: workspaceToken.slice(0, 14),
      keyHash: await sha256Hex(workspaceToken),
      permissions: ["workspace:read"],
    });

    const listResponse = await app.request(`http://x/v1/organizations/${accountId}/api-keys`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as { apiKeys: Array<{ id: string }> };
    expect(listed.apiKeys.map((key) => key.id)).toContain(created.apiKey.id);
    expect(listed.apiKeys.map((key) => key.id)).not.toContain(workspaceKey.id);

    const replacementResponse = await app.request(
      `http://x/v1/organizations/${accountId}/api-keys`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Replacement integration" }),
      },
    );
    expect(replacementResponse.status).toBe(201);

    const wrongScopeDelete = await app.request(
      `http://x/v1/organizations/${accountId}/api-keys/${workspaceKey.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${created.token}` } },
    );
    expect(wrongScopeDelete.status).toBe(404);

    const revokeResponse = await app.request(
      `http://x/v1/organizations/${accountId}/api-keys/${created.apiKey.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${created.token}` } },
    );
    expect(revokeResponse.status).toBe(200);
    expect(await revokeResponse.json()).toMatchObject({ id: created.apiKey.id });
    expect(
      (
        await app.request(`http://x/v1/organizations/${accountId}/api-keys`, {
          headers: { authorization: `Bearer ${created.token}` },
        })
      ).status,
    ).toBe(401);
  });
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
