// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REDIRECT_URL,
  ClaudeSubscriptionCredential,
} from "@opengeni/config";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createDb,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  loadIntegrationOAuthPendingState,
  loadClaudeSubscriptionUsageCredential,
  readClaudeSubscriptionUsage,
  resolveClaudeSubscriptionCredential,
  storeIntegrationOAuthPendingState,
  upsertWorkspaceProviderApiKeyConnection,
  type DbClient,
  rotateWorkspaceProviderApiKeyConnection,
  synchronizeCanonicalHumanLoginBindings,
  ensureManagedAccessForUserWithOrganizationMemberships,
  loadWorkspaceProviderApiKey,
  loadOrganizationModelProviderApiKey,
  createOrganizationModelProviderCustomModel,
} from "@opengeni/db";
import {
  startClaudeSubscriptionOAuth,
  completeClaudeSubscriptionOAuth,
  type ClaudeOAuthScope,
} from "../src/claude-subscription-oauth";
import { prepareClaudeSubscriptionCredential } from "../src/claude-workspace-connection";
import { registerClaudeSubscriptionOAuthRoutes } from "../src/routes/claude-subscription-oauth";
import { settingsWithOrganizationProviderCredentials } from "../../worker/src/activities/capabilities";
import { parseModelProvidersJson } from "@opengeni/config";
import { refreshClaudeSubscriptionUsage } from "../src/claude-subscription-usage";

const key = Buffer.alloc(32, 11);
const settings = testSettings({
  claudeSubscriptionEnabled: true,
  environmentsEncryptionKey: key.toString("base64"),
});
let shared: SharedTestDatabase, client: DbClient, deps: ApiRouteDeps;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("claude-subscription-oauth");
  if (!db) throw new Error("Real PostgreSQL required for Claude sign-in verification");
  shared = db;
  client = createDb(db.appUrl);
  deps = { db: client.db, settings } as ApiRouteDeps;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(organization = false): Promise<ClaudeOAuthScope> {
  const [account] = await shared.admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('Claude sign-in test') returning id`;
  const [workspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${account!.id}, 'Claude test') returning id`;
  const actorSubjectId = "user:" + randomUUID();
  if (organization)
    await shared.admin`insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id) values (${account!.id}, ${actorSubjectId}, 'owner', 'active', ${workspace!.id})`;
  return {
    accountId: account!.id,
    workspaceId: organization ? null : workspace!.id,
    actorSubjectId,
    browserSessionHash: "browser:" + randomUUID(),
  };
}
function usageScope(scope: ClaudeOAuthScope) {
  return {
    ...scope,
    scope: scope.workspaceId ? ("workspace" as const) : ("organization" as const),
  };
}
async function begin(scope: ClaudeOAuthScope) {
  const start = await startClaudeSubscriptionOAuth(deps, scope);
  const state = new URL(start.authorizationUrl).searchParams.get("state")!;
  return { ...start, code: "fixture-code#" + state };
}
function provider(
  options: {
    token?: string;
    refresh?: string;
    expiresIn?: number;
    scopes?: string;
  } = {},
) {
  const calls: Array<{
    url: string;
    method: string;
    body: any;
    authorization: string | null;
  }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? await request.json() : null;
    calls.push({
      url: request.url,
      method: request.method,
      body,
      authorization: request.headers.get("authorization"),
    });
    if (request.url === CLAUDE_OAUTH_TOKEN_URL)
      return Response.json({
        access_token: options.token ?? "sk-ant-oat01-full-fixture",
        refresh_token: options.refresh ?? "fixture-refresh-v1",
        expires_in: options.expiresIn ?? 3600,
        scope: options.scopes ?? "user:inference user:profile",
        account: { uuid: "11111111-1111-4111-8111-111111111111" },
      });
    if (request.url === "https://api.anthropic.com/api/oauth/usage")
      return Response.json({
        five_hour: {
          utilization: 25,
          resets_at: new Date(Date.now() + 3600_000).toISOString(),
        },
        seven_day: {
          utilization: 60,
          resets_at: new Date(Date.now() + 86400_000).toISOString(),
        },
      });
    throw new Error("Unexpected request; inference forbidden in sign-in tests");
  }) as typeof fetch;
  return { fetchImpl, calls };
}
async function connect(scope: ClaudeOAuthScope) {
  const attempt = await begin(scope),
    mock = provider();
  await completeClaudeSubscriptionOAuth(deps, scope, attempt, async () => {}, mock.fetchImpl);
  return { attempt, mock };
}
async function expire(scope: ClaudeOAuthScope) {
  const value = (await loadClaudeSubscriptionUsageCredential(
    client.db,
    settings,
    usageScope(scope),
  ))!;
  const bundle = ClaudeSubscriptionCredential.parse(JSON.parse(value.serializedCredential));
  bundle.oauth!.expiresAt = new Date(Date.now() - 1000).toISOString();
  const serialized = JSON.stringify(bundle);
  const encrypted = encryptEnvironmentValue(
    key,
    scope.workspaceId ? JSON.stringify({ apiKey: serialized }) : serialized,
  );
  if (scope.workspaceId)
    await shared.admin`update connections set credential_encrypted = ${encrypted} where id = ${value.connectionId}`;
  else
    await shared.admin`update organization_model_provider_connections set credential_encrypted = ${encrypted} where id = ${value.connectionId}`;
  return value;
}

