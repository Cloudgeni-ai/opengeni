import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  deleteWorkspace,
  ensureManagedAccessForUser,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { resolveCatalogSettings, type ApiRouteDeps } from "@opengeni/core";
import { Hono } from "hono";
import postgres from "postgres";
import { registerSuperGrokRoutes } from "../src/routes/supergrok";

const DELEGATION_SECRET = "supergrok-routes-delegation-secret";
const STATE_SECRET = "supergrok-routes-state-secret";
const PUBLIC_ORIGIN = "https://app.opengeni.test";
const encryptionKey = Buffer.alloc(32, 61);
const externalAdminUrl = process.env.OPENGENI_SUPERGROK_POSTGRES_ADMIN_URL?.trim();
const externalAppUrl = process.env.OPENGENI_SUPERGROK_POSTGRES_APP_URL?.trim();

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let accountId = "";
let workspaceId = "";
let subjectId = "";
let managedAccountId = "";
let managedWorkspaceId = "";
let managedSubjectId = "";
let managedApp: Hono | null = null;
let available = true;
let deviceSequence = 0;
let userinfoRequests = 0;

const settings = testSettings({
  productAccessMode: "configured",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  supergrokSubscriptionEnabled: true,
});
const managedSettings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  publicBaseUrl: PUBLIC_ORIGIN,
  supergrokSubscriptionEnabled: true,
});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const xaiFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/oauth2/device/code")) {
    deviceSequence += 1;
    return Response.json({
      device_code: `device-${deviceSequence}`,
      user_code: `XAI-${deviceSequence}234`,
      verification_uri: "https://accounts.x.ai/device",
      verification_uri_complete: `https://accounts.x.ai/device?code=XAI-${deviceSequence}234`,
      expires_in: 600,
      interval: 1,
    });
  }
  if (url.endsWith("/oauth2/token")) {
    const body = String(init?.body ?? "");
    if (body.includes("grant_type=refresh_token")) {
      return Response.json({
        access_token: "access-refreshed",
        refresh_token: "refresh-refreshed",
        expires_in: 3600,
      });
    }
    return Response.json({
      access_token: jwt({
        principal_type: "User",
        principal_id: "xai-user-1",
        exp: Math.floor(Date.now() / 1_000) + 3_600,
      }),
      refresh_token: `refresh-${deviceSequence}`,
      id_token: jwt({
        sub: "xai-user-1",
        email: "owner@example.com",
        email_verified: true,
        name: "Owner",
      }),
      expires_in: 3600,
    });
  }
  if (url.endsWith("/oauth2/userinfo")) {
    userinfoRequests += 1;
    throw new Error("device connection must not call xAI userinfo");
  }
  if (url.endsWith("/models")) {
    return Response.json({
      data: [
        {
          id: "grok-4.6",
          name: "Grok 4.6",
          contextWindow: 256_000,
          apiBackend: "responses",
        },
        {
          id: "grok-4.5",
          name: "Grok 4.5",
          contextWindow: 256_000,
          apiBackend: "responses",
        },
      ],
    });
  }
  throw new Error(`unexpected xAI request: ${url}`);
};

