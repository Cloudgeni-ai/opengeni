/**
 * M4 X2b: the SuperGrok routes on the shared subscription core, on real
 * PostgreSQL as the application role. Without the SuperGrok (`xai`) cutover
 * receipt the legacy routes answer; with the receipt and no switch row every
 * route fails closed with the typed 503; with an enabled switch row the same
 * paths, verbs and response shapes are served from core connections
 * (connect, list, rename, allocator, activate, rotation, reconnect,
 * disconnect, the access policy).
 *
 * X3 ships SuperGrok's registry entry; this process registers it (the module
 * binding below) and the test database gets its registry row. Run this file in
 * its own process: the registration replaces module bindings process-wide.
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { Hono as HonoApp } from "hono";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const registryPath = Bun.resolveSync(
  "../../../packages/db/src/subscription-core-providers.ts",
  import.meta.dir,
);
const realRegistry = await import(registryPath);
const { SUBSCRIPTION_CORE_XAI } = await import(
  Bun.resolveSync("../../../packages/db/src/subscription-core-xai-adapter.ts", import.meta.dir)
);
const productionIds: string[] = realRegistry.subscriptionCoreProviderIds();
const realProvider = realRegistry.subscriptionCoreProvider;
const lookup = (providerId: string) =>
  providerId === "xai" ? SUBSCRIPTION_CORE_XAI : realProvider(providerId);
mock.module(registryPath, () => ({
  ...realRegistry,
  subscriptionCoreProviderIds: () => [...productionIds, "xai"].sort(),
  subscriptionCoreProvider: lookup,
  subscriptionCoreAdapter: (providerId: string) => lookup(providerId).adapter,
}));
const opengeniDb = await import("@opengeni/db");
const { resolveCatalogSettings } = await import("@opengeni/core");
const { Hono } = await import("hono");
const { registerSuperGrokRoutes } = await import("../src/routes/supergrok");
const { registerModelConnectionAccessRoutes } =
  await import("../src/routes/model-connection-access");

const DELEGATION_SECRET = "supergrok-core-routes-delegation-secret";
const STATE_SECRET = "supergrok-core-routes-state-secret";
const encryptionKey = Buffer.alloc(32, 67);
const settings = testSettings({
  productAccessMode: "configured",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  supergrokSubscriptionEnabled: true,
});

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof opengeniDb.createDb> | null = null;
let app: HonoApp | null = null;
let accountId = "";
let workspaceId = "";
let subjectId = "";
let deviceSequence = 0;
const providerSubject = "xai-core-user-1";

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
  shared = await acquireSharedTestDatabase("api-supergrok-core-routes");
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
  const deps = {
    db: client.db,
    settings,
    resolveCatalogSettings: async () => await resolveCatalogSettings(client!.db, settings),
    githubStateSecret: STATE_SECRET,
    xaiFetch,
    managedAuth: null,
  } as never;
  registerSuperGrokRoutes(app, deps);
  registerModelConnectionAccessRoutes(app, deps);
  // The typed errors as the API renders them (code and details).
  app.onError((error, c) => {
    const typed = error as { status?: number; code?: string; details?: Record<string, unknown> };
    return c.json(
      { code: typed.code ?? null, message: error.message, ...(typed.details ?? {}) },
      (typed.status ?? 500) as 500,
    );
  });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function request(
  path: string,
  options: { method?: string; body?: unknown; permissions?: Permission[] } = {},
): Promise<Response> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId,
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
});