for (const organization of [false, true]) {
  const label = organization ? "organization" : "workspace";
  test(`${label} full sign-in uses PKCE, native encrypted storage, direct usage and exact replay`, async () => {
    const scope = await fixture(organization),
      start = await begin(scope),
      mock = provider();
    const raw = await loadIntegrationOAuthPendingState(client.db, {
      ...scope,
      id: start.attemptId,
    });
    const pending = JSON.parse(decryptEnvironmentValue(key, raw!));
    const url = new URL(start.authorizationUrl);
    expect(url.origin).toBe("https://claude.com");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(["user:inference", "user:profile"]);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(pending.verifier).digest("base64url"),
    );
    let rechecks = 0;
    const result = await completeClaudeSubscriptionOAuth(
      deps,
      scope,
      start,
      async () => {
        rechecks++;
      },
      mock.fetchImpl,
    );
    expect(rechecks).toBe(1);
    expect(result).toEqual({ connected: true, credentialVersion: 1 });
    expect(mock.calls[0]).toMatchObject({
      url: CLAUDE_OAUTH_TOKEN_URL,
      method: "POST",
      body: {
        grant_type: "authorization_code",
        code: "fixture-code",
        code_verifier: pending.verifier,
        state: pending.state,
        redirect_uri: CLAUDE_OAUTH_REDIRECT_URL,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      },
    });
    expect(mock.calls).toHaveLength(2);
    const saved = (await loadClaudeSubscriptionUsageCredential(
      client.db,
      settings,
      usageScope(scope),
    ))!;
    expect(saved.credentialEncrypted).not.toContain("fixture-refresh-v1");
    expect(saved.credentialVersion).toBe(1);
    const bundle = ClaudeSubscriptionCredential.parse(JSON.parse(saved.serializedCredential));
    expect(bundle.oauth!.scopes).toEqual(["user:inference", "user:profile"]);
    expect(bundle.identity.accountUuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(bundle.identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.usage.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ["five_hour", 25],
      ["seven_day", 60],
    ]);
    expect(saved.usage.refreshStatus).toBe("available");
    const completed = JSON.parse(
      decryptEnvironmentValue(
        key,
        (await loadIntegrationOAuthPendingState(client.db, {
          ...scope,
          id: start.attemptId,
        }))!,
      ),
    );
    expect(completed.stage).toBe("complete");
    expect(completed.verifier).toBeUndefined();
    expect(completed.token).toBeUndefined();
    expect(
      await completeClaudeSubscriptionOAuth(deps, scope, start, async () => {}, mock.fetchImpl),
    ).toEqual(result);
    expect(mock.calls).toHaveLength(2);
  });

  test(`${label} token renewal serializes replicas, retains generation, identity and quota cache`, async () => {
    const scope = await fixture(organization);
    await connect(scope);
    const original = await expire(scope),
      mock = provider({
        token: "sk-ant-oat01-renewed-fixture",
        refresh: "fixture-refresh-v2",
      });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        resolveClaudeSubscriptionCredential(client.db, settings, usageScope(scope), {
          fetchImpl: mock.fetchImpl,
        }),
      ),
    );
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.body).toEqual({
      grant_type: "refresh_token",
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      refresh_token: "fixture-refresh-v1",
      scope: "user:inference user:profile",
    });
    expect(results.every((result) => result?.token === "sk-ant-oat01-renewed-fixture")).toBe(true);
    expect(
      results.every(
        (result) =>
          result?.credentialVersion === original.credentialVersion &&
          result?.connectionId === original.connectionId,
      ),
    ).toBe(true);
    expect((await readClaudeSubscriptionUsage(client.db, usageScope(scope))).windows).toEqual(
      original.usage.windows,
    );
    const final = (await loadClaudeSubscriptionUsageCredential(
      client.db,
      settings,
      usageScope(scope),
    ))!;
    expect(JSON.parse(final.serializedCredential).identity).toEqual(
      JSON.parse(original.serializedCredential).identity,
    );
    expect(JSON.parse(final.serializedCredential).oauth.refreshToken).toBe("fixture-refresh-v2");
  });
}

