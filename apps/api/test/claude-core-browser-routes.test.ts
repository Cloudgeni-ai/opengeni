/**
 * M4 C2b: the Claude routes on the shared subscription core as a person's
 * managed browser session, on real PostgreSQL as the application role. The
 * organization routes and OAuth complete fail closed in maintenance; an OAuth
 * attempt completes only on the runtime it started on; the organization
 * routes (setup token, OAuth sign-in, list, rename, allocator, activate,
 * rotation, access, disconnect) answer from core connections, including by a
 * legacy id the cutover kept as an alias; and a private account is connected,
 * listed, renamed and reconnected only from its owner's own Personal
 * workspace (403 from a shared workspace, refused in another member's).
 *
 * C3 ships Claude's registry entry; this process registers it (the module
 * binding below) and the test database gets its registry row. Run this file
 * in its own process: the registration replaces module bindings process-wide.
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { CLAUDE_OAUTH_TOKEN_URL } from "@opengeni/config";
import type { Context, Hono as HonoApp } from "hono";

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
const { resolveCatalogSettings } = await import("@opengeni/core");
const { Hono } = await import("hono");
const { registerClaudeSubscriptionAccountRoutes } =
  await import("../src/routes/claude-subscription-accounts");
const { registerClaudeSubscriptionOAuthRoutes } =
  await import("../src/routes/claude-subscription-oauth");
const { registerModelConnectionAccessRoutes } =
  await import("../src/routes/model-connection-access");
const { synchronizeCanonicalHumanLoginBindings } =
  await import("@opengeni/db/canonical-human-identities");

const ORIGIN = "https://app.opengeni.test";
const encryptionKey = Buffer.alloc(32, 73);
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: "claude-core-browser-delegation-secret",
  publicBaseUrl: ORIGIN,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  claudeSubscriptionEnabled: true,
});

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof opengeniDb.createDb> | null = null;
let app: HonoApp | null = null;
let organizationId = "";
let ownerSubject = "";
let personalWorkspaceId = "";
let sharedWorkspaceId = "";
/** Another member's Personal workspace in the same organization. */
let otherPersonalWorkspaceId = "";
/** The Claude account the next OAuth token exchange signs in to. */
let signIn = { uuid: crypto.randomUUID(), email: "owner@example.test" };
let exchanges = 0;

const claudeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === CLAUDE_OAUTH_TOKEN_URL) {
    exchanges += 1;
    return Response.json({
      access_token: `sk-ant-oat01-browser-${crypto.randomUUID()}`,
      refresh_token: `browser-refresh-${crypto.randomUUID()}`,
      expires_in: 3600,
      scope: "user:inference user:profile",
      account: { uuid: signIn.uuid, email_address: signIn.email },
    });
  }
  if (url === "https://api.anthropic.com/api/oauth/profile")
    return Response.json({
      account: { uuid: signIn.uuid, email_address: signIn.email, has_claude_max: true },
      organization: { organization_type: "claude_max" },
    });
  throw new Error(`unexpected Claude request: ${url}`);
}) as typeof fetch;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-claude-core-browser-routes");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = opengeniDb.createDb(shared.appUrl);
  // The organization owner with a managed browser session.
  const userId = `claude-core-browser-${crypto.randomUUID()}`;
  const sessionId = `managed-session-${userId}`;
  const email = `${userId}@example.test`;
  ownerSubject = `user:${userId}`;
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Claude Owner', ${email}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  const access = await opengeniDb.ensureManagedAccessForUser(client.db, {
    userId,
    email,
    name: "Claude Owner",
  });
  organizationId = access.defaultAccountId!;
  const [personal] = await shared.admin<{ id: string }[]>`
    select personal_workspace_id::text as id from organization_memberships
    where account_id = ${organizationId}::uuid and subject_id = ${ownerSubject}`;
  personalWorkspaceId = personal!.id;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${organizationId}::uuid, 'Claude browser shared') returning id::text as id`;
  sharedWorkspaceId = workspace!.id;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${organizationId}::uuid, ${sharedWorkspaceId}::uuid, ${ownerSubject}, 'owner',
      '["workspace:read", "workspace:admin", "connections:write"]'::jsonb)`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${sharedWorkspaceId}::uuid, ${organizationId}::uuid) on conflict do nothing`;
  await shared.admin`
    update subscription_settings set personal_connections_allowed = true,
      personal_fallback_allowed = true
    where account_id = ${organizationId}::uuid and workspace_id is null`;
  // Another member and their own Personal workspace.
  const [otherPersonal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${organizationId}::uuid, 'Another member personal') returning id::text as id`;
  otherPersonalWorkspaceId = otherPersonal!.id;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${organizationId}::uuid, ${`user:claude-core-other-${crypto.randomUUID()}`}, 'member',
      'active', ${otherPersonalWorkspaceId}::uuid)`;

  app = new Hono();
  const deps = {
    db: client.db,
    settings,
    resolveCatalogSettings: async () => await resolveCatalogSettings(client!.db, settings),
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: sessionId, userId, expiresAt: new Date(Date.now() + 3_600_000) },
            user: { id: userId, email, name: "Claude Owner" },
          },
        }),
      },
    },
  } as never;
  registerClaudeSubscriptionAccountRoutes(app, deps);
  registerClaudeSubscriptionOAuthRoutes(app, deps, claudeFetch);
  registerModelConnectionAccessRoutes(app, deps);
  // The typed errors as the API renders them (code and details).
  app.onError((error: Error, c: Context) => {
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

/** A request as the owner's managed browser session (same-origin JSON). */
async function browser(path: string, method = "GET", body?: unknown) {
  const response = await app!.request(`${ORIGIN}/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      cookie: "better-auth.session_token=claude-owner",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
