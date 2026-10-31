/**
 * M4 C2b: the Claude routes on the shared subscription core, on real
 * PostgreSQL as the application role. The same paths, verbs and response
 * shapes are served from core connections (setup-token connect and replace, OAuth sign-in,
 * list, rename, allocator, activate, rotation, the access policy, alias
 * translation, disconnect), and a private account is connected only in the
 * person's own Personal workspace.
 *
 * C3 ships Claude's registry entry; this process registers it (the module
 * binding below) and the test database gets its registry row. Run this file in
 * its own process: the registration replaces module bindings process-wide.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { CLAUDE_OAUTH_TOKEN_URL } from "@opengeni/config";
import type { Hono as HonoApp } from "hono";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const registryPath = Bun.resolveSync(
  "../../../packages/db/src/subscription-core-providers.ts",
  import.meta.dir,
);
const realRegistry = await import(registryPath);

const productionIds: string[] = realRegistry.subscriptionCoreProviderIds();

const opengeniDb = await import("@opengeni/db");
const { Hono } = await import("hono");
const { registerClaudeSubscriptionAccountRoutes } =
  await import("../src/routes/claude-subscription-accounts");
const { registerClaudeSubscriptionOAuthRoutes } =
  await import("../src/routes/claude-subscription-oauth");
const { registerModelConnectionAccessRoutes } =
  await import("../src/routes/model-connection-access");
const { subscriptionSettingsLockedHttpError } =
  await import("../src/routes/model-account-settings");
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
  // The typed errors as the API renders them (code and details), with the
  // app's central settings-lock mapping.
  for (const routes of [app, keyApp])
    routes.onError((raw, c) => {
      const error: Error = subscriptionSettingsLockedHttpError(raw) ?? raw;
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
  options: { method?: string; body?: unknown; permissions?: Permission[]; workspace?: string } = {},
): Promise<Response> {
  const workspace = options.workspace ?? workspaceId;
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId: workspace,
    subjectId,
    principalKind: "human_session",
    permissions: options.permissions ?? ["workspace:read", "workspace:admin"],
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return await app!.request(`http://x/v1/workspaces/${workspace}${path}`, {
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
  test("the production core serves the established account response shape", async () => {
    expect(productionIds).toContain("claude");
    const [role] = await shared!.admin<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`select rolsuper, rolbypassrls from pg_catalog.pg_roles where rolname = ${new URL(shared!.appUrl).username}`;
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
    expect((await request(`/claude/accounts/${body.accountId}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await listed()).accounts).toEqual([]);
    expect((await keyOAuthStart()).status).toBe(200);
  });

  test("with the switch row the same routes answer from core connections", async () => {
    await shared!.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${accountId}::uuid, 'claude', true) on conflict (account_id, provider) do update set enabled = true`;
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

    // An organization lock on rotation (0724) binds the Claude core writers
    // as it binds Codex's and SuperGrok's. Locking clears the workspace's
    // rotation map (its primary column stays but is inert without a rotation
    // entry), so the listing shows the organization's values; rotation and
    // activate are then refused with the 409 `setting_locked` and write
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
        select rotation, claude_primary_connection_id::text as primary from subscription_settings
        where account_id = ${accountId}::uuid and workspace_id = ${workspaceId}::uuid`;
    await lockRotation(["rotation"]);
    try {
      const lockedOverride = await storedOverride();
      expect(lockedOverride).toEqual([{ rotation: null, primary: body.accountId }]);
      expect(await listed()).toMatchObject({
        activeAccountId: null,
        settings: { rotationEnabled: true, activeCredentialId: null },
      });
      for (const [path, method, lockedBody] of [
        ["/claude/settings", "PATCH", { rotationEnabled: false }],
        [`/claude/accounts/${body.accountId}/activate`, "POST", undefined],
      ] as const) {
        const locked = await request(path, { method, body: lockedBody });
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
    const reactivated = await request(`/claude/accounts/${body.accountId}/activate`, {
      method: "POST",
    });
    expect(reactivated.status).toBe(200);
    expect(await listed()).toMatchObject({
      activeAccountId: body.accountId,
      settings: { activeCredentialId: body.accountId },
    });

    // The access policy is the core connection's (the legacy row is never read).
    const accessPath = `/model-connections/claude_subscription/${body.accountId}/access`;
    const access = await request(accessPath);
    expect(access.status).toBe(200);
    const accessBody = await access.json();
    // A workspace's own account serves its workspace, which manages it (D-52).
    expect(accessBody).toMatchObject({
      policy: { allowedModels: null, allowedWorkspaces: [workspaceId] },
      localWorkspaceIds: [workspaceId],
      managedByWorkspaceId: workspaceId,
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

  test("a private account is kept in the owner's own Personal workspace", async () => {
    // From wherever the person is, a private account lives in their own
    // Personal workspace; a subject without one is refused.
    expect(await requireClaudeCorePersonalWorkspace(deps, { accountId, subjectId })).toBe(
      personalWorkspaceId,
    );
    await expect(
      requireClaudeCorePersonalWorkspace(deps, {
        accountId,
        subjectId: "service:claude-core",
      }),
    ).rejects.toMatchObject({ status: 403 });
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
    // The writer itself still refuses a personal sign-in written in a shared
    // workspace: the route must place it in the owner's Personal workspace.
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

  test("a private account added from a shared workspace starts turned on there for its owner (D-53)", async () => {
    const core = { connectedBySubjectId: subjectId };
    // As the route does: the sign-in starts in the shared workspace and the
    // account lives in the owner's Personal workspace.
    const sharedScope = oauthScope(workspaceId);
    const start = await startClaudeSubscriptionOAuth(
      deps,
      sharedScope,
      { scope: "user" },
      core,
      personalWorkspaceId,
    );
    const complete = await completeClaudeSubscriptionOAuth(
      deps,
      sharedScope,
      {
        attemptId: start.attemptId,
        code: "core-code#" + new URL(start.authorizationUrl).searchParams.get("state"),
      },
      async () => personalWorkspaceId,
      claudeFetch(crypto.randomUUID(), "added-here@example.test"),
      core,
    );
    expect(complete).toMatchObject({ connected: true, scope: "user" });
    const grants = await shared!.admin<{ workspace_id: string; mode: string; context: string }[]>`
      select grant_value.workspace_id::text, grant_value.mode, grant_value.context
      from organization_user_resource_grants grant_value
      join subscription_connections connection on connection.authority_id = grant_value.authority_id
      where connection.id = ${complete.accountId}::uuid
        and grant_value.action = 'subscription_connection.use' and grant_value.status = 'active'`;
    // On where it was added, for the owner's own turns there; nowhere else.
    expect(grants).toEqual([
      { workspace_id: workspaceId, mode: "always", context: "workspace_shared" },
    ]);
  });

  test("SUB-OWN-04, D-52: a workspace's own account serves workspaces its admins also administer, and stays its own", async () => {
    // Another shared workspace this person administers, and one they only use.
    const workspace = async (name: string, role: string, permissions: string[]) => {
      const [row] = await shared!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${accountId}::uuid, ${name}) returning id::text as id`;
      await shared!.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
        values (${accountId}::uuid, ${row!.id}::uuid, ${subjectId}, ${role},
          ${JSON.stringify(permissions)}::jsonb)`;
      await shared!.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${row!.id}::uuid, ${accountId}::uuid)`;
      return row!.id;
    };
    const administered = await workspace("D-52 administered", "admin", [
      "workspace:read",
      "workspace:admin",
    ]);
    const used = await workspace("D-52 used", "member", ["workspace:read"]);
    const connected = await connectSetupToken({ label: "D-52 Claude" });
    expect(connected.status).toBe(200);
    const { accountId: connectionId } = await connected.json();
    const accessPath = `/model-connections/claude_subscription/${connectionId}/access`;
    const owner = async () =>
      (
        await shared!.admin<{ managed_by_workspace_id: string | null }[]>`
          select managed_by_workspace_id::text as managed_by_workspace_id
          from subscription_connections where id = ${connectionId}::uuid`
      )[0]!.managed_by_workspace_id;
    const served = async () =>
      (
        await shared!.admin<{ workspace_id: string }[]>`
          select workspace_id::text as workspace_id from subscription_connection_workspaces
          where connection_id = ${connectionId}::uuid order by workspace_id`
      ).map((row) => row.workspace_id);

    // Its route offers the workspaces this person administers, never one they only use.
    const read = await request(accessPath);
    expect(read.status).toBe(200);
    const body = await read.json();
    const offered = body.workspaces.map((entry: { id: string }) => entry.id);
    expect(offered).toContain(workspaceId);
    expect(offered).toContain(administered);
    expect(offered).not.toContain(used);
    expect(offered).not.toContain(personalWorkspaceId);
    expect(body).toMatchObject({
      policy: { allowedWorkspaces: [workspaceId], allowPersonalWorkspaces: false },
      peopleSupported: false,
      personalWorkspacesSupported: false,
      managedByWorkspaceId: workspaceId,
    });

    // Personal workspaces, people or a move are refused from here, and nothing
    // changes. (A workspace admin who isn't the organization's can't add a
    // workspace they only use either; the database tests cover that person.)
    const latest = async () => (await (await request(accessPath)).json()).policy;
    const put = async (policy: Record<string, unknown>) =>
      request(accessPath, { method: "PUT", body: { ...(await latest()), ...policy } });
    expect((await put({ allowPersonalWorkspaces: true })).status).toBe(422);
    expect((await put({ allowedPeople: [] })).status).toBe(422);
    expect((await put({ moveToOrganization: true })).status).toBe(422);
    expect(await served()).toEqual([workspaceId]);

    // Shared with a workspace this person administers: it stays its workspace's.
    const sharing = await put({ allowedWorkspaces: [workspaceId, administered] });
    expect(sharing.status).toBe(200);
    expect((await sharing.json()).allowedWorkspaces).toEqual([workspaceId, administered].sort());
    expect(await owner()).toBe(workspaceId);
    expect(await served()).toEqual([workspaceId, administered].sort());
    // The organization's owner can share it with any shared workspace, as from
    // the organization's page; it still stays its workspace's.
    expect((await put({ allowedWorkspaces: [workspaceId, administered, used] })).status).toBe(200);
    expect(await owner()).toBe(workspaceId);
    expect(await served()).toEqual([workspaceId, administered, used].sort());

    // Its own workspace can't drop it: it is always served there.
    expect((await put({ allowedWorkspaces: [] })).status).toBe(200);
    expect(await served()).toEqual([workspaceId]);
    // A stale version is a conflict, never a silent overwrite.
    const stale = await request(accessPath, {
      method: "PUT",
      body: { ...body.policy, allowedWorkspaces: [administered] },
    });
    expect(stale.status).toBe(409);
    expect(await served()).toEqual([workspaceId]);
    expect((await put({ allowedWorkspaces: [administered] })).status).toBe(200);
    expect(await served()).toEqual([workspaceId, administered].sort());

    // The receiving workspace's admins can stop using it, but not from its own workspace.
    const remove = (from: string) => request(accessPath, { method: "DELETE", workspace: from });
    expect((await remove(workspaceId)).status).toBe(404);
    expect((await remove(administered)).status).toBe(204);
    expect(await served()).toEqual([workspaceId]);
    expect(await owner()).toBe(workspaceId);
    expect((await remove(administered)).status).toBe(404);
  });
});