test("wrong code/state, browser, actor and scope cannot spend or hijack a pending grant", async () => {
  const scope = await fixture(),
    start = await begin(scope),
    mock = provider();
  for (const bad of [
    { ...scope, browserSessionHash: "another-browser" },
    { ...scope, actorSubjectId: "user:other" },
  ])
    await expect(
      completeClaudeSubscriptionOAuth(deps, bad, start, async () => {}, mock.fetchImpl),
    ).rejects.toThrow("browser");
  await expect(
    completeClaudeSubscriptionOAuth(
      deps,
      scope,
      { ...start, code: "code#wrong-state" },
      async () => {},
      mock.fetchImpl,
    ),
  ).rejects.toThrow("full authorization code");
  const foreign = await fixture();
  await expect(
    completeClaudeSubscriptionOAuth(deps, foreign, start, async () => {}, mock.fetchImpl),
  ).rejects.toThrow("expired");
  expect(mock.calls).toHaveLength(0);
  await completeClaudeSubscriptionOAuth(deps, scope, start, async () => {}, mock.fetchImpl);
  expect(mock.calls).toHaveLength(2);
});

test("expiration and another provider's encrypted attempt are rejected without provider requests", async () => {
  const scope = await fixture(),
    start = await begin(scope),
    mock = provider();
  await shared.admin`update integration_oauth_pending_states set expires_at = now() - interval '1 second' where id = ${start.attemptId}`;
  await expect(
    completeClaudeSubscriptionOAuth(deps, scope, start, async () => {}, mock.fetchImpl),
  ).rejects.toThrow("expired");
  const id = randomUUID();
  await storeIntegrationOAuthPendingState(client.db, {
    ...scope,
    id,
    stateEncrypted: encryptEnvironmentValue(key, JSON.stringify({ purpose: "fiken" })),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await expect(
    completeClaudeSubscriptionOAuth(
      deps,
      scope,
      { attemptId: id, code: "code#state" },
      async () => {},
      mock.fetchImpl,
    ),
  ).rejects.toThrow("expired");
  expect(mock.calls).toHaveLength(0);
});

test("lost authority after exchange cannot store a credential", async () => {
  const scope = await fixture(),
    start = await begin(scope),
    mock = provider();
  await expect(
    completeClaudeSubscriptionOAuth(
      deps,
      scope,
      start,
      async () => {
        throw new HTTPException(403, { message: "Access revoked" });
      },
      mock.fetchImpl,
    ),
  ).rejects.toThrow("Access revoked");
  expect(
    await loadClaudeSubscriptionUsageCredential(client.db, settings, usageScope(scope)),
  ).toBeNull();
  expect(mock.calls).toHaveLength(1);
  await expect(
    completeClaudeSubscriptionOAuth(deps, scope, start, async () => {}, mock.fetchImpl),
  ).rejects.toThrow("already used");
  expect(mock.calls).toHaveLength(1);
});

test("concurrent completion spends a code once and then recovers its exact receipt", async () => {
  const scope = await fixture(),
    start = await begin(scope),
    mock = provider();
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      completeClaudeSubscriptionOAuth(deps, scope, start, async () => {}, mock.fetchImpl),
    ),
  );
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect(mock.calls.filter((call) => call.url === CLAUDE_OAUTH_TOKEN_URL)).toHaveLength(1);
  expect(
    await completeClaudeSubscriptionOAuth(deps, scope, start, async () => {}, mock.fetchImpl),
  ).toEqual({ connected: true, credentialVersion: 1 });
});