beforeAll(async () => {
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_SUPERGROK_POSTGRES_ADMIN_URL and OPENGENI_SUPERGROK_POSTGRES_APP_URL",
    );
  }
  shared =
    externalAdminUrl && externalAppUrl
      ? {
          admin: postgres(externalAdminUrl, { max: 8, prepare: false }),
          adminUrl: externalAdminUrl,
          appUrl: externalAppUrl,
          release: async () => undefined,
        }
      : await acquireSharedTestDatabase("api-supergrok-routes");
  if (!shared) {
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  subjectId = `user:supergrok-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `supergrok-account-${crypto.randomUUID()}`,
    accountName: "SuperGrok route account",
    workspaceExternalSource: "test",
    workspaceExternalId: `supergrok-workspace-${crypto.randomUUID()}`,
    workspaceName: "SuperGrok route workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  accountId = grant.accountId;
  workspaceId = grant.workspaceId;
  await shared.admin`
    update workspace_memberships
    set permissions = '["workspace:read", "workspace:admin", "connections:write"]'::jsonb
    where workspace_id = ${workspaceId} and subject_id = ${subjectId}`;
  app = new Hono();
  registerSuperGrokRoutes(app, {
    db: client.db,
    settings,
    resolveCatalogSettings: async () => await resolveCatalogSettings(client!.db, settings),
    githubStateSecret: STATE_SECRET,
    xaiFetch,
    managedAuth: null,
  } as ApiRouteDeps);

  const managedUserId = `supergrok-managed-${crypto.randomUUID()}`;
  const managedSessionId = `managed-session-${managedUserId}`;
  const managedEmail = `${managedUserId}@example.test`;
  managedSubjectId = `user:${managedUserId}`;
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${managedUserId}, 'Private Owner', ${managedEmail}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${managedUserId}, 'credential', ${managedUserId})`;
  const managedIdentity = await synchronizeCanonicalHumanLoginBindings(client.db, managedUserId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at,
      identity_id, identity_revision, auth_revision
    ) values (
      ${managedSessionId}, ${managedUserId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${managedIdentity.identityId}, ${managedIdentity.identityRevision},
      ${managedIdentity.authRevision}
    )`;
  const managedAccess = await ensureManagedAccessForUser(client.db, {
    userId: managedUserId,
    email: managedEmail,
    name: "Private Owner",
  });
  managedAccountId = managedAccess.defaultAccountId!;
  managedWorkspaceId = managedAccess.defaultWorkspaceId!;
  const managedAuth = {
    api: {
      getSession: async () => ({
        headers: new Headers(),
        response: {
          session: {
            id: managedSessionId,
            userId: managedUserId,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
          user: {
            id: managedUserId,
            email: managedEmail,
            name: "Private Owner",
          },
        },
      }),
    },
  };
  managedApp = new Hono();
  registerSuperGrokRoutes(managedApp, {
    db: client.db,
    settings: managedSettings,
    resolveCatalogSettings: async () => await resolveCatalogSettings(client!.db, managedSettings),
    githubStateSecret: STATE_SECRET,
    xaiFetch,
    managedAuth: managedAuth as never,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  if (shared && managedAccountId) {
    await shared.admin`
      delete from managed_accounts where id = ${managedAccountId}`.catch(() => undefined);
  }
  await client?.close();
  if (externalAdminUrl) {
    await shared?.admin.end().catch(() => undefined);
  } else {
    await shared?.release();
  }
}, 60_000);

async function bearer(
  permissions: Permission[] = ["workspace:read", "workspace:admin"],
): Promise<string> {
  return await delegatedBearer({
    accountId,
    workspaceId,
    subjectId,
    permissions,
  });
}

async function delegatedBearer(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  permissions: Permission[];
}): Promise<string> {
  return await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    principalKind: "human_session",
    permissions: input.permissions,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
}

async function request(
  path: string,
  options: { method?: string; body?: unknown; permissions?: Permission[] } = {},
): Promise<Response> {
  return await app!.request(`http://x/v1/workspaces/${workspaceId}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${await bearer(options.permissions)}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function connectWorkspaceAccount(): Promise<{ accountId: string }> {
  const start = await request("/supergrok/connect/start", {
    method: "POST",
    body: {},
  });
  expect(start.status).toBe(200);
  const started = await start.json();
  expect(started).toMatchObject({
    scope: "workspace",
    intervalSeconds: 1,
    expiresInSeconds: 600,
  });
  expect(started.userCode).toStartWith("XAI-");
  const poll = await request("/supergrok/connect/poll", {
    method: "POST",
    body: { state: started.state },
  });
  expect(poll.status).toBe(200);
  const connected = await poll.json();
  expect(connected).toMatchObject({
    status: "connected",
    scope: "workspace",
    isActive: true,
    email: "owner@example.com",
  });
  return { accountId: connected.accountId };
}

async function managedRequest(
  path: string,
  options: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  return await managedApp!.request(`${PUBLIC_ORIGIN}/v1/workspaces/${managedWorkspaceId}${path}`, {
    method,
    headers: {
      ...(options.bearer
        ? { authorization: `Bearer ${options.bearer}` }
        : { cookie: "better-auth.session_token=private-owner" }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" || options.bearer
        ? {}
        : { origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("SuperGrok subscription routes", () => {
  test("workspace-default connect, health, OCC, reconnect, and disconnect stay metadata-only", async () => {
    if (!available) return;
    const connected = await connectWorkspaceAccount();

    const listed = await request("/supergrok/accounts");
    expect(listed.status).toBe(200);
    const firstList = await listed.json();
    expect(firstList).toMatchObject({
      activeAccountId: connected.accountId,
      settings: {
        rotationEnabled: true,
        rotationStrategy: "sharded",
        activeCredentialId: connected.accountId,
      },
    });
    expect(firstList.accounts).toHaveLength(1);
    expect(firstList.accounts[0]).toMatchObject({
      id: connected.accountId,
      scope: "workspace",
      subject: "xai-user-1",
      email: "owner@example.com",
      label: "Owner",
      status: "active",
      active: true,
      allocatorEnabled: true,
      allocatorVersion: 1,
    });
    const serialized = JSON.stringify(firstList);
    expect(serialized).not.toContain("access-");
    expect(serialized).not.toContain("refresh-");
    expect(serialized).not.toContain("credentialEncrypted");
    expect(userinfoRequests).toBe(0);

    const status = await request("/supergrok/status");
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { models: Array<{ id: string }> };
    expect(statusBody).toMatchObject({
      connected: true,
      valid: true,
      accountCount: 1,
      activeAccount: {
        id: connected.accountId,
        subject: "xai-user-1",
        scope: "workspace",
      },
      models: [{ id: "supergrok/grok-4.6", provider: "supergrok" }],
    });
    expect(statusBody.models.map((model) => model.id)).toEqual(["supergrok/grok-4.6"]);

    const renamed = await request(`/supergrok/accounts/${connected.accountId}`, {
      method: "PATCH",
      body: { label: "Primary Grok" },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      label: "Primary Grok",
      active: true,
    });

    const disabled = await request(`/supergrok/accounts/${connected.accountId}/allocator`, {
      method: "PATCH",
      body: { enabled: false, expectedVersion: 1 },
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      allocatorEnabled: false,
      allocatorVersion: 2,
      changed: true,
    });

    const staleConflict = await request(`/supergrok/accounts/${connected.accountId}/allocator`, {
      method: "PATCH",
      body: { enabled: true, expectedVersion: 1 },
    });
    expect(staleConflict.status).toBe(409);
    expect(await staleConflict.json()).toMatchObject({
      allocatorEnabled: false,
      allocatorVersion: 2,
      changed: false,
    });

    const staleIdempotent = await request(`/supergrok/accounts/${connected.accountId}/allocator`, {
      method: "PATCH",
      body: { enabled: false, expectedVersion: 1 },
    });
    expect(staleIdempotent.status).toBe(200);
    expect(await staleIdempotent.json()).toMatchObject({
      allocatorEnabled: false,
      allocatorVersion: 2,
      changed: false,
    });

    const activated = await request(`/supergrok/accounts/${connected.accountId}/activate`, {
      method: "POST",
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toEqual({
      activated: true,
      accountId: connected.accountId,
    });

    const settingsUpdate = await request("/supergrok/settings", {
      method: "PATCH",
      body: { rotationEnabled: false },
    });
    expect(settingsUpdate.status).toBe(200);
    expect(await settingsUpdate.json()).toMatchObject({
      rotationEnabled: false,
      rotationStrategy: "sharded",
      activeCredentialId: connected.accountId,
    });

    const reconnected = await connectWorkspaceAccount();
    expect(reconnected.accountId).toBe(connected.accountId);
    const afterReconnect = await request("/supergrok/accounts");
    expect((await afterReconnect.json()).accounts).toHaveLength(1);

    const privateStart = await request("/supergrok/connect/start", {
      method: "POST",
      body: { scope: "user" },
      permissions: ["workspace:read", "connections:write"],
    });
    expect(privateStart.status).toBe(403);

    const disconnected = await request(`/supergrok/accounts/${connected.accountId}`, {
      method: "DELETE",
    });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({
      disconnected: true,
      newActiveId: null,
    });

    const empty = await request("/supergrok/accounts");
    expect(await empty.json()).toMatchObject({
      accounts: [],
      activeAccountId: null,
    });
  });

  test("private accounts require the exact same-origin managed browser and never accept bearer borrowing", async () => {
    if (!available) return;
    const crossSite = await managedApp!.request(
      `${PUBLIC_ORIGIN}/v1/workspaces/${managedWorkspaceId}/supergrok/connect/start`,
      {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=private-owner",
          "content-type": "application/json",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ scope: "user" }),
      },
    );
    expect(crossSite.status).toBe(403);

    const start = await managedRequest("/supergrok/connect/start", {
      method: "POST",
      body: { scope: "user" },
    });
    expect(start.status).toBe(200);
    const started = await start.json();
    expect(started).toMatchObject({ scope: "user", intervalSeconds: 1 });

    const poll = await managedRequest("/supergrok/connect/poll", {
      method: "POST",
      body: { state: started.state },
    });
    expect(poll.status).toBe(200);
    const connected = await poll.json();
    expect(connected).toMatchObject({
      status: "connected",
      scope: "user",
      isActive: true,
    });

    const listed = await managedRequest("/supergrok/accounts");
    expect(listed.status).toBe(200);
    const privateList = await listed.json();
    expect(privateList.accounts).toHaveLength(1);
    expect(privateList.accounts[0]).toMatchObject({
      id: connected.accountId,
      scope: "user",
    });
    expect(JSON.stringify(privateList)).not.toContain("access-");
    expect(JSON.stringify(privateList)).not.toContain("refresh-");

    const sameHumanBearer = await delegatedBearer({
      accountId: managedAccountId,
      workspaceId: managedWorkspaceId,
      subjectId: managedSubjectId,
      permissions: ["workspace:read", "connections:write"],
    });
    const bearerRead = await managedRequest("/supergrok/accounts", {
      bearer: sameHumanBearer,
    });
    expect(bearerRead.status).toBe(403);
    const bearerMutation = await managedRequest(`/supergrok/accounts/${connected.accountId}`, {
      method: "DELETE",
      bearer: sameHumanBearer,
    });
    expect(bearerMutation.status).toBe(403);

    const disconnected = await managedRequest(`/supergrok/accounts/${connected.accountId}`, {
      method: "DELETE",
      body: {},
    });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({
      disconnected: true,
      newActiveId: null,
    });
  });
});
