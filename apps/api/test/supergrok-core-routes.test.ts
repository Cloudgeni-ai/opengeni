/**
 * M4 X2b: the SuperGrok routes on the shared subscription core, on real
 * PostgreSQL as the application role. Without the SuperGrok (`xai`) cutover
 * receipt the legacy routes answer; with the receipt and no switch row every
 * route fails closed with the typed 503; with an enabled switch row the same
 * paths, verbs and response shapes are served from core connections
 * (connect, list, rename, allocator, activate, rotation, reconnect,
 * disconnect, the access policy).
 *
 * X3 ships SuperGrok's registry entry; this historical fixture withholds its
 * migration and then inserts the receipt explicitly. Run this file in
 * its own process: the registration replaces module bindings process-wide.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { Context, Hono as HonoApp } from "hono";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const opengeniDb = await import("@opengeni/db");
const { resolveCatalogSettings } = await import("@opengeni/core");
const { Hono } = await import("hono");
const { registerSuperGrokRoutes } = await import("../src/routes/supergrok");
const { registerModelConnectionAccessRoutes } =
  await import("../src/routes/model-connection-access");
const { subscriptionSettingsLockedHttpError } =
  await import("../src/routes/model-account-settings");
const { synchronizeCanonicalHumanLoginBindings } =
  await import("@opengeni/db/canonical-human-identities");

const DELEGATION_SECRET = "supergrok-core-routes-delegation-secret";
const STATE_SECRET = "supergrok-core-routes-state-secret";
const encryptionKey = Buffer.alloc(32, 67);
const settings = testSettings({
  productAccessMode: "configured",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  supergrokSubscriptionEnabled: true,
});
const PUBLIC_ORIGIN = "https://app.opengeni.test";
const managedSettings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  publicBaseUrl: PUBLIC_ORIGIN,
  supergrokSubscriptionEnabled: true,
});

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof opengeniDb.createDb> | null = null;
let app: HonoApp | null = null;
/** The organization routes: an organization administrator's managed browser session. */
let organizationApp: HonoApp | null = null;
let organizationId = "";
/** The organization administrator's own Personal workspace, and a shared one they belong to. */
let personalWorkspaceId = "";
let managedSharedWorkspaceId = "";
let accountId = "";
let workspaceId = "";
let subjectId = "";
let deviceSequence = 0;
let providerSubject = "xai-core-user-1";
let failDatabaseAfterLogin = false;
let databaseFailure: Error | null = null;

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const xaiFetch: typeof fetch = (async (input: string | URL | Request) => {
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
    if (failDatabaseAfterLogin) {
      databaseFailure = Object.assign(new Error("synthetic database connection loss"), {
        code: "08006",
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
  throw new Error(`unexpected xAI request: ${url}`);
}) as typeof fetch;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-supergrok-core-routes", {
    withheldMigrations: ["0733_subscription_core_xai_cutover.sql"],
  });
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = opengeniDb.createDb(shared.appUrl);
  // An organization administrator in a shared workspace: on the core only
  // an organization administrator connects a new shared account.
  const userId = `supergrok-core-${crypto.randomUUID()}`;
  subjectId = `user:${userId}`;
  const access = await opengeniDb.ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "SuperGrok core route owner",
  });
  accountId = access.workspaceGrants[0]!.accountId;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'SuperGrok core shared') returning id::text as id`;
  workspaceId = workspace!.id;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'owner',
      '["workspace:read", "workspace:admin", "connections:write"]'::jsonb)`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}::uuid, ${accountId}::uuid)`;
  app = new Hono();
  // Fail only the persistence transaction after OAuth succeeds; admission
  // and all ordinary route assertions still use the restricted real-PG role.
  const routeDb = new Proxy(client.db, {
    get(target, property, receiver) {
      if (property === "transaction")
        return (...args: Parameters<typeof target.transaction>) => {
          if (databaseFailure) throw databaseFailure;
          return target.transaction(...args);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const deps = {
    db: routeDb,
    settings,
    resolveCatalogSettings: async () => await resolveCatalogSettings(client!.db, settings),
    githubStateSecret: STATE_SECRET,
    xaiFetch,
    managedAuth: null,
  } as never;
  registerSuperGrokRoutes(app, deps);
  registerModelConnectionAccessRoutes(app, deps);
  // The typed errors as the API renders them (code and details), with the
  // app's central settings-lock mapping.
  const renderTyped = (raw: Error, c: Context) => {
    const error: Error = subscriptionSettingsLockedHttpError(raw) ?? raw;
    const typed = error as {
      status?: number;
      code?: string;
      retryable?: boolean;
      outcomeUnknown?: boolean;
      details?: Record<string, unknown>;
    };
    return c.json(
      {
        code: typed.code ?? null,
        message: error.message,
        ...(typed.details ?? {}),
        ...(typed.retryable === undefined ? {} : { retryable: typed.retryable }),
        ...(typed.outcomeUnknown === undefined ? {} : { outcomeUnknown: typed.outcomeUnknown }),
      },
      (typed.status ?? 500) as 500,
    );
  };
  app.onError(renderTyped);

  // A second organization whose administrator has a managed browser session:
  // the organization routes accept no bearer.
  const managedUserId = `supergrok-core-org-${crypto.randomUUID()}`;
  const managedSessionId = `managed-session-${managedUserId}`;
  const managedEmail = `${managedUserId}@example.test`;
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${managedUserId}, 'Organization Owner', ${managedEmail}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${managedUserId}, 'credential', ${managedUserId})`;
  const managedIdentity = await synchronizeCanonicalHumanLoginBindings(client.db, managedUserId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${managedSessionId}, ${managedUserId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${managedIdentity.identityId}, ${managedIdentity.identityRevision},
      ${managedIdentity.authRevision}
    )`;
  const managedAccess = await opengeniDb.ensureManagedAccessForUser(client.db, {
    userId: managedUserId,
    email: managedEmail,
    name: "Organization Owner",
  });
  organizationId = managedAccess.defaultAccountId!;
  const [personal] = await shared.admin<{ id: string }[]>`
    select personal_workspace_id::text as id from organization_memberships
    where account_id = ${organizationId}::uuid and subject_id = ${`user:${managedUserId}`}`;
  personalWorkspaceId = personal!.id;
  const [managedShared] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${organizationId}::uuid, 'SuperGrok core managed shared') returning id::text as id`;
  managedSharedWorkspaceId = managedShared!.id;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${organizationId}::uuid, ${managedSharedWorkspaceId}::uuid, ${`user:${managedUserId}`},
      'member', '["workspace:read", "connections:write"]'::jsonb)`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${managedSharedWorkspaceId}::uuid, ${organizationId}::uuid)
    on conflict do nothing`;
  organizationApp = new Hono();
  const managedDeps = {
    db: client.db,
    settings: managedSettings,
    resolveCatalogSettings: async () => await resolveCatalogSettings(client!.db, managedSettings),
    githubStateSecret: STATE_SECRET,
    xaiFetch,
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: {
              id: managedSessionId,
              userId: managedUserId,
              expiresAt: new Date(Date.now() + 3_600_000),
            },
            user: { id: managedUserId, email: managedEmail, name: "Organization Owner" },
          },
        }),
      },
    },
  } as never;
  registerSuperGrokRoutes(organizationApp, managedDeps);
  organizationApp.onError(renderTyped);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function request(
  path: string,
  options: { method?: string; body?: unknown; permissions?: Permission[]; subject?: string } = {},
): Promise<Response> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId: options.subject ?? subjectId,
    principalKind: "human_session",
    permissions: options.permissions ?? ["workspace:read", "workspace:admin"],
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return await app!.request(`http://x/v1/workspaces/${workspaceId}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function connectWorkspaceAccount(): Promise<{ accountId: string; isActive: boolean }> {
  const start = await request("/supergrok/connect/start", { method: "POST", body: {} });
  expect(start.status).toBe(200);
  const started = await start.json();
  expect(started).toMatchObject({ scope: "workspace", intervalSeconds: 1, expiresInSeconds: 600 });
  const poll = await request("/supergrok/connect/poll", {
    method: "POST",
    body: { state: started.state },
  });
  const connected = await poll.json();
  expect({ status: poll.status, body: connected }).toMatchObject({
    status: 200,
    body: { status: "connected", scope: "workspace", email: "owner@example.com" },
  });
  return { accountId: connected.accountId, isActive: connected.isActive };
}

/** A workspace SuperGrok route as any bearer human (organization, workspace and subject given). */
async function bearerRequest(
  target: { accountId: string; workspaceId: string; subjectId: string },
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: target.accountId,
    workspaceId: target.workspaceId,
    subjectId: target.subjectId,
    principalKind: "human_session",
    permissions: ["workspace:read", "workspace:admin", "connections:write"],
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return await app!.request(`http://x/v1/workspaces/${target.workspaceId}/supergrok${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/** Another active member of an organization, with their own Personal workspace. */
async function otherMember(organization: string) {
  const member = `user:supergrok-core-member-${crypto.randomUUID()}`;
  const [personal] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${organization}::uuid, 'Member personal') returning id::text as id`;
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${organization}::uuid, ${member}, 'member', 'active', ${personal!.id}::uuid)`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${personal!.id}::uuid, ${organization}::uuid) on conflict do nothing`;
  return { subjectId: member, personalWorkspaceId: personal!.id };
}

async function organizationRequest(path: string, method = "GET", body?: unknown) {
  return await organizationApp!.request(
    `${PUBLIC_ORIGIN}/v1/organizations/${organizationId}/supergrok${path}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        origin: PUBLIC_ORIGIN,
        "sec-fetch-site": "same-origin",
        cookie: "better-auth.session_token=organization-owner",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