test("setup-token connections never attempt renewal or gain profile access", async () => {
  const scope = await fixture();
  const serialized = prepareClaudeSubscriptionCredential(
    settings,
    "workspace:" + scope.workspaceId,
    "sk-ant-oat01-setup-fixture",
  );
  await upsertWorkspaceProviderApiKeyConnection(client.db, "claude_subscription", {
    ...scope,
    workspaceId: scope.workspaceId!,
    operationId: randomUUID(),
    requestDigest: "a".repeat(64),
    credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify({ apiKey: serialized })),
    updatedBySubjectId: scope.actorSubjectId,
  });
  const mock = provider(),
    result = await resolveClaudeSubscriptionCredential(client.db, settings, usageScope(scope), {
      fetchImpl: mock.fetchImpl,
    });
  expect(result?.token).toBe("sk-ant-oat01-setup-fixture");
  expect(mock.calls).toHaveLength(0);
});

test("invalid refresh grants persist reconnect truth; transient failures keep credentials", async () => {
  const scope = await fixture();
  await connect(scope);
  const original = await expire(scope);
  await expect(
    resolveClaudeSubscriptionCredential(client.db, settings, usageScope(scope), {
      fetchImpl: (async () =>
        Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch,
    }),
  ).rejects.toThrow("renew Claude");
  expect(
    (await loadClaudeSubscriptionUsageCredential(client.db, settings, usageScope(scope)))!.token,
  ).toBe(original.token);
  // The real API adapter must expose transient provider renewal failures as
  // retryable availability, rather than a generic internal 500 or token loss.
  let apiFailure: unknown;
  try {
    await refreshClaudeSubscriptionUsage(client.db, settings, usageScope(scope), (async () =>
      Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch);
  } catch (error) {
    apiFailure = error;
  }
  expect(apiFailure).toBeInstanceOf(HTTPException);
  expect((apiFailure as HTTPException).status).toBe(503);
  expect(
    (await loadClaudeSubscriptionUsageCredential(client.db, settings, usageScope(scope)))!.token,
  ).toBe(original.token);
  const result = await resolveClaudeSubscriptionCredential(client.db, settings, usageScope(scope), {
    fetchImpl: (async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch,
  });
  expect(result && "reconnectRequired" in result).toBe(true);
  expect((await readClaudeSubscriptionUsage(client.db, usageScope(scope))).refreshStatus).toBe(
    "reconnect",
  );
});

test("organization pending attempts require an owner and cannot be read through shared runtime scope", async () => {
  const scope = await fixture(true),
    start = await begin(scope);
  await expect(
    loadIntegrationOAuthPendingState(client.db, {
      ...scope,
      actorSubjectId: "user:other",
      id: start.attemptId,
    }),
  ).rejects.toThrow();
  await expect(
    loadIntegrationOAuthPendingState(client.db, {
      accountId: scope.accountId,
      workspaceId: null,
      id: start.attemptId,
    }),
  ).rejects.toThrow("administrator");
  const [workspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${scope.accountId}, 'Shared runtime') returning id`;
  expect(
    await loadIntegrationOAuthPendingState(client.db, {
      accountId: scope.accountId,
      workspaceId: workspace!.id,
      id: start.attemptId,
    }),
  ).toBeNull();
});

async function replace(scope: ClaudeOAuthScope) {
  const previous = (await loadClaudeSubscriptionUsageCredential(
    client.db,
    settings,
    usageScope(scope),
  ))!;
  const serialized = prepareClaudeSubscriptionCredential(
    settings,
    "workspace:" + scope.workspaceId,
    "sk-ant-oat01-replacement-fixture",
  );
  return rotateWorkspaceProviderApiKeyConnection(client.db, "claude_subscription", {
    ...scope,
    workspaceId: scope.workspaceId!,
    connectionId: previous.connectionId,
    expectedVersion: previous.credentialVersion,
    operationId: randomUUID(),
    requestDigest: "b".repeat(64),
    updatedBySubjectId: scope.actorSubjectId,
    credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify({ apiKey: serialized })),
  });
}

test("replacement during sign-in rejects stale persistence and invalidates its replay receipt", async () => {
  const scope = await fixture();
  await connect(scope);
  const start = await begin(scope),
    mock = provider();
  const deferred = (async (input, init) => {
    if (String(input) === CLAUDE_OAUTH_TOKEN_URL) await replace(scope);
    return mock.fetchImpl(input, init);
  }) as typeof fetch;
  await expect(
    completeClaudeSubscriptionOAuth(deps, scope, start, async () => {}, deferred),
  ).rejects.toThrow("connection changed");
  expect(
    (await loadClaudeSubscriptionUsageCredential(client.db, settings, usageScope(scope)))!.token,
  ).toBe("sk-ant-oat01-replacement-fixture");
  const secondScope = await fixture();
  const second = await connect(secondScope);
  // A successful receipt must not announce success after a later connection rotation.
  await replace(secondScope);
  await expect(
    completeClaudeSubscriptionOAuth(
      deps,
      secondScope,
      second.attempt,
      async () => {},
      second.mock.fetchImpl,
    ),
  ).rejects.toThrow("connection changed");
  expect(second.mock.calls).toHaveLength(2);
});

test("renewal and invalid-grant replies cannot overwrite or return a replaced generation", async () => {
  for (const invalid of [false, true]) {
    const scope = await fixture();
    await connect(scope);
    const original = await expire(scope);
    const fetchImpl = (async () => {
      await replace(scope);
      return invalid
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : Response.json({
            access_token: "sk-ant-oat01-renewed-old-generation",
            refresh_token: "renewed",
            expires_in: 3600,
            scope: "user:inference user:profile",
          });
    }) as typeof fetch;
    await expect(
      resolveClaudeSubscriptionCredential(client.db, settings, usageScope(scope), { fetchImpl }),
    ).rejects.toThrow("connection changed");
    const actual = (await loadClaudeSubscriptionUsageCredential(
      client.db,
      settings,
      usageScope(scope),
    ))!;
    expect(actual.connectionId).not.toBe(original.connectionId);
    expect(actual.token).toBe("sk-ant-oat01-replacement-fixture");
    expect(actual.usage.refreshStatus).toBe("not_checked");
  }
});

test("catalog loading remains offline with expired OAuth in both scopes and preserves exact bindings", async () => {
  const scope = await fixture(true);
  await connect(scope);
  await expire(scope);
  const [row] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${scope.accountId}, 'Shared Claude catalog') returning id`;
  const workspaceScope = { ...scope, workspaceId: row!.id };
  await connect(workspaceScope);
  await expire(workspaceScope);
  const before = await loadClaudeSubscriptionUsageCredential(
    client.db,
    settings,
    usageScope(scope),
  );
  expect(
    await loadOrganizationModelProviderApiKey(client.db, settings, {
      accountId: scope.accountId,
      workspaceId: row!.id,
      providerKind: "claude_subscription",
    }),
  ).toContain("fixture-refresh-v1");
  expect(
    await loadWorkspaceProviderApiKey(client.db, settings, row!.id, "claude_subscription"),
  ).toContain("fixture-refresh-v1");
  await createOrganizationModelProviderCustomModel(client.db, {
    organizationId: scope.accountId,
    actorSubjectId: scope.actorSubjectId,
    providerKind: "claude_subscription",
    operationId: randomUUID(),
    upstreamModelId: "claude-opus-5-5",
  });
  const catalogs = await settingsWithOrganizationProviderCredentials(
    client.db,
    scope.accountId,
    row!.id,
    settings,
    "gpt-5.6-sol",
  );
  const catalogProvider = parseModelProvidersJson(catalogs.modelProvidersJson).find(
    (candidate) => candidate.id === "organization-claude-subscription",
  )!;
  expect(catalogProvider.anthropic!.credentialBinding).toEqual({
    connectionId: before!.connectionId,
    credentialVersion: before!.credentialVersion,
  });
  expect(JSON.stringify(catalogProvider.anthropic)).not.toContain("refreshToken");
  expect(
    (await loadClaudeSubscriptionUsageCredential(client.db, settings, usageScope(scope)))!
      .credentialEncrypted,
  ).toBe(before!.credentialEncrypted);
});

test("missing profile scope, malformed and unbounded token exchange responses cannot connect", async () => {
  for (const response of [
    () =>
      Response.json({
        access_token: "sk-ant-oat01-fixture",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: "user:inference",
      }),
    () =>
      Response.json({
        access_token: "sk-ant-oat01-fixture",
        expires_in: 3600,
        scope: "user:inference user:profile",
      }),
    () => new Response("x".repeat(65537)),
    () =>
      new Response("{broken", {
        headers: { "content-type": "application/json" },
      }),
  ]) {
    const scope = await fixture(),
      start = await begin(scope);
    await expect(
      completeClaudeSubscriptionOAuth(deps, scope, start, async () => {}, (async () =>
        response()) as typeof fetch),
    ).rejects.toThrow("could not be completed");
    expect(
      await loadClaudeSubscriptionUsageCredential(client.db, settings, usageScope(scope)),
    ).toBeNull();
  }
});

async function browserRouteFixture(
  organization = false,
  enabled = true,
  duringExchange?: (scope: ClaudeOAuthScope) => Promise<void>,
) {
  const scope = await fixture(true),
    userId = scope.actorSubjectId.slice(5),
    sessionId = "session:" + randomUUID();
  const [workspace] = await shared.admin<
    { id: string }[]
  >`select id from workspaces where account_id = ${scope.accountId} limit 1`;
  await shared.admin`insert into auth_users (id, name, email, email_verified) values (${userId}, 'Claude owner', ${userId + "@example.com"}, true)`;
  await shared.admin`insert into auth_identities (id, user_id, provider_id, account_id) values (${randomUUID()}, ${userId}, 'credential', ${userId})`;
  await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions) values (${scope.accountId}, ${workspace!.id}, ${scope.actorSubjectId}, 'member', ${shared.admin.json(["workspace:read", "connections:write"])})`;
  if (!organization)
    await shared.admin`update organization_memberships set role = 'member' where account_id = ${scope.accountId}`;
  await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    name: "Claude owner",
    email: userId + "@example.com",
    emailVerified: true,
  });
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`insert into auth_sessions (id, user_id, token, expires_at, identity_id, identity_revision, auth_revision) values (${sessionId}, ${userId}, ${randomUUID()}, now() + interval '1 hour', ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision})`;
  const routeSettings = testSettings({
    ...settings,
    productAccessMode: "managed",
    publicBaseUrl: "https://opengeni.test",
    claudeSubscriptionEnabled: enabled,
  });
  const routeDeps = {
    db: client.db,
    settings: routeSettings,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => ({
          headers: new Headers(),
          response:
            headers.get("cookie") === "fixture=owner"
              ? {
                  user: {
                    id: userId,
                    name: "Claude owner",
                    email: userId + "@example.com",
                  },
                  session: {
                    id: sessionId,
                    userId,
                    expiresAt: new Date(Date.now() + 3600_000),
                  },
                }
              : null,
        }),
      },
    },
  } as unknown as ApiRouteDeps;
  const app = new Hono();
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  });
  const mock = provider();
  registerClaudeSubscriptionOAuthRoutes(app, routeDeps, (async (input, init) => {
    if (String(input) === CLAUDE_OAUTH_TOKEN_URL)
      await duringExchange?.({
        ...scope,
        workspaceId: organization ? null : workspace!.id,
      });
    return mock.fetchImpl(input, init);
  }) as typeof fetch);
  return {
    app,
    mock,
    scope: { ...scope, workspaceId: organization ? null : workspace!.id },
    headers: {
      cookie: "fixture=owner",
      "content-type": "application/json",
      origin: "https://opengeni.test",
      "sec-fetch-site": "same-origin",
    },
    path: `/v1/${organization ? "organizations" : "workspaces"}/${organization ? scope.accountId : workspace!.id}/model-providers/claude_subscription/oauth`,
  };
}

for (const organization of [false, true]) {
  test(`${organization ? "organization" : "workspace"} actual browser routes require JSON, same-origin human, flag and complete full sign-in`, async () => {
    const f = await browserRouteFixture(organization);
    for (const changed of [
      { "content-type": "text/plain" },
      { origin: "https://evil.test" },
      { "sec-fetch-site": "cross-site" },
      { cookie: "" },
    ]) {
      const rejected = await f.app.request(f.path + "/start", {
        method: "POST",
        headers: { ...f.headers, ...changed },
        body: "{}",
      });
      expect([401, 403]).toContain(rejected.status);
    }
    const startResponse = await f.app.request(f.path + "/start", {
      method: "POST",
      headers: f.headers,
      body: "{}",
    });
    expect(startResponse.status).toBe(200);
    const start = await startResponse.json();
    const code = "fixture-code#" + new URL(start.authorizationUrl).searchParams.get("state");
    const complete = await f.app.request(f.path + "/complete", {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({ attemptId: start.attemptId, code }),
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({
      connected: true,
      credentialVersion: 1,
    });
    expect(f.mock.calls).toHaveLength(2);
    const disabled = await browserRouteFixture(organization, false);
    expect(
      (
        await disabled.app.request(disabled.path + "/start", {
          method: "POST",
          headers: disabled.headers,
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect(disabled.mock.calls).toHaveLength(0);
  });
}

test("workspace browser permissions are freshly rechecked after spending a code", async () => {
  const f = await browserRouteFixture(false, true, async (scope) => {
    await shared.admin`update workspace_memberships set permissions = ${shared.admin.json(["workspace:read"])} where workspace_id = ${scope.workspaceId} and subject_id = ${scope.actorSubjectId}`;
  });
  const response = await f.app.request(f.path + "/start", {
    method: "POST",
    headers: f.headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  const start = await response.json();
  const complete = await f.app.request(f.path + "/complete", {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({
      attemptId: start.attemptId,
      code: "fixture-code#" + new URL(start.authorizationUrl).searchParams.get("state"),
    }),
  });
  expect(complete.status).toBe(403);
  expect(
    await loadClaudeSubscriptionUsageCredential(client.db, settings, usageScope(f.scope)),
  ).toBeNull();
  expect(f.mock.calls).toHaveLength(1);
});
