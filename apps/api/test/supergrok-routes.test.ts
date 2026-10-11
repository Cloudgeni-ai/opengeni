// opengeni:test-shared-postgres-exclusive
import { registerModelConnectionAccessRoutes } from "../src/routes/model-connection-access";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { createDb, ensureManagedAccessForUser, type DbClient } from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireOwnerMigratedTestDatabase,
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
let managedAccountId = "";
let managedWorkspaceId = "";
let managedPersonalWorkspaceId = "";
let managedSubjectId = "";
let managedApp: Hono | null = null;
let available = true;
let deviceSequence = 0;
let userinfoRequests = 0;
let providerSubject = "xai-user-1";

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
        principal_id: providerSubject,
        exp: Math.floor(Date.now() / 1_000) + 3_600,
      }),
      refresh_token: `refresh-${deviceSequence}`,
      id_token: jwt({
        sub: providerSubject,
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
      : await (async () => {
          const owned = await acquireOwnerMigratedTestDatabase("api-supergrok-routes");
          if (!owned) return null;
          await migrate(owned.ownerUrl);
          await provisionRoles(owned.adminUrl, {
            appPassword: owned.appPassword,
            rlsStrategy: "force",
          });
          const appUrl = new URL(owned.ownerUrl);
          appUrl.username = "opengeni_app";
          appUrl.password = owned.appPassword;
          return { ...owned, appUrl: appUrl.toString() };
        })();
  if (!shared) {
    available = false;
    return;
  }
  client = createDb(shared.appUrl);

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
  // A private SuperGrok account connects only from its owner's Personal
  // workspace on the shared core.
  const [membership] = await shared.admin<{ personal_workspace_id: string }[]>`
    select personal_workspace_id::text from organization_memberships
    where account_id = ${managedAccountId} and subject_id = ${managedSubjectId}`;
  managedPersonalWorkspaceId = membership!.personal_workspace_id;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${managedAccountId}, ${managedPersonalWorkspaceId}, ${managedSubjectId}, 'owner',
      '["workspace:read", "workspace:admin", "connections:write"]'::jsonb)
    on conflict do nothing`;
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
  const managedDeps = {
    db: client.db,
    settings: managedSettings,
    resolveCatalogSettings: async () => await resolveCatalogSettings(client!.db, managedSettings),
    githubStateSecret: STATE_SECRET,
    xaiFetch,
    managedAuth: managedAuth as never,
  } as ApiRouteDeps;
  registerSuperGrokRoutes(managedApp, managedDeps);
  registerModelConnectionAccessRoutes(managedApp, managedDeps);
  registerWorkspaceRoutes(managedApp, managedDeps);
}, 180_000);

afterAll(async () => {
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

async function managedRequest(
  path: string,
  options: { method?: string; body?: unknown; bearer?: string; workspaceId?: string } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const workspace = options.workspaceId ?? managedWorkspaceId;
  return await managedApp!.request(`${PUBLIC_ORIGIN}/v1/workspaces/${workspace}${path}`, {
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
  test("private accounts require the exact same-origin managed browser and never accept bearer borrowing", async () => {
    if (!available) return;
    const crossSite = await managedApp!.request(
      `${PUBLIC_ORIGIN}/v1/workspaces/${managedPersonalWorkspaceId}/supergrok/connect/start`,
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
      workspaceId: managedPersonalWorkspaceId,
    });
    expect({
      status: start.status,
      ...(start.status !== 200 ? { body: await start.clone().text() } : {}),
    }).toEqual({ status: 200 });
    const started = await start.json();
    expect(started).toMatchObject({ scope: "user", intervalSeconds: 1 });

    const poll = await managedRequest("/supergrok/connect/poll", {
      method: "POST",
      body: { state: started.state },
      workspaceId: managedPersonalWorkspaceId,
    });
    expect(poll.status).toBe(200);
    const connected = await poll.json();
    // The shared core leaves the primary unset on a first connect.
    expect(connected).toMatchObject({
      status: "connected",
      scope: "user",
      isActive: false,
    });

    const listed = await managedRequest("/supergrok/accounts", {
      workspaceId: managedPersonalWorkspaceId,
    });
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
      workspaceId: managedPersonalWorkspaceId,
      subjectId: managedSubjectId,
      permissions: ["workspace:read", "connections:write"],
    });
    const bearerRead = await managedRequest("/supergrok/accounts", {
      bearer: sameHumanBearer,
      workspaceId: managedPersonalWorkspaceId,
    });
    expect(bearerRead.status).toBe(403);
    const bearerMutation = await managedRequest(`/supergrok/accounts/${connected.accountId}`, {
      method: "DELETE",
      bearer: sameHumanBearer,
      workspaceId: managedPersonalWorkspaceId,
    });
    expect(bearerMutation.status).toBe(403);

    const disconnected = await managedRequest(`/supergrok/accounts/${connected.accountId}`, {
      method: "DELETE",
      body: {},
      workspaceId: managedPersonalWorkspaceId,
    });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({
      disconnected: true,
      newActiveId: null,
    });
  });
});

test("organization subscriptions use device login, multiple accounts, inherited reads, and administrator-only changes", async () => {
  if (!available || !managedApp) return;
  const requestOrganization = (
    path: string,
    method = "GET",
    body?: unknown,
    authorization?: string,
  ) =>
    managedApp!.request(`${PUBLIC_ORIGIN}/v1/organizations/${managedAccountId}/supergrok${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: PUBLIC_ORIGIN,
        "sec-fetch-site": "same-origin",
        ...(authorization
          ? { authorization: `Bearer ${authorization}` }
          : { cookie: "better-auth.session_token=private-owner" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ids: string[] = [];
  for (const identity of ["organization-first", "organization-second"]) {
    providerSubject = identity;
    const start = await requestOrganization("/connect/start", "POST", {});
    expect(start.status).toBe(200);
    const code = await start.json();
    expect(code.scope).toBe("organization");
    expect(code.deviceCode).toBeUndefined();
    const poll = await requestOrganization("/connect/poll", "POST", { state: code.state });
    expect(poll.status).toBe(200);
    const connected = await poll.json();
    expect(connected.scope).toBe("organization");
    ids.push(connected.accountId);
  }
  expect(new Set(ids).size).toBe(2);
  const listed = await requestOrganization("/accounts");
  const accounts = await listed.json();
  expect(accounts.accounts).toHaveLength(2);
  // The shared core leaves the primary unset until one is activated.
  expect(accounts.activeAccountId).toBeNull();
  expect(JSON.stringify(accounts)).not.toContain("refresh-");
  expect((await requestOrganization(`/accounts/${ids[1]}/activate`, "POST", {})).status).toBe(200);
  expect((await requestOrganization("/settings", "PATCH", { rotationEnabled: true })).status).toBe(
    200,
  );
  expect(
    (await requestOrganization(`/accounts/${ids[1]}`, "PATCH", { label: "Second subscription" }))
      .status,
  ).toBe(200);
  const inherited = await managedRequest("/supergrok/accounts");
  expect(inherited.status).toBe(200);
  expect(await inherited.json()).toMatchObject({
    source: "organization",
    activeAccountId: ids[1],
    settings: { rotationEnabled: true },
  });
  expect(
    (
      await managedRequest(`/supergrok/accounts/${ids[1]}`, {
        method: "PATCH",
        body: { label: "workspace takeover" },
      })
    ).status,
  ).toBe(409);
  const token = await delegatedBearer({
    accountId: managedAccountId,
    workspaceId: managedWorkspaceId,
    subjectId: managedSubjectId,
    permissions: ["workspace:read", "workspace:admin"],
  });
  expect((await requestOrganization("/accounts", "GET", undefined, token)).status).toBe(401);
  const crossOrigin = await managedApp.request(
    `${PUBLIC_ORIGIN}/v1/organizations/${managedAccountId}/supergrok/connect/start`,
    {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=private-owner",
        "content-type": "application/json",
        origin: "https://other.test",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    },
  );
  expect(crossOrigin.status).toBe(403);
  const accessPath = (id: string) =>
    `${PUBLIC_ORIGIN}/v1/organizations/${managedAccountId}/model-connections/supergrok/${id}/access`;
  const accessHeaders = {
    "content-type": "application/json",
    origin: PUBLIC_ORIGIN,
    "sec-fetch-site": "same-origin",
    cookie: "better-auth.session_token=private-owner",
  };
  for (const id of ids) {
    const policyResponse = await managedApp.request(accessPath(id), { headers: accessHeaders });
    expect(policyResponse.status).toBe(200);
    const response = await policyResponse.json();
    expect(response.policy.allowedModels).toBeNull();
    expect(response.personalWorkspacesSupported).toBe(true);
    expect(
      response.models.every((model: { id: string }) => model.id.startsWith("supergrok/")),
    ).toBe(true);
    expect(JSON.stringify(response)).not.toContain("access-");
    const body = JSON.stringify({ ...response.policy, allowedModels: [] });
    expect(
      (
        await managedApp.request(accessPath(id), {
          method: "PUT",
          headers: { ...accessHeaders, origin: "https://other.test" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (await managedApp.request(accessPath(id), { method: "PUT", headers: accessHeaders, body }))
        .status,
    ).toBe(200);
    expect(
      (await managedApp.request(accessPath(id), { method: "PUT", headers: accessHeaders, body }))
        .status,
    ).toBe(409);
    expect(
      (await managedApp.request(accessPath(id), { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(401);
  }
  const restrictedCatalog = await managedRequest("/model-catalog");
  expect(restrictedCatalog.status).toBe(200);
  const catalog = await restrictedCatalog.json();
  expect(
    catalog.models
      .filter((model: { id: string }) => model.id.startsWith("supergrok/"))
      .every((model: { policyAllowed: boolean }) => !model.policyAllowed),
  ).toBe(true);
  for (const id of ids)
    expect((await requestOrganization(`/accounts/${id}`, "DELETE")).status).toBe(200);
  providerSubject = "xai-user-1";
});
