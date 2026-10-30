/**
 * A person's own model subscriptions (Claude, SuperGrok, Codex) connected as
 * "Only me" in place, from a shared workspace of their organization, on real
 * PostgreSQL as the application role through managed browser sessions.
 *
 * A personal subscription belongs to its owner (SUB-OWN-03) and lives in their
 * own Personal workspace, which it serves (SUB-ELIG-05). Connecting it from a
 * shared workspace needs the caller's normal authority there and writes it in
 * their own current Personal workspace of the same organization, for them:
 * never anyone else's, never another organization's, not for a suspended
 * member, and not while the organization turns personal connections off.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { resolveCatalogSettings } from "@opengeni/core";
import { CLAUDE_OAUTH_TOKEN_URL } from "@opengeni/config";
import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono, type Context } from "hono";
import { registerClaudeSubscriptionAccountRoutes } from "../src/routes/claude-subscription-accounts";
import { registerClaudeSubscriptionOAuthRoutes } from "../src/routes/claude-subscription-oauth";
import { registerCodexRoutes } from "../src/routes/codex";
import { registerSuperGrokRoutes } from "../src/routes/supergrok";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ORIGIN = "https://app.opengeni.test";
const STATE_SECRET = "own-in-place-state-secret-at-least-32-bytes";
const encryptionKey = Buffer.alloc(32, 41);
const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: ORIGIN,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  claudeSubscriptionEnabled: true,
  supergrokSubscriptionEnabled: true,
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

/** The provider identity the next sign-in returns. */
let identity = { id: crypto.randomUUID(), email: "member@example.test" };

const claudeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === CLAUDE_OAUTH_TOKEN_URL)
    return Response.json({
      access_token: `sk-ant-oat01-own-${crypto.randomUUID()}`,
      refresh_token: `own-refresh-${crypto.randomUUID()}`,
      expires_in: 3600,
      scope: "user:inference user:profile",
      account: { uuid: identity.id, email_address: identity.email },
    });
  if (url === "https://api.anthropic.com/api/oauth/profile")
    return Response.json({
      account: { uuid: identity.id, email_address: identity.email, has_claude_max: true },
      organization: { organization_type: "claude_max" },
    });
  throw new Error(`unexpected Claude request: ${url}`);
}) as typeof fetch;

let xaiDevices = 0;
const xaiFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("/oauth2/device/code")) {
    xaiDevices += 1;
    return Response.json({
      device_code: `own-device-${xaiDevices}`,
      user_code: `OWN-${xaiDevices}`,
      verification_uri: "https://accounts.x.ai/device",
      verification_uri_complete: `https://accounts.x.ai/device?code=OWN-${xaiDevices}`,
      expires_in: 600,
      interval: 1,
    });
  }
  if (url.endsWith("/oauth2/token"))
    return Response.json({
      access_token: jwt({
        principal_type: "User",
        principal_id: identity.id,
        exp: Math.floor(Date.now() / 1_000) + 3_600,
      }),
      refresh_token: `own-xai-refresh-${xaiDevices}`,
      id_token: jwt({ sub: identity.id, email: identity.email, email_verified: true }),
      expires_in: 3600,
    });
  throw new Error(`unexpected xAI request: ${url}`);
}) as typeof fetch;

/** The Codex device-code endpoints, answered through the global fetch. */
async function withCodexDevice<T>(run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/deviceauth/usercode"))
      return Response.json({ device_auth_id: "own-dev", user_code: "OWN-CODE", interval: "5" });
    if (url.includes("/deviceauth/token"))
      return Response.json({ authorization_code: "own-code", code_verifier: "own-verifier" });
    if (url.includes("/oauth/token"))
      return Response.json({
        id_token: jwt({
          email: identity.email,
          "https://api.openai.com/auth": {
            chatgpt_account_id: `chatgpt-${identity.id}`,
            chatgpt_user_id: `user-${identity.id}`,
            chatgpt_plan_type: "pro",
          },
        }),
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "own-codex-refresh",
      });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

type Person = {
  subjectId: string;
  /** Their own organization (the one they were created with). */
  ownOrganizationId: string;
  app: Hono;
};

async function person(label: string): Promise<Person> {
  const userId = `own-in-place-${label}-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const sessionId = `session-${crypto.randomUUID()}`;
  await shared!.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${label}, ${email}, true)`;
  const access = await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId,
    email,
    name: label,
    emailVerified: true,
  });
  await shared!.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const login = await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  await shared!.admin`insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${login.identityId}, ${login.identityRevision}, ${login.authRevision}
    )`;
  const app = new Hono();
  app.onError((error: Error, c: Context) =>
    c.json({ message: error.message }, ((error as { status?: number }).status ?? 500) as 500),
  );
  const deps = {
    db: client!.db,
    settings,
    githubStateSecret: STATE_SECRET,
    xaiFetch,
    resolveCatalogSettings: async () => await resolveCatalogSettings(client!.db, settings),
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: sessionId, userId, expiresAt: new Date(Date.now() + 3_600_000) },
            user: { id: userId, email, name: label, emailVerified: true },
          },
        }),
      },
    },
  } as unknown as ApiRouteDeps;
  registerClaudeSubscriptionAccountRoutes(app, deps);
  registerClaudeSubscriptionOAuthRoutes(app, deps, claudeFetch);
  registerSuperGrokRoutes(app, deps);
  registerCodexRoutes(app, deps);
  return {
    subjectId: `user:${userId}`,
    ownOrganizationId: access.accessContext.workspaceGrants[0]!.accountId,
    app,
  };
}