async function connectOrganizationAccount(subject: string): Promise<string> {
  providerSubject = subject;
  const start = await organizationRequest("/connect/start", "POST", {});
  expect(start.status).toBe(200);
  const started = await start.json();
  const poll = await organizationRequest("/connect/poll", "POST", { state: started.state });
  const connected = await poll.json();
  expect({ status: poll.status, body: connected }).toMatchObject({
    status: 200,
    body: { status: "connected", scope: "organization", isActive: false },
  });
  return connected.accountId;
}

/** A workspace route as the organization administrator's managed browser session. */
async function browserWorkspaceRequest(
  workspace: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  return await organizationApp!.request(
    `${PUBLIC_ORIGIN}/v1/workspaces/${workspace}/supergrok${path}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        origin: PUBLIC_ORIGIN,
        "sec-fetch-site": "same-origin",
        cookie: "better-auth.session_token=organization-owner",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

/** The account list with its volatile fields (timestamps) removed. */
async function listed() {
  const response = await request("/supergrok/accounts");
  expect(response.status).toBe(200);
  return (await response.json()) as {
    accounts: Array<Record<string, unknown>>;
    activeAccountId: string | null;
    settings: Record<string, unknown>;
  };
}

let legacyEmpty: unknown = null;
let legacyShape: { top: string[]; account: string[]; settings: string[] } | null = null;

function shapeOf(body: Awaited<ReturnType<typeof listed>>) {
  return {
    top: Object.keys(body).sort(),
    account: Object.keys(body.accounts[0]!).sort(),
    settings: Object.keys(body.settings).sort(),
  };
}

describe.skipIf(!realDb)("SuperGrok routes on the shared core (M4 X2b)", () => {
  test("runs as the non-superuser, non-bypass application role", async () => {
    const roles = await client!.db.execute<{
      currentUser: string;
      superuser: boolean;
      bypassRls: boolean;
    }>(opengeniDb.dbSql`select current_user as "currentUser", rolsuper as superuser,
        rolbypassrls as "bypassRls"
      from pg_catalog.pg_roles where rolname = current_user`);
    expect([...roles]).toEqual([
      { currentUser: "opengeni_app", superuser: false, bypassRls: false },
    ]);
  });

  test("without the receipt the legacy routes answer", async () => {
    legacyEmpty = await listed();
    expect(legacyEmpty).toMatchObject({ accounts: [], activeAccountId: null });
    // The legacy connect, listing and disconnect: the shape the core must keep.
    const connected = await connectWorkspaceAccount();
    expect(connected.isActive).toBe(true);
    const listing = await listed();
    expect(listing.accounts).toHaveLength(1);
    legacyShape = shapeOf(listing);
    const disconnected = await request(`/supergrok/accounts/${connected.accountId}`, {
      method: "DELETE",
    });
    expect(disconnected.status).toBe(200);
    expect(await listed()).toEqual(legacyEmpty as never);
    const [core] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_connections where provider = 'xai'`;
    expect(core!.count).toBe(0);
  });

  async function expectRetryableConnectPollDatabaseFailure() {
    const start = await request("/supergrok/connect/start", { method: "POST", body: {} });
    expect(start.status).toBe(200);
    failDatabaseAfterLogin = true;
    try {
      const poll = await request("/supergrok/connect/poll", {
        method: "POST",
        body: { state: (await start.json()).state },
      });
      expect({ status: poll.status, body: await poll.json() }).toMatchObject({
        status: 503,
        body: { code: "DATABASE_UNAVAILABLE", retryable: true, outcomeUnknown: true },
      });
    } finally {
      failDatabaseAfterLogin = false;
      databaseFailure = null;
    }
  }

  test(
    "legacy connect-poll database loss is a retryable 503 with unknown mutation outcome",
    expectRetryableConnectPollDatabaseFailure,
  );

  test("after the receipt, without an enabled switch row, every route fails closed", async () => {
    await shared!.admin`
      insert into opengeni_private.subscription_core_providers (provider, extra_credits,
        primary_setting_column)
      values ('xai', false, 'xai_primary_connection_id')`;
    await shared!.admin`
      insert into opengeni_private.subscription_provider_cutover_receipts (
        provider, migration, committed_at, seed_rotation
      ) values ('xai', '0799_subscription_core_xai_cutover.sql', clock_timestamp(),
        '{"mode":"spread"}')`;
    for (const [path, method, body] of [
      ["/supergrok/accounts", "GET", undefined],
      ["/supergrok/connect/start", "POST", {}],
      ["/supergrok/settings", "PATCH", { rotationEnabled: false }],
      [`/supergrok/accounts/${crypto.randomUUID()}`, "DELETE", undefined],
    ] as const) {
      const response = await request(path, { method, ...(body ? { body } : {}) });
      expect({ path, status: response.status, body: await response.json() }).toMatchObject({
        path,
        status: 503,
        body: { reason: "subscription_core_cutover_disabled" },
      });
    }
  });

  test("with the switch row the same routes answer from core connections", async () => {
    await shared!.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${accountId}::uuid, 'xai', true)`;
    // An empty pool reads as the legacy empty pool.
    expect(await listed()).toEqual(legacyEmpty as never);

    // The core leaves the primary unset on a first connect (as for Codex): the
    // pool fails over across every eligible account until one is activated,
    // so the new account is not reported active.
    const connected = await connectWorkspaceAccount();
    expect(connected.isActive).toBe(false);
    const first = await listed();
    expect(first).toMatchObject({
      activeAccountId: null,
      settings: { rotationEnabled: true, activeCredentialId: null },
    });
    expect(first.accounts).toHaveLength(1);
    expect(first.accounts[0]).toMatchObject({
      id: connected.accountId,
      scope: "workspace",
      subject: providerSubject,
      email: "owner@example.com",
      label: "Owner",
      status: "active",
      active: false,
      allocatorEnabled: true,
    });
    // The legacy account shape: the same keys, no secrets.
    expect(shapeOf(first)).toEqual(legacyShape!);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("refresh-");
    expect(serialized).not.toContain("credentialEncrypted");
    // Step W's shape: an organization account the connecting workspace manages.
    const [stored] = await shared!.admin<
      {
        provider: string;
        credential_format: string;
        ownership: string;
        managed_by_workspace_id: string | null;
      }[]
    >`
      select provider, credential_format, ownership, managed_by_workspace_id::text
      from subscription_connections where id = ${connected.accountId}::uuid`;
    expect(stored).toEqual({
      provider: "xai",
      credential_format: "xai_oauth_v1",
      ownership: "shared",
      managed_by_workspace_id: workspaceId,
    });

    const renamed = await request(`/supergrok/accounts/${connected.accountId}`, {
      method: "PATCH",
      body: { label: "Primary Grok" },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ label: "Primary Grok", active: false });

    const version = Number(first.accounts[0]!.allocatorVersion);
    const disabled = await request(`/supergrok/accounts/${connected.accountId}/allocator`, {
      method: "PATCH",
      body: { enabled: false, expectedVersion: version },
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ allocatorEnabled: false, changed: true });
    const stale = await request(`/supergrok/accounts/${connected.accountId}/allocator`, {
      method: "PATCH",
      body: { enabled: true, expectedVersion: version },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ allocatorEnabled: false, changed: false });

    const activated = await request(`/supergrok/accounts/${connected.accountId}/activate`, {
      method: "POST",
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toEqual({ activated: true, accountId: connected.accountId });
    expect(await listed()).toMatchObject({
      activeAccountId: connected.accountId,
      settings: { activeCredentialId: connected.accountId },
    });

    const rotation = await request("/supergrok/settings", {
      method: "PATCH",
      body: { rotationEnabled: false },
    });
    expect(rotation.status).toBe(200);
    expect(await rotation.json()).toMatchObject({
      rotationEnabled: false,
      activeCredentialId: connected.accountId,
    });

    // An organization lock on rotation (0724) binds the SuperGrok core writers
    // as it binds Codex's. Locking clears the workspace's rotation map (its
    // primary column stays but is inert without a rotation entry), so the
    // listing shows the organization's values; rotation and activate are then
    // refused as a lock (the API renders the 409 `setting_locked`) and write
    // nothing.
    const lockRotation = async (locked: string[]) => {
      const updated = await shared!.admin`
        update subscription_settings set locked_settings = ${locked}::text[]
        where account_id = ${accountId}::uuid and workspace_id is null`;
      if (updated.count === 0) {
        await shared!.admin`
          insert into subscription_settings (account_id, workspace_id, locked_settings)
          values (${accountId}::uuid, null, ${locked}::text[])`;
      }
    };
    const storedOverride = async () =>
      await shared!.admin<{ rotation: unknown; primary: string | null }[]>`
        select rotation, xai_primary_connection_id::text as primary from subscription_settings
        where account_id = ${accountId}::uuid and workspace_id = ${workspaceId}::uuid`;
    await lockRotation(["rotation"]);
    try {
      const lockedOverride = await storedOverride();
      expect(lockedOverride).toEqual([{ rotation: null, primary: connected.accountId }]);
      expect(await listed()).toMatchObject({
        activeAccountId: null,
        settings: { rotationEnabled: true, activeCredentialId: null },
      });
      for (const [path, method, body] of [
        ["/supergrok/settings", "PATCH", { rotationEnabled: false }],
        [`/supergrok/accounts/${connected.accountId}/activate`, "POST", undefined],
      ] as const) {
        const locked = await request(path, { method, body });
        expect({ path, status: locked.status, body: await locked.json() }).toMatchObject({
          path,
          status: 409,
          body: { code: "conflict", reason: "setting_locked", settings: ["rotation"] },
        });
      }
      expect(await storedOverride()).toEqual(lockedOverride);
    } finally {
      await lockRotation([]);
    }
    // Unlocked, the workspace may override again.
    const reactivated = await request(`/supergrok/accounts/${connected.accountId}/activate`, {
      method: "POST",
    });
    expect(reactivated.status).toBe(200);
    expect(await listed()).toMatchObject({
      activeAccountId: connected.accountId,
      settings: { activeCredentialId: connected.accountId },
    });

    // The access policy is the core connection's (the legacy row is never read).
    const accessPath = `/model-connections/supergrok/${connected.accountId}/access`;
    const access = await request(accessPath);
    expect(access.status).toBe(200);
    const accessBody = await access.json();
    expect(accessBody).toMatchObject({
      policy: { allowedModels: null, allowedWorkspaces: null, allowPersonalWorkspaces: false },
      personalWorkspacesSupported: false,
    });
    const restricted = await request(accessPath, {
      method: "PUT",
      body: { ...accessBody.policy, allowedModels: ["supergrok/grok-4"] },
    });
    expect(restricted.status).toBe(200);
    expect(await restricted.json()).toMatchObject({
      allowedModels: ["supergrok/grok-4"],
      version: accessBody.policy.version + 1,
    });
    const staleAccess = await request(accessPath, {
      method: "PUT",
      body: { ...accessBody.policy, allowedModels: null },
    });
    expect(staleAccess.status).toBe(409);
    const [restrictedRow] = await shared!.admin<{ allowed_model_ids: string[] | null }[]>`
      select allowed_model_ids from subscription_connections
      where id = ${connected.accountId}::uuid`;
    expect(restrictedRow!.allowed_model_ids).toEqual(["supergrok/grok-4"]);

    const reconnected = await connectWorkspaceAccount();
    expect(reconnected.accountId).toBe(connected.accountId);
    expect((await listed()).accounts).toHaveLength(1);

    // A private connection is never made from a shared workspace.
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
    expect(await disconnected.json()).toEqual({ disconnected: true, newActiveId: null });
    expect(await listed()).toMatchObject({ accounts: [], activeAccountId: null });
  });

  test(
    "core connect-poll database loss is a retryable 503 with unknown mutation outcome",
    expectRetryableConnectPollDatabaseFailure,
  );

  test("organization routes: maintenance fails closed, then they answer from core connections", async () => {
    // The receipt exists (above); this organization has no switch row.
    const someId = crypto.randomUUID();
    for (const [path, method, body] of [
      ["/accounts", "GET", undefined],
      ["/settings", "PATCH", { rotationEnabled: false }],
      ["/connect/start", "POST", {}],
      ["/connect/poll", "POST", { state: "x" }],
      [`/accounts/${someId}/activate`, "POST", {}],
      [`/accounts/${someId}`, "PATCH", { label: "x" }],
      [`/accounts/${someId}/allocator`, "PATCH", { enabled: false, expectedVersion: 1 }],
      [`/accounts/${someId}`, "DELETE", undefined],
    ] as const) {
      const response = await organizationRequest(path, method, body);
      expect({ path, method, status: response.status, body: await response.json() }).toMatchObject({
        path,
        method,
        status: 503,
        body: { reason: "subscription_core_cutover_disabled" },
      });
    }

    await shared!.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${organizationId}::uuid, 'xai', true)`;
    const first = await connectOrganizationAccount("xai-core-org-first");
    const second = await connectOrganizationAccount("xai-core-org-second");
    expect(first).not.toBe(second);
    const stored = await shared!.admin<
      { credential_format: string; ownership: string; managed_by_workspace_id: string | null }[]
    >`
      select credential_format, ownership, managed_by_workspace_id::text
      from subscription_connections
      where account_id = ${organizationId}::uuid and provider = 'xai' order by id`;
    expect(stored).toEqual([
      { credential_format: "xai_oauth_v1", ownership: "shared", managed_by_workspace_id: null },
      { credential_format: "xai_oauth_v1", ownership: "shared", managed_by_workspace_id: null },
    ]);
    const listing = await (await organizationRequest("/accounts")).json();
    expect(listing).toMatchObject({
      source: "organization",
      organizationId,
      activeAccountId: null,
      settings: { rotationEnabled: true, activeCredentialId: null },
    });
    expect(listing.accounts.map((account: { id: string }) => account.id).sort()).toEqual(
      [first, second].sort(),
    );
    expect(JSON.stringify(listing)).not.toContain("refresh-");

    // Allocator: a stale version is a conflict.
    const version = Number(
      listing.accounts.find((account: { id: string }) => account.id === second).allocatorVersion,
    );
    const disabled = await organizationRequest(`/accounts/${second}/allocator`, "PATCH", {
      enabled: false,
      expectedVersion: version,
    });
    expect(disabled.status).toBe(200);
    const stale = await organizationRequest(`/accounts/${second}/allocator`, "PATCH", {
      enabled: true,
      expectedVersion: version,
    });
    expect(stale.status).toBe(409);

    // Activate: as legacy, only an active account the allocator may use.
    const refused = await organizationRequest(`/accounts/${second}/activate`, "POST", {});
    expect({ status: refused.status, body: await refused.json() }).toMatchObject({
      status: 409,
      body: { message: "Choose an active, enabled SuperGrok subscription" },
    });
    const unknown = await organizationRequest(`/accounts/${someId}/activate`, "POST", {});
    expect(unknown.status).toBe(404);
    const activated = await organizationRequest(`/accounts/${first}/activate`, "POST", {});
    expect({ status: activated.status, body: await activated.json() }).toEqual({
      status: 200,
      body: { updated: true },
    });

    const rotation = await organizationRequest("/settings", "PATCH", { rotationEnabled: false });
    expect({ status: rotation.status, body: await rotation.json() }).toMatchObject({
      status: 200,
      body: { rotationEnabled: false, activeCredentialId: first },
    });
    const renamed = await organizationRequest(`/accounts/${first}`, "PATCH", {
      label: "Organization Grok",
    });
    expect(renamed.status).toBe(200);
    expect(await (await organizationRequest("/accounts")).json()).toMatchObject({
      activeAccountId: first,
      settings: { rotationEnabled: false, activeCredentialId: first },
    });

    const disconnected = await organizationRequest(`/accounts/${second}`, "DELETE");
    expect({ status: disconnected.status, body: await disconnected.json() }).toEqual({
      status: 200,
      body: { disconnected: true },
    });
    const remaining = await (await organizationRequest("/accounts")).json();
    expect(remaining.accounts.map((account: { id: string }) => account.id)).toEqual([first]);
    expect(remaining.accounts[0]).toMatchObject({ label: "Organization Grok", active: true });
  });

  test("private accounts: only from the owner's Personal workspace, managed there", async () => {
    // This organization's switch row is enabled (above). A private connect
    // from a shared workspace the person belongs to is refused at start,
    // before any xAI sign-in.
    const before = deviceSequence;
    const elsewhere = await browserWorkspaceRequest(
      managedSharedWorkspaceId,
      "/connect/start",
      "POST",
      { scope: "user" },
    );
    expect({ status: elsewhere.status, body: await elsewhere.json() }).toMatchObject({
      status: 409,
      body: {
        message:
          "Private SuperGrok accounts are connected and managed from your Personal workspace",
      },
    });
    expect(deviceSequence).toBe(before);

    // In the Personal workspace the person connects a personal connection.
    providerSubject = "xai-core-personal";
    const start = await browserWorkspaceRequest(personalWorkspaceId, "/connect/start", "POST", {
      scope: "user",
    });
    const started = await start.json();
    expect({ status: start.status, body: started }).toMatchObject({
      status: 200,
      body: { scope: "user" },
    });
    const poll = await browserWorkspaceRequest(personalWorkspaceId, "/connect/poll", "POST", {
      state: started.state,
    });
    const connected = await poll.json();
    expect({ status: poll.status, body: connected }).toMatchObject({
      status: 200,
      body: { status: "connected", scope: "user", email: "owner@example.com" },
    });
    const personalId: string = connected.accountId;
    const [stored] = await shared!.admin<
      { ownership: string; credential_format: string; owner_subject_id: string | null }[]
    >`
      select ownership, credential_format, owner_subject_id
      from subscription_connections where id = ${personalId}::uuid`;
    expect(stored).toMatchObject({ ownership: "personal", credential_format: "xai_oauth_v1" });

    // Listed to its owner in the Personal workspace, as a private account.
    const listing = await (await browserWorkspaceRequest(personalWorkspaceId, "/accounts")).json();
    expect(listing.source).toBe("user");
    // The organization pool serves the Personal workspace too; the personal
    // connection is listed beside it as the owner's private account.
    const own = listing.accounts.find((account: { id: string }) => account.id === personalId);
    expect(own).toMatchObject({ scope: "user", status: "active", label: "Owner" });
    // The shared workspace never lists or reaches it.
    const sharedListing = await (
      await browserWorkspaceRequest(managedSharedWorkspaceId, "/accounts")
    ).json();
    expect(JSON.stringify(sharedListing)).not.toContain(personalId);
    const sharedRename = await browserWorkspaceRequest(
      managedSharedWorkspaceId,
      `/accounts/${personalId}`,
      "PATCH",
      { label: "nope" },
    );
    expect(sharedRename.status).toBe(404);

    const renamed = await browserWorkspaceRequest(
      personalWorkspaceId,
      `/accounts/${personalId}`,
      "PATCH",
      { label: "My Grok" },
    );
    expect({ status: renamed.status, body: await renamed.json() }).toMatchObject({
      status: 200,
      body: { id: personalId, label: "My Grok", scope: "user" },
    });
    const version = Number(own.allocatorVersion);
    const disabled = await browserWorkspaceRequest(
      personalWorkspaceId,
      `/accounts/${personalId}/allocator`,
      "PATCH",
      { enabled: false, expectedVersion: version },
    );
    expect({ status: disabled.status, body: await disabled.json() }).toMatchObject({
      status: 200,
      body: { allocatorEnabled: false, changed: true },
    });
    const enabled = await browserWorkspaceRequest(
      personalWorkspaceId,
      `/accounts/${personalId}/allocator`,
      "PATCH",
      { enabled: true, expectedVersion: version + 1 },
    );
    expect(enabled.status).toBe(200);
    const activated = await browserWorkspaceRequest(
      personalWorkspaceId,
      `/accounts/${personalId}/activate`,
      "POST",
      {},
    );
    expect({ status: activated.status, body: await activated.json() }).toEqual({
      status: 200,
      body: { activated: true, accountId: personalId },
    });
    // Rotation in the Personal workspace is the owner's (by workspace, not by
    // the listing's display source).
    const rotation = await browserWorkspaceRequest(personalWorkspaceId, "/settings", "PATCH", {
      rotationEnabled: false,
    });
    expect({ status: rotation.status, body: await rotation.json() }).toMatchObject({
      status: 200,
      body: { rotationEnabled: false },
    });
    // The owner's Personal workspace now holds its own override, which the
    // next listing shows (it orders only the owner's own work there).
    const overridden = await (
      await browserWorkspaceRequest(personalWorkspaceId, "/accounts")
    ).json();
    expect(overridden.settings).toMatchObject({ rotationEnabled: false });

    // Owner routes may write Personal overrides; organization locks still
    // refuse both activate and rotation without changing the stored values.
    await shared!.admin`UPDATE subscription_settings SET locked_settings = ARRAY['rotation']
      WHERE account_id = ${organizationId}::uuid AND workspace_id IS NULL`;
    try {
      const overrideBefore = await shared!.admin`SELECT to_jsonb(setting) AS value
        FROM subscription_settings setting WHERE account_id = ${organizationId}::uuid
          AND workspace_id = ${personalWorkspaceId}::uuid`;
      for (const [path, method, body] of [
        ["/settings", "PATCH", { rotationEnabled: true }],
        [`/accounts/${personalId}/activate`, "POST", {}],
      ] as const) {
        const refused = await browserWorkspaceRequest(personalWorkspaceId, path, method, body);
        expect({ status: refused.status, body: await refused.json() }).toMatchObject({
          status: 409,
          body: { code: "conflict", reason: "setting_locked", settings: ["rotation"] },
        });
      }
      expect(
        await shared!.admin`SELECT to_jsonb(setting) AS value
        FROM subscription_settings setting WHERE account_id = ${organizationId}::uuid
          AND workspace_id = ${personalWorkspaceId}::uuid`,
      ).toEqual(overrideBefore);
    } finally {
      await shared!.admin`UPDATE subscription_settings SET locked_settings = '{}'
        WHERE account_id = ${organizationId}::uuid AND workspace_id IS NULL`;
    }

    // Reconnecting the same login updates the same personal connection.
    const restart = await browserWorkspaceRequest(personalWorkspaceId, "/connect/start", "POST", {
      scope: "user",
    });
    const repoll = await browserWorkspaceRequest(personalWorkspaceId, "/connect/poll", "POST", {
      state: (await restart.json()).state,
    });
    expect(await repoll.json()).toMatchObject({ status: "connected", accountId: personalId });

    const disconnected = await browserWorkspaceRequest(
      personalWorkspaceId,
      `/accounts/${personalId}`,
      "DELETE",
    );
    expect(disconnected.status).toBe(200);
    const after = await (await browserWorkspaceRequest(personalWorkspaceId, "/accounts")).json();
    expect(JSON.stringify(after.accounts)).not.toContain(personalId);
  });

  test("legacy account ids the cutover kept as aliases resolve for the authorized caller only", async () => {
    // A legacy SuperGrok id the drained cutover merged into a canonical
    // connection is kept as an alias; every account route accepts it.
    const alias = async (organization: string, connection: string) => {
      const legacyId = crypto.randomUUID();
      await shared!.admin`
        insert into subscription_connection_aliases (
          account_id, provider, alias_connection_id, connection_id
        ) values (${organization}::uuid, 'xai', ${legacyId}::uuid, ${connection}::uuid)`;
      return legacyId;
    };

    // Organization routes: the organization's own account by its legacy id.
    const organizationListing = await (await organizationRequest("/accounts")).json();
    const organizationAccount: string = organizationListing.accounts[0].id;
    const organizationAlias = await alias(organizationId, organizationAccount);
    const orgRenamed = await organizationRequest(`/accounts/${organizationAlias}`, "PATCH", {
      label: "Renamed by legacy id",
    });
    expect({ status: orgRenamed.status, body: await orgRenamed.json() }).toMatchObject({
      status: 200,
      body: { updated: true },
    });
    const orgActivated = await organizationRequest(
      `/accounts/${organizationAlias}/activate`,
      "POST",
      {},
    );
    expect({ status: orgActivated.status, body: await orgActivated.json() }).toEqual({
      status: 200,
      body: { updated: true },
    });
    const orgAllocator = await organizationRequest(
      `/accounts/${organizationAlias}/allocator`,
      "PATCH",
      {
        enabled: true,
        expectedVersion: Number(organizationListing.accounts[0].allocatorVersion),
      },
    );
    expect(orgAllocator.status).toBe(200);
    expect(
      (await (await organizationRequest("/accounts")).json()).accounts.find(
        (account: { id: string }) => account.id === organizationAccount,
      ),
    ).toMatchObject({ label: "Renamed by legacy id", active: true });

    // Workspace routes: an account this workspace manages, by its legacy id,
    // for the organization administrator and for a workspace administrator
    // who is not one.
    providerSubject = "xai-core-alias";
    const managed = await connectWorkspaceAccount();
    const workspaceAlias = await alias(accountId, managed.accountId);
    const ownerRenamed = await request(`/supergrok/accounts/${workspaceAlias}`, {
      method: "PATCH",
      body: { label: "Owner by legacy id" },
    });
    expect({ status: ownerRenamed.status, body: await ownerRenamed.json() }).toMatchObject({
      status: 200,
      body: { id: managed.accountId, label: "Owner by legacy id" },
    });
    const workspaceAdmin = `user:supergrok-core-workspace-admin-${crypto.randomUUID()}`;
    const [adminPersonal] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${accountId}::uuid, 'Workspace admin personal') returning id::text as id`;
    await shared!.admin`
      insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
      values (${accountId}::uuid, ${workspaceAdmin}, 'member', 'active', ${adminPersonal!.id}::uuid)`;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${workspaceAdmin}, 'admin',
        '["workspace:read", "workspace:admin", "connections:write"]'::jsonb)`;
    const adminRenamed = await request(`/supergrok/accounts/${workspaceAlias}`, {
      method: "PATCH",
      body: { label: "Workspace admin by legacy id" },
      subject: workspaceAdmin,
    });
    expect({ status: adminRenamed.status, body: await adminRenamed.json() }).toMatchObject({
      status: 200,
      body: { id: managed.accountId, label: "Workspace admin by legacy id" },
    });
    const adminActivated = await request(`/supergrok/accounts/${workspaceAlias}/activate`, {
      method: "POST",
      subject: workspaceAdmin,
    });
    expect({ status: adminActivated.status, body: await adminActivated.json() }).toEqual({
      status: 200,
      body: { activated: true, accountId: managed.accountId },
    });
    const aliasAccess = await request(`/model-connections/supergrok/${workspaceAlias}/access`);
    expect(aliasAccess.status).toBe(200);

    // Refused otherwise: another organization's legacy id resolves on neither
    // route family, and an organization route never reaches another
    // organization's account.
    const foreignWorkspace = await request(`/supergrok/accounts/${organizationAlias}`, {
      method: "PATCH",
      body: { label: "nope" },
    });
    expect(foreignWorkspace.status).toBe(404);
    const foreignOrganization = await organizationRequest(`/accounts/${workspaceAlias}`, "PATCH", {
      label: "nope",
    });
    expect(foreignOrganization.status).toBe(404);
    const foreignDisconnect = await organizationRequest(`/accounts/${workspaceAlias}`, "DELETE");
    expect(foreignDisconnect.status).toBe(404);
    // Another organization's shared workspace never reaches this
    // organization's account by its legacy id.
    const otherShared = await browserWorkspaceRequest(
      managedSharedWorkspaceId,
      `/accounts/${workspaceAlias}`,
      "PATCH",
      { label: "nope" },
    );
    expect(otherShared.status).toBe(404);
    // Nor does a workspace of the same organization that the account does
    // not reach, for the organization administrator or a workspace
    // administrator there.
    const [unreached] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${accountId}::uuid, 'SuperGrok core unreached') returning id::text as id`;
    await shared!.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${unreached!.id}::uuid, ${accountId}::uuid)`;
    for (const subject of [subjectId, workspaceAdmin]) {
      await shared!.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
        values (${accountId}::uuid, ${unreached!.id}::uuid, ${subject}, 'admin',
          '["workspace:read", "workspace:admin", "connections:write"]'::jsonb)`;
      const unreachedRename = await bearerRequest(
        { accountId, workspaceId: unreached!.id, subjectId: subject },
        `/accounts/${workspaceAlias}`,
        { method: "PATCH", body: { label: "nope" } },
      );
      expect({ subject, status: unreachedRename.status }).toEqual({ subject, status: 404 });
    }

    // The legacy id of a private account resolves only for its owner, in
    // their Personal workspace.
    providerSubject = "xai-core-personal-alias";
    const start = await browserWorkspaceRequest(personalWorkspaceId, "/connect/start", "POST", {
      scope: "user",
    });
    const poll = await browserWorkspaceRequest(personalWorkspaceId, "/connect/poll", "POST", {
      state: (await start.json()).state,
    });
    const personalId: string = (await poll.json()).accountId;
    const personalAlias = await alias(organizationId, personalId);
    const personalRenamed = await browserWorkspaceRequest(
      personalWorkspaceId,
      `/accounts/${personalAlias}`,
      "PATCH",
      { label: "Mine by legacy id" },
    );
    expect({ status: personalRenamed.status, body: await personalRenamed.json() }).toMatchObject({
      status: 200,
      body: { id: personalId, label: "Mine by legacy id", scope: "user" },
    });
    const personalElsewhere = await browserWorkspaceRequest(
      managedSharedWorkspaceId,
      `/accounts/${personalAlias}`,
      "PATCH",
      { label: "nope" },
    );
    expect(personalElsewhere.status).toBe(404);
    const personalFromOrganization = await organizationRequest(
      `/accounts/${personalAlias}`,
      "PATCH",
      { label: "nope" },
    );
    expect(personalFromOrganization.status).toBe(404);

    // Another member never reaches the owner's private account: not by its
    // legacy or canonical id from their own Personal workspace, and not in
    // the owner's Personal workspace (no xAI sign-in started, nothing
    // changed).
    const member = await otherMember(organizationId);
    for (const id of [personalAlias, personalId]) {
      const crossOwner = await bearerRequest(
        {
          accountId: organizationId,
          workspaceId: member.personalWorkspaceId,
          subjectId: member.subjectId,
        },
        `/accounts/${id}`,
        { method: "PATCH", body: { label: "nope" } },
      );
      expect({ id, status: crossOwner.status }).toEqual({ id, status: 404 });
    }
    const devicesBefore = deviceSequence;
    const ownersWorkspace = {
      accountId: organizationId,
      workspaceId: personalWorkspaceId,
      subjectId: member.subjectId,
    };
    // Even a delegated grant naming the owner's Personal workspace for the
    // member shows only the organization pool there.
    const memberListing = await bearerRequest(ownersWorkspace, "/accounts");
    const memberListed = await memberListing.json();
    expect({ status: memberListing.status, source: memberListed.source }).toEqual({
      status: 200,
      source: "organization",
    });
    expect(JSON.stringify(memberListed)).not.toContain(personalId);
    for (const [path, method, body, status] of [
      [`/accounts/${personalId}`, "PATCH", { label: "nope" }, 404],
      [`/accounts/${personalId}/activate`, "POST", {}, 404],
      ["/settings", "PATCH", { rotationEnabled: true }, 409],
      ["/connect/start", "POST", { scope: "user" }, 403],
    ] as const) {
      const response = await bearerRequest(ownersWorkspace, path, {
        method,
        ...(body ? { body } : {}),
      });
      expect({ path, status: response.status }).toEqual({ path, status });
    }
    expect(deviceSequence).toBe(devicesBefore);

    // The owner whose organization membership is suspended is refused too.
    await shared!.admin`
      update organization_memberships set status = 'suspended'
      where account_id = ${organizationId}::uuid and personal_workspace_id = ${personalWorkspaceId}::uuid`;
    try {
      for (const [path, method, body] of [
        ["/accounts", "GET", undefined],
        [`/accounts/${personalId}`, "PATCH", { label: "nope" }],
        ["/connect/start", "POST", { scope: "user" }],
      ] as const) {
        const response = await browserWorkspaceRequest(personalWorkspaceId, path, method, body);
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
      }
      expect(deviceSequence).toBe(devicesBefore);
    } finally {
      await shared!.admin`
        update organization_memberships set status = 'active'
        where account_id = ${organizationId}::uuid and personal_workspace_id = ${personalWorkspaceId}::uuid`;
    }
    const [unchanged] = await shared!.admin<{ label: string | null }[]>`
      select label from subscription_connections where id = ${personalId}::uuid`;
    expect(unchanged!.label).toBe("Mine by legacy id");
    const personalDisconnected = await browserWorkspaceRequest(
      personalWorkspaceId,
      `/accounts/${personalAlias}`,
      "DELETE",
    );
    expect(personalDisconnected.status).toBe(200);
  });
});
