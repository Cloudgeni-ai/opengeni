/**
 * M4 C2b: the Claude routes on the shared subscription core, on real
 * PostgreSQL as the application role. Without the Claude (`claude`) cutover
 * receipt the legacy routes answer; with the receipt and no switch row every
 * route (including OAuth start) fails closed with the typed 503; with an
 * enabled switch row the same paths, verbs and response shapes are served
 * from core connections (setup-token connect and replace, OAuth sign-in,
 * list, rename, allocator, activate, rotation, the access policy, alias
 * translation, disconnect), and a private account is connected only in the
 * person's own Personal workspace.
 *
 * C3 ships Claude's registry entry; this process registers it (the module
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
import { CLAUDE_OAUTH_TOKEN_URL } from "@opengeni/config";
import type { Hono as HonoApp } from "hono";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const registryPath = Bun.resolveSync(
  "../../../packages/db/src/subscription-core-providers.ts",
  import.meta.dir,
);
const realRegistry = await import(registryPath);
const { SUBSCRIPTION_CORE_CLAUDE } = await import(
  Bun.resolveSync("../../../packages/db/src/subscription-core-claude-adapter.ts", import.meta.dir)
);
const productionIds: string[] = realRegistry.subscriptionCoreProviderIds();
const realProvider = realRegistry.subscriptionCoreProvider;
const lookup = (providerId: string) =>
  providerId === "claude" ? SUBSCRIPTION_CORE_CLAUDE : realProvider(providerId);
mock.module(registryPath, () => ({
  ...realRegistry,
  subscriptionCoreProviderIds: () => [...productionIds, "claude"].sort(),
  subscriptionCoreProvider: lookup,
  subscriptionCoreAdapter: (providerId: string) => lookup(providerId).adapter,
}));
const opengeniDb = await import("@opengeni/db");
const { Hono } = await import("hono");
const { registerClaudeSubscriptionAccountRoutes } =
  await import("../src/routes/claude-subscription-accounts");
const { registerClaudeSubscriptionOAuthRoutes } =
  await import("../src/routes/claude-subscription-oauth");
const { registerModelConnectionAccessRoutes } =
  await import("../src/routes/model-connection-access");
const { startClaudeSubscriptionOAuth, completeClaudeSubscriptionOAuth } =
  await import("../src/claude-subscription-oauth");
const { requireClaudeCorePersonalWorkspace } = await import("../src/claude-subscription-core");

const DELEGATION_SECRET = "claude-core-routes-delegation-secret";
const DEPLOYMENT_KEY = `claude-core-deployment-key-${crypto.randomUUID()}`;
const ORIGIN = "https://opengeni.test";
const encryptionKey = Buffer.alloc(32, 71);
const settings = testSettings({
  productAccessMode: "configured",
  delegationSecret: DELEGATION_SECRET,
  publicBaseUrl: ORIGIN,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  claudeSubscriptionEnabled: true,
});

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof opengeniDb.createDb> | null = null;
let app: HonoApp | null = null;
/** A key-only deployment's OAuth routes (its operator connects with the key). */
let keyApp: HonoApp | null = null;
let deps: never;
let accountId = "";
let workspaceId = "";
let personalWorkspaceId = "";
let subjectId = "";
/** The deployment-key workspace (its own organization) for the OAuth routes. */
let keyWorkspaceId = "";