const organization = (path: string) => `/organizations/${organizationId}${path}`;
const workspace = (id: string, path: string) => `/workspaces/${id}${path}`;
const oauth = (scopePath: string) => `${scopePath}/model-providers/claude_subscription/oauth`;
const setupToken = () => `sk-ant-oat01-browser-setup-${crypto.randomUUID()}`;

/** Start and complete one OAuth sign-in through the routes. */
async function signInThrough(scopePath: string, body: Record<string, unknown>) {
  const start = await browser(`${oauth(scopePath)}/start`, "POST", body);
  expect(start.status).toBe(200);
  const state = new URL(start.body.authorizationUrl).searchParams.get("state");
  return await browser(`${oauth(scopePath)}/complete`, "POST", {
    attemptId: start.body.attemptId,
    code: `browser-code#${state}`,
  });
}

async function claudeRows() {
  return await shared!.admin<
    { id: string; ownership: string; version: number; connected_by_subject_id: string | null }[]
  >`
    select id::text as id, ownership, version, connected_by_subject_id
    from subscription_connections
    where account_id = ${organizationId}::uuid and provider = 'claude' order by created_at, id`;
}

async function alias(connectionId: string) {
  const legacyId = crypto.randomUUID();
  await shared!.admin`
    insert into subscription_connection_aliases (account_id, provider, alias_connection_id,
      connection_id)
    values (${organizationId}::uuid, 'claude', ${legacyId}::uuid, ${connectionId}::uuid)`;
  return legacyId;
}

/** A legacy OAuth attempt started before the receipt (completed after it). */
let legacyAttempt: { attemptId: string; code: string } | null = null;