/** A same-origin JSON request as this person's managed browser session. */
async function call(who: Person, method: string, path: string, body?: unknown) {
  const response = await who.app.request(`${ORIGIN}/v1${path}`, {
    method,
    headers: {
      cookie: "better-auth.session_token=present",
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

let owner: Person;
let member: Person;
let otherMember: Person;
let suspended: Person;
let outsider: Person;
let organizationId = "";
let sharedWorkspaceId = "";
const personalWorkspaces = new Map<string, string>();

/** Join the owner's organization as an ordinary member with a Personal workspace and a shared-workspace membership. */
async function joinAsMember(who: Person, label: string) {
  const [personal] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${organizationId}::uuid, ${`Personal ${label}`}) returning id::text as id`;
  personalWorkspaces.set(who.subjectId, personal!.id);
  await shared!.admin`insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, role
    ) values (${organizationId}::uuid, ${who.subjectId}, 'active', ${personal!.id}::uuid, 'member')`;
  await shared!.admin`insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions
    ) values (${organizationId}::uuid, ${sharedWorkspaceId}::uuid, ${who.subjectId}, 'member',
      ${shared!.admin.json(["workspace:read", "connections:write"])}::jsonb)`;
}

async function personalRows(provider: string) {
  return await shared!.admin<{ id: string; owner_subject_id: string }[]>`
    select id::text as id, owner_subject_id from subscription_connections
    where account_id = ${organizationId}::uuid and provider = ${provider}
      and ownership = 'personal'
    order by created_at, id`;
}

async function allRows() {
  const [row] = await shared!.admin<{ count: number }[]>`
    select count(*)::int as count from subscription_connections`;
  return row!.count;
}

const inShared = (path: string) => `/workspaces/${sharedWorkspaceId}${path}`;
const inPersonal = (who: Person, path: string) =>
  `/workspaces/${personalWorkspaces.get(who.subjectId)}${path}`;
const setupToken = () => `sk-ant-oat01-own-setup-${crypto.randomUUID()}`;

async function superGrokSignIn(who: Person, workspacePath: (path: string) => string) {
  const start = await call(who, "POST", workspacePath("/supergrok/connect/start"), {
    scope: "user",
  });
  if (start.status !== 200) return start;
  return await call(who, "POST", workspacePath("/supergrok/connect/poll"), {
    state: start.body.state,
  });
}

async function codexSignIn(who: Person, workspacePath: (path: string) => string) {
  return await withCodexDevice(async () => {
    const start = await call(who, "POST", workspacePath("/codex/connect/start"), {
      scope: "user",
    });
    if (start.status !== 200) return start;
    return await call(who, "POST", workspacePath("/codex/connect/poll"), {
      state: start.body.state,
    });
  });
}

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-subscription-own-in-place");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
  owner = await person("owner");
  member = await person("member");
  otherMember = await person("other");
  suspended = await person("suspended");
  outsider = await person("outsider");
  organizationId = owner.ownOrganizationId;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${organizationId}::uuid, 'Team') returning id::text as id`;
  sharedWorkspaceId = workspace!.id;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${sharedWorkspaceId}::uuid, ${organizationId}::uuid) on conflict do nothing`;
  await joinAsMember(member, "member");
  await joinAsMember(otherMember, "other");
  await joinAsMember(suspended, "suspended");
  await shared.admin`
    update subscription_settings set personal_connections_allowed = true
    where account_id = ${organizationId}::uuid and workspace_id is null`;
  for (const provider of ["claude", "xai", "codex"])
    await shared.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${organizationId}::uuid, ${provider}, true)
      on conflict (account_id, provider) do update set enabled = true`;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe.skipIf(!realDb)("own subscriptions connected in place from a shared workspace", () => {
  test("a regular member connects Claude as their own from a shared workspace", async () => {
    identity = { id: crypto.randomUUID(), email: "member-claude@example.test" };
    const pasted = await call(member, "POST", inShared("/claude/accounts/setup-token"), {
      token: setupToken(),
      scope: "user",
      label: "My Claude",
    });
    expect(pasted).toMatchObject({ status: 200, body: { connected: true, scope: "user" } });
    const signedIn = await (async () => {
      const oauth = inShared("/model-providers/claude_subscription/oauth");
      const start = await call(member, "POST", `${oauth}/start`, { scope: "user" });
      expect(start.status).toBe(200);
      const state = new URL(start.body.authorizationUrl).searchParams.get("state");
      return await call(member, "POST", `${oauth}/complete`, {
        attemptId: start.body.attemptId,
        code: `own-code#${state}`,
      });
    })();
    expect(signedIn).toMatchObject({ status: 200, body: { connected: true, scope: "user" } });

    // Both are the member's personal connections...
    const rows = await personalRows("claude");
    expect(rows.map((row) => row.id).sort()).toEqual(
      [pasted.body.accountId, signedIn.body.accountId].sort(),
    );
    expect(rows.every((row) => row.owner_subject_id === member.subjectId)).toBe(true);
    // ...kept in, and serving, their own Personal workspace.
    const listing = await call(member, "GET", inPersonal(member, "/claude/accounts"));
    expect(listing.status).toBe(200);
    const mine = listing.body.accounts.filter((each: { scope: string }) => each.scope === "user");
    expect(mine.map((each: { id: string }) => each.id).sort()).toEqual(
      [pasted.body.accountId, signedIn.body.accountId].sort(),
    );
    // The shared workspace's own inventory is unchanged.
    const sharedListing = await call(member, "GET", inShared("/claude/accounts"));
    expect(JSON.stringify(sharedListing.body)).not.toContain(pasted.body.accountId);

    // Reconnected in place by the id its owner sees, fenced on its version.
    const version = Number(
      mine.find((each: { id: string }) => each.id === pasted.body.accountId).version,
    );
    const replaced = await call(member, "POST", inShared("/claude/accounts/setup-token"), {
      token: setupToken(),
      scope: "user",
      reconnectAccountId: pasted.body.accountId,
      expectedCredentialVersion: version,
    });
    expect(replaced).toEqual({
      status: 200,
      body: {
        connected: true,
        accountId: pasted.body.accountId,
        credentialVersion: version + 1,
        scope: "user",
      },
    });

    // Another member never reaches it: not from the shared workspace...
    const hijack = await call(otherMember, "POST", inShared("/claude/accounts/setup-token"), {
      token: setupToken(),
      scope: "user",
      reconnectAccountId: pasted.body.accountId,
      expectedCredentialVersion: version + 1,
    });
    expect(hijack.status).toBe(409);
    // ...nor from their own Personal workspace, nor in its listing.
    const theirs = await call(otherMember, "GET", inPersonal(otherMember, "/claude/accounts"));
    expect(JSON.stringify(theirs.body)).not.toContain(pasted.body.accountId);
    expect(
      (
        await call(
          otherMember,
          "DELETE",
          inPersonal(otherMember, `/claude/accounts/${pasted.body.accountId}`),
        )
      ).status,
    ).toBe(404);
    // And the member's own Personal workspace is not theirs to open.
    expect((await call(otherMember, "GET", inPersonal(member, "/claude/accounts"))).status).toBe(
      404,
    );
    expect((await personalRows("claude")).map((row) => row.owner_subject_id)).toEqual([
      member.subjectId,
      member.subjectId,
    ]);
  });

  test("a regular member connects SuperGrok as their own from a shared workspace", async () => {
    identity = { id: `xai-${crypto.randomUUID()}`, email: "member-grok@example.test" };
    const connected = await superGrokSignIn(member, inShared);
    expect(connected).toMatchObject({ status: 200, body: { status: "connected", scope: "user" } });
    const rows = await personalRows("xai");
    expect(rows).toEqual([{ id: connected.body.accountId, owner_subject_id: member.subjectId }]);
    const listing = await call(member, "GET", inPersonal(member, "/supergrok/accounts"));
    expect(listing.status).toBe(200);
    expect(
      listing.body.accounts.filter((each: { scope: string }) => each.scope === "user"),
    ).toMatchObject([{ id: connected.body.accountId }]);
    const sharedListing = await call(member, "GET", inShared("/supergrok/accounts"));
    expect(JSON.stringify(sharedListing.body)).not.toContain(connected.body.accountId);
  });

  test("a regular member connects Codex as their own from a shared workspace", async () => {
    identity = { id: crypto.randomUUID(), email: "member-codex@example.test" };
    const connected = await codexSignIn(member, inShared);
    expect(connected).toMatchObject({ status: 200, body: { status: "connected", plan: "pro" } });
    const rows = await personalRows("codex");
    expect(rows).toEqual([{ id: connected.body.accountId, owner_subject_id: member.subjectId }]);
    const listing = await call(member, "GET", inPersonal(member, "/codex/accounts"));
    expect(listing.status).toBe(200);
    expect(JSON.stringify(listing.body)).toContain(connected.body.accountId);
    const sharedListing = await call(member, "GET", inShared("/codex/accounts"));
    expect(JSON.stringify(sharedListing.body)).not.toContain(connected.body.accountId);
  });

  test("someone from another organization is refused", async () => {
    const before = await allRows();
    identity = { id: crypto.randomUUID(), email: "outsider@example.test" };
    const attempts = [
      await call(outsider, "POST", inShared("/claude/accounts/setup-token"), {
        token: setupToken(),
        scope: "user",
      }),
      await call(outsider, "POST", inShared("/model-providers/claude_subscription/oauth/start"), {
        scope: "user",
      }),
      await superGrokSignIn(outsider, inShared),
      await codexSignIn(outsider, inShared),
    ];
    expect(attempts.map((attempt) => attempt.status)).toEqual([403, 403, 403, 403]);
    expect(await allRows()).toBe(before);
  });

  test("a suspended member is refused", async () => {
    await shared!.admin`
      update organization_memberships set status = 'suspended'
      where account_id = ${organizationId}::uuid and subject_id = ${suspended.subjectId}`;
    const before = await allRows();
    identity = { id: crypto.randomUUID(), email: "suspended@example.test" };
    for (const attempt of [
      await call(suspended, "POST", inShared("/claude/accounts/setup-token"), {
        token: setupToken(),
        scope: "user",
      }),
      await call(suspended, "POST", inShared("/model-providers/claude_subscription/oauth/start"), {
        scope: "user",
      }),
      await superGrokSignIn(suspended, inShared),
      await codexSignIn(suspended, inShared),
    ]) {
      expect(attempt.status).toBeGreaterThanOrEqual(400);
      expect(attempt.status).toBeLessThan(500);
    }
    expect(await allRows()).toBe(before);
  });

  test("nobody connects their own while the organization turns personal connections off", async () => {
    await shared!.admin`
      update subscription_settings set personal_connections_allowed = false
      where account_id = ${organizationId}::uuid and workspace_id is null`;
    try {
      const before = await allRows();
      identity = { id: crypto.randomUUID(), email: "off@example.test" };
      const claude = await call(otherMember, "POST", inShared("/claude/accounts/setup-token"), {
        token: setupToken(),
        scope: "user",
      });
      expect(claude.status).toBe(409);
      identity = { id: `xai-${crypto.randomUUID()}`, email: "off@example.test" };
      expect((await superGrokSignIn(otherMember, inShared)).status).toBe(409);
      identity = { id: crypto.randomUUID(), email: "off@example.test" };
      expect((await codexSignIn(otherMember, inShared)).status).toBe(409);
      expect(await allRows()).toBe(before);
    } finally {
      await shared!.admin`
        update subscription_settings set personal_connections_allowed = true
        where account_id = ${organizationId}::uuid and workspace_id is null`;
    }
  });

  test("the shared workspace's own accounts still need its administrator", async () => {
    const refused = await call(member, "POST", inShared("/claude/accounts/setup-token"), {
      token: setupToken(),
      scope: "workspace",
    });
    expect(refused.status).toBe(403);
    const grok = await call(member, "POST", inShared("/supergrok/connect/start"), {
      scope: "workspace",
    });
    expect(grok.status).toBe(403);
  });
});