function claudeFetch(accountUuid: string, email: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === CLAUDE_OAUTH_TOKEN_URL)
      return Response.json({
        access_token: `sk-ant-oat01-core-${crypto.randomUUID()}`,
        refresh_token: `core-refresh-${crypto.randomUUID()}`,
        expires_in: 3600,
        scope: "user:inference user:profile",
        account: { uuid: accountUuid, email_address: email },
      });
    if (url === "https://api.anthropic.com/api/oauth/profile")
      return Response.json({
        account: { uuid: accountUuid, email_address: email, has_claude_max: true },
        organization: { organization_type: "claude_max" },
      });
    throw new Error(`unexpected Claude request: ${url}`);
  }) as typeof fetch;
}

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-claude-core-routes");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = opengeniDb.createDb(shared.appUrl);
  // An organization administrator in a shared workspace: on the core only
  // an organization administrator connects a new shared account.
  const userId = `claude-core-${crypto.randomUUID()}`;
  subjectId = `user:${userId}`;
  const access = await opengeniDb.ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Claude core route owner",
  });
  accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await shared.admin<{ personal_workspace_id: string }[]>`
    select personal_workspace_id::text as personal_workspace_id from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${subjectId}`;
  personalWorkspaceId = membership!.personal_workspace_id;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Claude core shared') returning id::text as id`;
  workspaceId = workspace!.id;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'owner',
      '["workspace:read", "workspace:admin", "connections:write"]'::jsonb)`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}::uuid, ${accountId}::uuid)`;
  await shared.admin`
    update subscription_settings set personal_connections_allowed = true,
      personal_fallback_allowed = true
    where account_id = ${accountId}::uuid and workspace_id is null`;
  const configured = await opengeniDb.bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:configured",
    accountExternalId: "default",
    accountName: "Configured",
    workspaceExternalSource: "opengeni:configured",
    workspaceExternalId: "default",
    workspaceName: "Configured",
    subjectId: "configured:key",
    subjectLabel: "Configured key",
  });
  keyWorkspaceId = configured.workspaceGrants[0]!.workspaceId;
  app = new Hono();
  deps = { db: client.db, settings, managedAuth: null } as never;
  registerClaudeSubscriptionAccountRoutes(app, deps);
  registerModelConnectionAccessRoutes(app, deps);
  keyApp = new Hono();
  registerClaudeSubscriptionOAuthRoutes(
    keyApp,
    {
      db: client.db,
      settings: testSettings({
        ...settings,
        authRequired: true,
        accessKey: DEPLOYMENT_KEY,
        delegationSecret: undefined,
        publicBaseUrl: undefined,
      }),
    } as never,
    claudeFetch(crypto.randomUUID(), "key@example.test"),
  );
  // The typed errors as the API renders them (code and details).
  for (const routes of [app, keyApp])
    routes.onError((error, c) => {
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
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/** The deployment-key OAuth start in its own organization. */
async function keyOAuthStart(): Promise<Response> {
  return await keyApp!.request(
    `http://x/v1/workspaces/${keyWorkspaceId}/model-providers/claude_subscription/oauth/start`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-opengeni-access-key": DEPLOYMENT_KEY },
      body: "{}",
    },
  );
}

const setupToken = () => `sk-ant-oat01-setup-${crypto.randomUUID()}`;

async function connectSetupToken(body: Record<string, unknown> = {}) {
  return await request("/claude/accounts/setup-token", {
    method: "POST",
    body: { token: setupToken(), scope: "workspace", label: "Team Claude", ...body },
  });
}

/** The account list with its volatile fields (timestamps) removed. */
async function listed() {
  const response = await request("/claude/accounts");
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

const oauthScope = (workspace: string) => ({
  accountId,
  workspaceId: workspace,
  actorSubjectId: subjectId,
  browserSessionHash: "claude-core-browser",
});

describe.skipIf(!realDb)("Claude routes on the shared core (M4 C2b)", () => {
  test("without the receipt the legacy routes answer", async () => {
    expect(productionIds).not.toContain("claude");
    // The routes run as the restricted application role.
    const [role] = await shared!.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_catalog.pg_roles
      where rolname = ${new URL(shared!.appUrl).username}`;
    expect(new URL(shared!.appUrl).username).toBe("opengeni_app");
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    legacyEmpty = await listed();
    expect(legacyEmpty).toMatchObject({ accounts: [], activeAccountId: null });
    const connected = await connectSetupToken();
    expect(connected.status).toBe(200);
    const body = await connected.json();
    expect(body).toMatchObject({ connected: true, credentialVersion: 1, scope: "workspace" });
    const listing = await listed();
    expect(listing.accounts).toHaveLength(1);
    legacyShape = shapeOf(listing);
    const disconnected = await request(`/claude/accounts/${body.accountId}`, {
      method: "DELETE",
    });
    expect(disconnected.status).toBe(200);
    expect((await listed()).accounts).toEqual([]);
    // Legacy authorizes the setup token exactly as before the core: an
    // explicit grant (a custom organization key policy, which implies
    // nothing) with workspace:admin and no workspace:read connects a shared
    // account; the read grant is taken only once a receipt exists.
    const adminOnlyToken = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    const adminOnlyKey = await opengeniDb.createOrganizationApiKey(client!.db, {
      accountId,
      name: "Workspace admin only",
      prefix: adminOnlyToken.slice(0, 14),
      keyHash: new Bun.CryptoHasher("sha256").update(adminOnlyToken).digest("hex"),
      permissions: ["workspace:admin"],
      policy: {
        preset: "custom",
        permissions: ["workspace:admin"],
        workspaceScope: { kind: "all" },
      },
    });
    // The legacy writer requires the connecting subject's workspace grant.
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${`api_key:${adminOnlyKey.id}`}, 'admin',
        '["workspace:admin"]'::jsonb)`;
    const adminOnly = await app!.request(
      `http://x/v1/workspaces/${workspaceId}/claude/accounts/setup-token`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminOnlyToken}`,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: setupToken(), scope: "workspace", label: "Admin only" }),
      },
    );
    expect({ status: adminOnly.status, body: await adminOnly.clone().text() }).toMatchObject({
      status: 200,
    });
    const adminOnlyBody = await adminOnly.json();
    expect(adminOnlyBody).toMatchObject({ connected: true, scope: "workspace" });
    expect(
      (await request(`/claude/accounts/${adminOnlyBody.accountId}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await listed()).accounts).toEqual([]);
    // The legacy OAuth start answers for the deployment key.
    expect((await keyOAuthStart()).status).toBe(200);
    const [core] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_connections where provider = 'claude'`;
    expect(core!.count).toBe(0);
  });

  test("after the receipt, without an enabled switch row, every route fails closed", async () => {
    await shared!.admin`
      insert into opengeni_private.subscription_core_providers (provider, extra_credits,
        primary_setting_column)
      values ('claude', false, 'claude_primary_connection_id')`;
    await shared!.admin`
      insert into opengeni_private.subscription_provider_cutover_receipts (
        provider, migration, committed_at, seed_rotation
      ) values ('claude', '0899_subscription_core_claude_cutover.sql', clock_timestamp(),
        '{"mode":"spread"}')`;
    const id = crypto.randomUUID();
    for (const [path, method, body] of [
      ["/claude/accounts", "GET", undefined],
      ["/claude/accounts/setup-token", "POST", { token: setupToken(), scope: "workspace" }],
      ["/claude/settings", "PATCH", { rotationEnabled: false }],
      [`/claude/accounts/${id}`, "DELETE", undefined],
      [`/model-connections/claude_subscription/${id}/access`, "GET", undefined],
    ] as const) {
      const response = await request(path, { method, ...(body ? { body } : {}) });
      expect({ path, status: response.status, body: await response.json() }).toMatchObject({
        path,
        status: 503,
        body: { reason: "subscription_core_cutover_disabled" },
      });
    }
    const start = await keyOAuthStart();
    expect({ status: start.status, body: await start.json() }).toMatchObject({
      status: 503,
      body: { reason: "subscription_core_cutover_disabled" },
    });
  });

  test("with the switch row the same routes answer from core connections", async () => {
    await shared!.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${accountId}::uuid, 'claude', true)`;
    expect(await listed()).toEqual(legacyEmpty as never);

    const connected = await connectSetupToken();
    expect(connected.status).toBe(200);
    const body = await connected.json();
    expect(body).toMatchObject({ connected: true, scope: "workspace" });
    expect(Object.keys(body).sort()).toEqual([
      "accountId",
      "connected",
      "credentialVersion",
      "scope",
    ]);
    expect(Number.isInteger(body.credentialVersion) && body.credentialVersion > 0).toBe(true);
    const first = await listed();
    // The core leaves the primary unset on a first connect (as for SuperGrok).
    expect(first).toMatchObject({
      activeAccountId: null,
      settings: { rotationEnabled: true, activeCredentialId: null },
    });
    expect(first.accounts).toHaveLength(1);
    expect(first.accounts[0]).toMatchObject({
      id: body.accountId,
      scope: "workspace",
      label: "Team Claude",
      status: "active",
      active: false,
      version: body.credentialVersion,
      allocatorEnabled: true,
    });
    expect(String(first.accounts[0]!.subject)).toStartWith("setup:");
    // The legacy account shape: the same keys (the usage reading is C2a's
    // projection of the core quota row), no secrets.
    expect(shapeOf(first)).toEqual(legacyShape!);
    expect(first.accounts[0]!.usage).toMatchObject({
      connected: true,
      windows: [],
      refreshStatus: "scope_required",
      // One credential version: the web client treats a difference as a
      // credential change.
      credentialVersion: body.credentialVersion,
    });
    expect(JSON.stringify(first)).not.toContain("sk-ant-");
    const [stored] = await shared!.admin<
      { credential_format: string; ownership: string; managed_by_workspace_id: string | null }[]
    >`
      select credential_format, ownership, managed_by_workspace_id::text
      from subscription_connections where id = ${body.accountId}::uuid`;
    expect(stored).toEqual({
      credential_format: "claude_setup_token_v1",
      ownership: "shared",
      managed_by_workspace_id: workspaceId,
    });

    // Replacing the token is fenced on the listed version and keeps the account.
    const replaced = await connectSetupToken({
      reconnectAccountId: body.accountId,
      expectedCredentialVersion: body.credentialVersion,
    });
    expect(replaced.status).toBe(200);
    const replacedBody = await replaced.json();
    expect(replacedBody).toEqual({
      connected: true,
      accountId: body.accountId,
      credentialVersion: body.credentialVersion + 1,
      scope: "workspace",
    });
    const stale = await connectSetupToken({
      reconnectAccountId: body.accountId,
      expectedCredentialVersion: body.credentialVersion,
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).message).toBe(
      "Claude account changed. Reload it before replacing the token.",
    );
    expect((await listed()).accounts).toHaveLength(1);

    const renamed = await request(`/claude/accounts/${body.accountId}`, {
      method: "PATCH",
      body: { label: "Primary Claude" },
    });
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json();
    expect(renamedBody).toMatchObject({ label: "Primary Claude", active: false });
    // The legacy rename shape: the plain account, no usage reading.
    expect(renamedBody).not.toHaveProperty("usage");
    const afterRename = (await listed()).accounts[0]!;
    expect(afterRename.version).toBe(replacedBody.credentialVersion + 1);
    expect((afterRename.usage as { credentialVersion: number }).credentialVersion).toBe(
      afterRename.version as number,
    );

    const allocatorVersion = Number((await listed()).accounts[0]!.allocatorVersion);
    const disabled = await request(`/claude/accounts/${body.accountId}/allocator`, {
      method: "PATCH",
      body: { enabled: false, expectedVersion: allocatorVersion },
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ allocatorEnabled: false, changed: true });
    const staleAllocator = await request(`/claude/accounts/${body.accountId}/allocator`, {
      method: "PATCH",
      body: { enabled: true, expectedVersion: allocatorVersion },
    });
    expect(staleAllocator.status).toBe(409);

    const activated = await request(`/claude/accounts/${body.accountId}/activate`, {
      method: "POST",
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toEqual({ activated: true, accountId: body.accountId });
    expect(await listed()).toMatchObject({
      activeAccountId: body.accountId,
      settings: { activeCredentialId: body.accountId },
    });
    const rotation = await request("/claude/settings", {
      method: "PATCH",
      body: { rotationEnabled: false },
    });
    expect(rotation.status).toBe(200);
    expect(await rotation.json()).toMatchObject({
      rotationEnabled: false,
      activeCredentialId: body.accountId,
    });

    // The access policy is the core connection's (the legacy row is never read).
    const accessPath = `/model-connections/claude_subscription/${body.accountId}/access`;
    const access = await request(accessPath);
    expect(access.status).toBe(200);
    const accessBody = await access.json();
    expect(accessBody).toMatchObject({
      policy: { allowedModels: null, allowedWorkspaces: null },
    });
    const model = "workspace-claude-subscription/claude-sonnet-4-5";
    const restricted = await request(accessPath, {
      method: "PUT",
      body: { ...accessBody.policy, allowedModels: [model] },
    });
    expect(restricted.status).toBe(200);
    expect(await restricted.json()).toMatchObject({
      allowedModels: [model],
      version: accessBody.policy.version + 1,
    });
    const staleAccess = await request(accessPath, {
      method: "PUT",
      body: { ...accessBody.policy, allowedModels: null },
    });
    expect(staleAccess.status).toBe(409);

    // A legacy id the drained cutover kept as an alias names the connection.
    const alias = crypto.randomUUID();
    await shared!.admin`
      insert into subscription_connection_aliases (account_id, provider, alias_connection_id,
        connection_id)
      values (${accountId}::uuid, 'claude', ${alias}::uuid, ${body.accountId}::uuid)`;
    const aliased = await request(`/claude/accounts/${alias}`, {
      method: "PATCH",
      body: { label: "Aliased Claude" },
    });
    expect(aliased.status).toBe(200);
    expect(await aliased.json()).toMatchObject({ id: body.accountId, label: "Aliased Claude" });
    const aliasedAccess = await request(`/model-connections/claude_subscription/${alias}/access`);
    expect(aliasedAccess.status).toBe(200);
    expect(await aliasedAccess.json()).toMatchObject({ policy: { allowedModels: [model] } });
    // A rename is a connection change too: the listed version moved past the
    // replaced token's, and a replace names the version the caller listed.
    const listedVersion = Number((await listed()).accounts[0]!.version);
    expect(listedVersion).toBe(replacedBody.credentialVersion + 2);
    const aliasedReplace = await connectSetupToken({
      reconnectAccountId: alias,
      expectedCredentialVersion: listedVersion,
    });
    expect(aliasedReplace.status).toBe(200);
    expect(await aliasedReplace.json()).toMatchObject({
      accountId: body.accountId,
      credentialVersion: listedVersion + 1,
    });

    const disconnected = await request(`/claude/accounts/${body.accountId}`, {
      method: "DELETE",
    });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({ disconnected: true, newActiveId: null });
    expect((await listed()).accounts).toEqual([]);
  });

  test("OAuth sign-in connects and reconnects on the core with the legacy responses", async () => {
    const accountUuid = crypto.randomUUID();
    const fetchImpl = claudeFetch(accountUuid, "person@example.test");
    const core = { connectedBySubjectId: null };
    const scope = oauthScope(workspaceId);
    const start = await startClaudeSubscriptionOAuth(deps, scope, {}, core);
    const code = "core-code#" + new URL(start.authorizationUrl).searchParams.get("state");
    const complete = await completeClaudeSubscriptionOAuth(
      deps,
      scope,
      { attemptId: start.attemptId, code },
      async () => {},
      fetchImpl,
      core,
    );
    expect(complete).toMatchObject({ connected: true, scope: "workspace" });
    expect(complete.credentialVersion).toBeGreaterThan(0);
    // Completing the same attempt again answers the stored result.
    expect(
      await completeClaudeSubscriptionOAuth(
        deps,
        scope,
        { attemptId: start.attemptId, code },
        async () => {},
        fetchImpl,
        core,
      ),
    ).toEqual(complete);
    const [stored] = await shared!.admin<
      { credential_format: string; provider_state: unknown; provider_account_id: string }[]
    >`
      select credential_format, provider_state, provider_account_id
      from subscription_connections where id = ${complete.accountId}::uuid`;
    expect(stored).toEqual({
      credential_format: "claude_oauth_v1",
      provider_state: { oauthScopes: ["user:inference", "user:profile"] },
      provider_account_id: accountUuid,
    });
    const account = (await listed()).accounts.find((entry) => entry.id === complete.accountId);
    expect(account).toMatchObject({
      email: "person@example.test",
      plan: "claude_max",
      subject: accountUuid,
      version: complete.credentialVersion,
    });

    // A reconnect of the same account moves the version by one.
    const again = await startClaudeSubscriptionOAuth(
      deps,
      scope,
      { reconnectAccountId: complete.accountId },
      core,
    );
    const reconnected = await completeClaudeSubscriptionOAuth(
      deps,
      scope,
      {
        attemptId: again.attemptId,
        code: "core-code#" + new URL(again.authorizationUrl).searchParams.get("state"),
      },
      async () => {},
      fetchImpl,
      core,
    );
    expect(reconnected).toEqual({
      connected: true,
      accountId: complete.accountId,
      scope: "workspace",
      credentialVersion: complete.credentialVersion + 1,
    });
    // A status transition (here the row change of 0707's needs_relogin
    // refresh-failure writer: status and version + 1) between start and
    // complete changes the account: 409, start again, nothing written.
    const raced = await startClaudeSubscriptionOAuth(
      deps,
      scope,
      { reconnectAccountId: complete.accountId },
      core,
    );
    await shared!.admin`
      update subscription_connections set status = 'needs_relogin',
        last_error = 'Sign-in expired', version = version + 1
      where id = ${complete.accountId}::uuid`;
    const [marked] = await shared!.admin<{ version: number; credential_encrypted: string }[]>`
      select version, credential_encrypted from subscription_connections
      where id = ${complete.accountId}::uuid`;
    await expect(
      completeClaudeSubscriptionOAuth(
        deps,
        scope,
        {
          attemptId: raced.attemptId,
          code: "core-code#" + new URL(raced.authorizationUrl).searchParams.get("state"),
        },
        async () => {},
        fetchImpl,
        core,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "Claude account changed during sign-in. Start again.",
    });
    const [unchanged] = await shared!.admin<{ version: number; credential_encrypted: string }[]>`
      select version, credential_encrypted from subscription_connections
      where id = ${complete.accountId}::uuid`;
    expect(unchanged).toEqual(marked!);
    // Started again, the reconnect lands and the account is active again.
    const retry = await startClaudeSubscriptionOAuth(
      deps,
      scope,
      { reconnectAccountId: complete.accountId },
      core,
    );
    expect(
      await completeClaudeSubscriptionOAuth(
        deps,
        scope,
        {
          attemptId: retry.attemptId,
          code: "core-code#" + new URL(retry.authorizationUrl).searchParams.get("state"),
        },
        async () => {},
        fetchImpl,
        core,
      ),
    ).toMatchObject({ accountId: complete.accountId, credentialVersion: marked!.version + 1 });
    expect(
      (await listed()).accounts.find((entry) => entry.id === complete.accountId),
    ).toMatchObject({ status: "active", version: marked!.version + 1 });

    // An attempt completes only on the runtime it started on: a core
    // attempt never completes on the legacy path.
    const coreAttempt = await startClaudeSubscriptionOAuth(deps, scope, {}, core);
    await expect(
      completeClaudeSubscriptionOAuth(
        deps,
        scope,
        {
          attemptId: coreAttempt.attemptId,
          code: "core-code#" + new URL(coreAttempt.authorizationUrl).searchParams.get("state"),
        },
        async () => {},
        fetchImpl,
        null,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "Claude account changed during sign-in. Start again.",
    });

    // Another Claude account never replaces it.
    const other = await startClaudeSubscriptionOAuth(
      deps,
      scope,
      { reconnectAccountId: complete.accountId },
      core,
    );
    await expect(
      completeClaudeSubscriptionOAuth(
        deps,
        scope,
        {
          attemptId: other.attemptId,
          code: "core-code#" + new URL(other.authorizationUrl).searchParams.get("state"),
        },
        async () => {},
        claudeFetch(crypto.randomUUID(), "other@example.test"),
        core,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("a private account is connected only in the owner's own Personal workspace", async () => {
    await expect(
      requireClaudeCorePersonalWorkspace(deps, { accountId, workspaceId, subjectId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      requireClaudeCorePersonalWorkspace(deps, {
        accountId,
        workspaceId: personalWorkspaceId,
        subjectId: "service:claude-core",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await requireClaudeCorePersonalWorkspace(deps, {
      accountId,
      workspaceId: personalWorkspaceId,
      subjectId,
    });
    // A personal sign-in completed in the Personal workspace is the owner's.
    const core = { connectedBySubjectId: subjectId };
    const scope = oauthScope(personalWorkspaceId);
    const start = await startClaudeSubscriptionOAuth(deps, scope, { scope: "user" }, core);
    const complete = await completeClaudeSubscriptionOAuth(
      deps,
      scope,
      {
        attemptId: start.attemptId,
        code: "core-code#" + new URL(start.authorizationUrl).searchParams.get("state"),
      },
      async () => {},
      claudeFetch(crypto.randomUUID(), "mine@example.test"),
      core,
    );
    expect(complete).toMatchObject({ connected: true, scope: "user" });
    const [stored] = await shared!.admin<{ ownership: string }[]>`
      select ownership from subscription_connections where id = ${complete.accountId}::uuid`;
    expect(stored!.ownership).toBe("personal");
    // The writer refuses the same sign-in in a shared workspace.
    const sharedScope = oauthScope(workspaceId);
    const refused = await startClaudeSubscriptionOAuth(deps, sharedScope, { scope: "user" }, core);
    await expect(
      completeClaudeSubscriptionOAuth(
        deps,
        sharedScope,
        {
          attemptId: refused.attemptId,
          code: "core-code#" + new URL(refused.authorizationUrl).searchParams.get("state"),
        },
        async () => {},
        claudeFetch(crypto.randomUUID(), "mine@example.test"),
        core,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