describe.skipIf(!realDb)("Claude routes on the shared core, as a managed browser (M4 C2b)", () => {
  test("runs as the restricted application role; production registers no Claude", async () => {
    expect(productionIds).not.toContain("claude");
    const [role] = await shared!.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_catalog.pg_roles
      where rolname = ${new URL(shared!.appUrl).username}`;
    expect(new URL(shared!.appUrl).username).toBe("opengeni_app");
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    // Before the receipt the legacy OAuth start answers.
    const start = await browser(`${oauth(workspace(sharedWorkspaceId, ""))}/start`, "POST", {
      scope: "workspace",
    });
    expect(start.status).toBe(200);
    legacyAttempt = {
      attemptId: start.body.attemptId,
      code: `browser-code#${new URL(start.body.authorizationUrl).searchParams.get("state")}`,
    };
  });

  test("maintenance: the organization routes and OAuth complete fail closed", async () => {
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
      [organization("/claude/accounts"), "GET", undefined],
      [organization("/claude/settings"), "PATCH", { rotationEnabled: false }],
      [organization(`/claude/accounts/${id}`), "PATCH", { label: "x" }],
      [organization(`/claude/accounts/${id}/activate`), "POST", {}],
      [
        organization(`/claude/accounts/${id}/allocator`),
        "PATCH",
        { enabled: false, expectedVersion: 1 },
      ],
      [organization(`/claude/accounts/${id}`), "DELETE", undefined],
      [
        organization("/claude/accounts/setup-token"),
        "POST",
        { token: setupToken(), scope: "workspace" },
      ],
      [organization(`/model-connections/claude_subscription/${id}/access`), "GET", undefined],
      [`${oauth(organization(""))}/start`, "POST", { scope: "workspace" }],
      [`${oauth(organization(""))}/complete`, "POST", { attemptId: id, code: "a#b" }],
      [`${oauth(workspace(sharedWorkspaceId, ""))}/complete`, "POST", legacyAttempt],
      [`${oauth(workspace(personalWorkspaceId, ""))}/start`, "POST", { scope: "user" }],
    ] as const) {
      const response = await browser(path, method, body);
      expect({ path, method, ...response }).toMatchObject({
        path,
        method,
        status: 503,
        body: { reason: "subscription_core_cutover_disabled" },
      });
    }
    expect(exchanges).toBe(0);
  });

  test("an OAuth attempt started on the legacy path never completes on the core", async () => {
    await shared!.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${organizationId}::uuid, 'claude', true)`;
    const completed = await browser(
      `${oauth(workspace(sharedWorkspaceId, ""))}/complete`,
      "POST",
      legacyAttempt,
    );
    expect(completed).toEqual({
      status: 409,
      body: { code: null, message: "Claude account changed during sign-in. Start again." },
    });
    expect(exchanges).toBe(0);
    expect(await claudeRows()).toEqual([]);
  });

  test("organization routes answer from core connections, by legacy id too", async () => {
    // A setup token, as the organization's own account.
    const pasted = await browser(organization("/claude/accounts/setup-token"), "POST", {
      token: setupToken(),
      scope: "workspace",
      label: "Org token",
    });
    expect(pasted.status).toBe(200);
    expect(Object.keys(pasted.body).sort()).toEqual([
      "accountId",
      "connected",
      "credentialVersion",
      "scope",
    ]);
    expect(pasted.body).toMatchObject({ connected: true, scope: "organization" });
    // An OAuth sign-in through the organization routes.
    signIn = { uuid: crypto.randomUUID(), email: "org@example.test" };
    const signedIn = await signInThrough(organization(""), { scope: "workspace" });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({ connected: true, scope: "organization" });
    expect(signedIn.body.credentialVersion).toBeGreaterThan(0);
    const rows = await claudeRows();
    expect(rows.map((row) => [row.id, row.ownership, row.connected_by_subject_id])).toEqual([
      [pasted.body.accountId, "shared", ownerSubject],
      [signedIn.body.accountId, "shared", ownerSubject],
    ]);

    const listing = await browser(organization("/claude/accounts"));
    expect(listing.status).toBe(200);
    expect(listing.body).toMatchObject({ source: "organization", activeAccountId: null });
    for (const account of listing.body.accounts) {
      // One credential version: the listed version is the usage reading's.
      expect(account.usage.credentialVersion).toBe(account.version);
    }
    const listedSignIn = listing.body.accounts.find(
      (account: { id: string }) => account.id === signedIn.body.accountId,
    );
    expect(listedSignIn).toMatchObject({
      scope: "organization",
      version: signedIn.body.credentialVersion,
      subject: signIn.uuid,
    });

    // The organization routes accept the legacy id a drained cutover kept.
    const legacyId = await alias(signedIn.body.accountId);
    const renamed = await browser(organization(`/claude/accounts/${legacyId}`), "PATCH", {
      label: "Org Claude",
    });
    expect(renamed.status).toBe(200);
    const allocator = await browser(
      organization(`/claude/accounts/${legacyId}/allocator`),
      "PATCH",
      { enabled: true, expectedVersion: Number(listedSignIn.allocatorVersion) },
    );
    expect(allocator.status).toBe(200);
    const activated = await browser(
      organization(`/claude/accounts/${legacyId}/activate`),
      "POST",
      {},
    );
    expect(activated.status).toBe(200);
    const rotation = await browser(organization("/claude/settings"), "PATCH", {
      rotationEnabled: false,
    });
    expect(rotation).toMatchObject({
      status: 200,
      body: { rotationEnabled: false, activeCredentialId: signedIn.body.accountId },
    });
    const access = await browser(
      organization(`/model-connections/claude_subscription/${legacyId}/access`),
    );
    expect(access).toMatchObject({ status: 200 });
    const after = await browser(organization("/claude/accounts"));
    expect(after.body).toMatchObject({ activeAccountId: signedIn.body.accountId });
    expect(
      after.body.accounts.find((account: { id: string }) => account.id === signedIn.body.accountId),
    ).toMatchObject({ label: "Org Claude", active: true });

    // A setup token never replaces a signed-in account; nothing is written.
    const refused = await browser(organization("/claude/accounts/setup-token"), "POST", {
      token: setupToken(),
      scope: "workspace",
      reconnectAccountId: signedIn.body.accountId,
      expectedCredentialVersion: Number(
        after.body.accounts.find(
          (account: { id: string }) => account.id === signedIn.body.accountId,
        ).version,
      ),
    });
    expect(refused).toEqual({
      status: 409,
      body: {
        code: null,
        message: "A setup token can't replace a signed-in Claude account. Add it as a new account.",
      },
    });
    // A sign-in never upgrades a setup-token account in place.
    const pastedVersion = Number(
      after.body.accounts.find((account: { id: string }) => account.id === pasted.body.accountId)
        .version,
    );
    signIn = { uuid: crypto.randomUUID(), email: "upgrade@example.test" };
    const upgrade = await signInThrough(organization(""), {
      scope: "workspace",
      reconnectAccountId: pasted.body.accountId,
    });
    expect(upgrade).toEqual({
      status: 409,
      body: {
        code: null,
        message:
          "This account was added with a setup token. Add it again with Sign in, then remove the old one.",
      },
    });
    expect((await claudeRows()).find((row) => row.id === pasted.body.accountId)!.version).toBe(
      pastedVersion,
    );

    const disconnected = await browser(organization(`/claude/accounts/${legacyId}`), "DELETE");
    expect(disconnected.status).toBe(200);
    const remaining = await browser(organization("/claude/accounts"));
    expect(remaining.body.accounts.map((account: { id: string }) => account.id)).toEqual([
      pasted.body.accountId,
    ]);
  });

  test("a workspace OAuth sign-in records the browser's person as the connecting person", async () => {
    signIn = { uuid: crypto.randomUUID(), email: "team@example.test" };
    const signedIn = await signInThrough(workspace(sharedWorkspaceId, ""), { scope: "workspace" });
    expect(signedIn).toMatchObject({
      status: 200,
      body: { connected: true, scope: "workspace" },
    });
    const [row] = await shared!.admin<
      { ownership: string; managed_by_workspace_id: string; connected_by_subject_id: string }[]
    >`
      select ownership, managed_by_workspace_id::text, connected_by_subject_id
      from subscription_connections where id = ${signedIn.body.accountId}::uuid`;
    expect(row).toEqual({
      ownership: "shared",
      managed_by_workspace_id: sharedWorkspaceId,
      connected_by_subject_id: ownerSubject,
    });
    // The workspace's listing shows one credential version per account.
    const listing = await browser(workspace(sharedWorkspaceId, "/claude/accounts"));
    const listed = listing.body.accounts.find(
      (account: { id: string }) => account.id === signedIn.body.accountId,
    );
    expect(listed).toMatchObject({ version: signedIn.body.credentialVersion });
    expect(listed.usage.credentialVersion).toBe(listed.version);
  });

  test("a private account only from its owner's Personal workspace", async () => {
    const before = exchanges;
    const rowsBefore = (await claudeRows()).length;
    const refusal = {
      status: 403,
      body: {
        code: null,
        message: "Connect a private Claude account from your own Personal workspace.",
      },
    };
    // From a shared workspace the person belongs to: refused before any sign-in.
    expect(
      await browser(workspace(sharedWorkspaceId, "/claude/accounts/setup-token"), "POST", {
        token: setupToken(),
        scope: "user",
      }),
    ).toEqual(refusal);
    expect(
      await browser(`${oauth(workspace(sharedWorkspaceId, ""))}/start`, "POST", { scope: "user" }),
    ).toEqual(refusal);
    // Another member's Personal workspace is never the owner's: it is not
    // even visible to them (404, as for any workspace they cannot read).
    const elsewhere = await browser(
      workspace(otherPersonalWorkspaceId, "/claude/accounts/setup-token"),
      "POST",
      { token: setupToken(), scope: "user" },
    );
    const notVisible = { status: 404, body: { code: null, message: "workspace not found" } };
    expect(elsewhere).toEqual(notVisible);
    const elsewhereStart = await browser(
      `${oauth(workspace(otherPersonalWorkspaceId, ""))}/start`,
      "POST",
      { scope: "user" },
    );
    expect(elsewhereStart).toEqual(notVisible);
    expect(exchanges).toBe(before);
    expect((await claudeRows()).length).toBe(rowsBefore);

    // In the owner's Personal workspace: a pasted setup token...
    const pasted = await browser(
      workspace(personalWorkspaceId, "/claude/accounts/setup-token"),
      "POST",
      {
        token: setupToken(),
        scope: "user",
        label: "My token",
      },
    );
    expect(pasted).toMatchObject({ status: 200, body: { connected: true, scope: "user" } });
    // ...and an OAuth sign-in.
    signIn = { uuid: crypto.randomUUID(), email: "mine@example.test" };
    const signedIn = await signInThrough(workspace(personalWorkspaceId, ""), { scope: "user" });
    expect(signedIn).toMatchObject({ status: 200, body: { connected: true, scope: "user" } });
    const owned = (await claudeRows()).filter((row) => row.ownership === "personal");
    expect(owned.map((row) => row.id).sort()).toEqual(
      [pasted.body.accountId, signedIn.body.accountId].sort(),
    );

    // Listed to their owner as private accounts, with one credential version.
    const listing = await browser(workspace(personalWorkspaceId, "/claude/accounts"));
    expect(listing).toMatchObject({ status: 200, body: { source: "user" } });
    const mine = listing.body.accounts.filter(
      (account: { scope: string }) => account.scope === "user",
    );
    expect(mine.map((account: { id: string }) => account.id).sort()).toEqual(
      [pasted.body.accountId, signedIn.body.accountId].sort(),
    );
    for (const account of mine) expect(account.usage.credentialVersion).toBe(account.version);
    // Never listed in the shared workspace.
    const sharedListing = await browser(workspace(sharedWorkspaceId, "/claude/accounts"));
    expect(JSON.stringify(sharedListing.body)).not.toContain(pasted.body.accountId);

    // Renamed there: the plain legacy account shape (no usage reading).
    const renamed = await browser(
      workspace(personalWorkspaceId, `/claude/accounts/${pasted.body.accountId}`),
      "PATCH",
      { label: "Renamed token" },
    );
    expect(renamed).toMatchObject({
      status: 200,
      body: { id: pasted.body.accountId, label: "Renamed token", scope: "user" },
    });
    expect(renamed.body).not.toHaveProperty("usage");

    // Reconnected there by its legacy id (a personal alias resolves only for
    // its owner in their Personal workspace), fenced on the listed version.
    const relisted = await browser(workspace(personalWorkspaceId, "/claude/accounts"));
    const version = Number(
      relisted.body.accounts.find((account: { id: string }) => account.id === pasted.body.accountId)
        .version,
    );
    const legacyId = await alias(pasted.body.accountId);
    const replaced = await browser(
      workspace(personalWorkspaceId, "/claude/accounts/setup-token"),
      "POST",
      {
        token: setupToken(),
        scope: "user",
        reconnectAccountId: legacyId,
        expectedCredentialVersion: version,
      },
    );
    expect(replaced).toEqual({
      status: 200,
      body: {
        connected: true,
        accountId: pasted.body.accountId,
        credentialVersion: version + 1,
        scope: "user",
      },
    });
    // The same legacy id names nothing from the shared workspace.
    const sharedReplace = await browser(
      workspace(sharedWorkspaceId, "/claude/accounts/setup-token"),
      "POST",
      {
        token: setupToken(),
        scope: "workspace",
        reconnectAccountId: legacyId,
        expectedCredentialVersion: version + 1,
      },
    );
    expect(sharedReplace.status).toBe(409);
    // An OAuth reconnect of the signed-in account in the Personal workspace.
    const reconnected = await signInThrough(workspace(personalWorkspaceId, ""), {
      scope: "user",
      reconnectAccountId: signedIn.body.accountId,
    });
    expect(reconnected).toEqual({
      status: 200,
      body: {
        connected: true,
        accountId: signedIn.body.accountId,
        scope: "user",
        credentialVersion: signedIn.body.credentialVersion + 1,
      },
    });

    const disconnected = await browser(
      workspace(personalWorkspaceId, `/claude/accounts/${signedIn.body.accountId}`),
      "DELETE",
    );
    expect(disconnected.status).toBe(200);
    const after = await browser(workspace(personalWorkspaceId, "/claude/accounts"));
    expect(JSON.stringify(after.body.accounts)).not.toContain(signedIn.body.accountId);
  });
});
