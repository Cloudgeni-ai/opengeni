// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { requireAccessContext, type ApiRouteDeps } from "@opengeni/core";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerConnectionRoutes } from "../src/routes/connections";
import { registerWorkspaceModelProviderRoutes } from "../src/routes/workspace-model-providers";
import { registerClaudeSubscriptionAccountRoutes } from "../src/routes/claude-subscription-accounts";
import { registerClaudeSubscriptionOAuthRoutes } from "../src/routes/claude-subscription-oauth";
import { registerModelConnectionAccessRoutes } from "../src/routes/model-connection-access";

// The legacy Claude pool is deleted (design 5.3, C4). These tests explicitly
// disable the shared-core cutover to verify authenticated maintenance refusals
// without reviving legacy stores. Enabled routes are covered by claude-core-routes.

const secret = "claude-usage-api-test-delegation";
const key = Buffer.alloc(32, 7);
let shared: SharedTestDatabase, client: DbClient;
let accountId: string, workspaceId: string, subjectId: string;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("claude-setup-usage-api");
  if (!acquired) throw new Error("Real PostgreSQL required for Claude API verification");
  shared = acquired;
  client = createDb(shared.appUrl);
  subjectId = `user:${crypto.randomUUID()}`;
  const result = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Claude API test",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Claude API test",
    subjectId,
  });
  ({ accountId, workspaceId } = result.workspaceGrants[0]!);
  await shared.admin`
    update subscription_provider_cutovers set enabled = false
    where account_id = ${accountId}::uuid and provider = 'claude'`;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

function api(enabled = true) {
  const settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: secret,
    claudeSubscriptionEnabled: enabled,
    environmentsEncryptionKey: key.toString("base64"),
    publicBaseUrl: "https://opengeni.test",
  });
  const app = new Hono();
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  });
  const deps = { db: client.db, settings } as ApiRouteDeps;
  registerConnectionRoutes(app, deps);
  registerWorkspaceModelProviderRoutes(app, deps);
  registerClaudeSubscriptionAccountRoutes(app, deps);
  registerClaudeSubscriptionOAuthRoutes(app, deps);
  registerModelConnectionAccessRoutes(app, deps);
  return { app, settings };
}
async function headers(permissions: Permission[]) {
  return {
    "content-type": "application/json",
    origin: "https://opengeni.test",
    "sec-fetch-site": "same-origin",
    authorization: `Bearer ${await signDelegatedAccessToken(secret, {
      accountId,
      workspaceId,
      subjectId,
      permissions,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}`,
  };
}
test("0598 retirement rejects legacy Claude creation and replay before effect", async () => {
  const { app } = api();
  const auth = await headers(["workspace:read", "connections:write"]);
  const path = `/v1/workspaces/${workspaceId}/connections`;
  const body = JSON.stringify({
    subjectId: null,
    providerDomain: "api.anthropic.com",
    kind: "api_key",
    credential: { apiKey: "sk-ant-oat01-route-fixture" },
    metadata: { credentialRole: "claude_subscription" },
    operationId: crypto.randomUUID(),
  });
  const response = await app.request(path, { method: "POST", headers: auth, body });
  // Account pools replaced this operation-id API. Do not revive the retired
  // credential store merely to satisfy its obsolete 201/replay expectation.
  expect(response.status).toBe(410);
  expect(await response.text()).not.toContain("sk-ant-oat01");
  const replay = await app.request(path, { method: "POST", headers: auth, body });
  expect(replay.status).toBe(410);
  expect(await replay.text()).not.toContain("sk-ant-oat01");
  const [effects] = await shared.admin`
    select count(*)::int as count from connections
    where workspace_id = ${workspaceId} and metadata->>'credentialRole' = 'claude_subscription'`;
  expect(effects!.count).toBe(0);
});

async function claudeRowCounts() {
  const [row] = await shared.admin`
    select
      (select count(*)::int from claude_subscription_credentials) as legacy,
      (select count(*)::int from subscription_connections where provider = 'claude') as core`;
  return row;
}

test("Claude account, usage, setup-token and access routes fail closed during core maintenance", async () => {
  const { app } = api();
  const before = await claudeRowCounts();
  const admin = await headers(["workspace:read", "workspace:admin", "connections:write"]);
  const reader = await headers(["workspace:read"]);
  const connectionId = crypto.randomUUID();
  const workspace = `/v1/workspaces/${workspaceId}`;
  const requests: Array<[string, string, Record<string, string>, string?]> = [
    ["GET", `${workspace}/claude/accounts`, reader],
    ["POST", `${workspace}/claude/accounts/${connectionId}/activate`, admin],
    ["DELETE", `${workspace}/claude/accounts/${connectionId}`, admin],
    ["GET", `${workspace}/claude/accounts/${connectionId}/usage`, reader],
    ["POST", `${workspace}/claude/accounts/${connectionId}/usage/refresh`, admin],
    [
      "POST",
      `${workspace}/claude/accounts/setup-token`,
      admin,
      JSON.stringify({ token: "sk-ant-oat01-route-fixture", scope: "workspace" }),
    ],
    ["GET", `${workspace}/model-connections/claude_subscription/${connectionId}/access`, reader],
    [
      "PUT",
      `${workspace}/model-connections/claude_subscription/${connectionId}/access`,
      admin,
      JSON.stringify({ allowedModelIds: [] }),
    ],
  ];
  for (const [method, path, auth, body] of requests) {
    const response = await app.request(path, { method, headers: auth, body });
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 503 });
    const text = await response.text();
    expect(text).toContain("paused for maintenance");
    expect(text).not.toContain("sk-ant-oat01");
  }
  // OAuth sign-in still needs a browser human before anything else; it never
  // reaches a provider or a store.
  const start = await app.request(`${workspace}/model-providers/claude_subscription/oauth/start`, {
    method: "POST",
    headers: admin,
    body: "{}",
  });
  expect(start.status).toBe(401);
  expect(await claudeRowCounts()).toEqual(before);
});

test("core maintenance routes check workspace access before revealing the 503", async () => {
  const { app } = api();
  const before = await claudeRowCounts();
  const reader = await headers(["sessions:read"]);
  const writer = await headers(["connections:write"]);
  const connectionId = crypto.randomUUID();
  const workspace = `/v1/workspaces/${workspaceId}`;
  const setup = JSON.stringify({ token: "sk-ant-oat01-route-fixture", scope: "workspace" });
  const refused: Array<[string, string, Record<string, string>, string?]> = [
    // Neither token may read this workspace, even if it names write permission.
    ["POST", `${workspace}/claude/accounts/${connectionId}/activate`, reader],
    ["DELETE", `${workspace}/claude/accounts/${connectionId}`, writer],
    [
      "PATCH",
      `${workspace}/claude/accounts/${connectionId}`,
      writer,
      JSON.stringify({ label: "x" }),
    ],
    [
      "PATCH",
      `${workspace}/claude/accounts/${connectionId}/allocator`,
      reader,
      JSON.stringify({ enabled: true, expectedVersion: 1 }),
    ],
    ["PATCH", `${workspace}/claude/settings`, reader, JSON.stringify({ rotationEnabled: true })],
    ["POST", `${workspace}/claude/accounts/${connectionId}/usage/refresh`, reader],
    ["POST", `${workspace}/claude/accounts/setup-token`, writer, setup],
    [
      "PUT",
      `${workspace}/model-connections/claude_subscription/${connectionId}/access`,
      writer,
      JSON.stringify({ allowedModelIds: [] }),
    ],
  ];
  for (const [method, path, auth, body] of refused) {
    const response = await app.request(path, { method, headers: auth, body });
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
  }
  // Setup-token always required a same-origin browser request, even with an
  // Authorization header.
  const admin = await headers(["workspace:read", "workspace:admin", "connections:write"]);
  const { origin: _origin, ...crossSite } = admin;
  const response = await app.request(`${workspace}/claude/accounts/setup-token`, {
    method: "POST",
    headers: crossSite,
    body: setup,
  });
  expect(response.status).toBe(403);
  expect(await claudeRowCounts()).toEqual(before);
});

test("a local browser administrator reaches core maintenance on organization routes and OAuth sign-in", async () => {
  const origin = "http://opengeni.test";
  const settings = testSettings({
    productAccessMode: "local",
    publicBaseUrl: origin,
    delegationSecret: secret,
    claudeSubscriptionEnabled: true,
    environmentsEncryptionKey: key.toString("base64"),
  });
  const app = new Hono();
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  });
  const deps = { db: client.db, settings } as ApiRouteDeps;
  app.get("/identity", async (c) => c.json(await requireAccessContext(c, deps)));
  registerClaudeSubscriptionAccountRoutes(app, deps);
  registerClaudeSubscriptionOAuthRoutes(app, deps);
  registerModelConnectionAccessRoutes(app, deps);
  const browser = {
    host: "opengeni.test",
    "content-type": "application/json",
    origin,
    "sec-fetch-site": "same-origin",
  };
  const access = await (await app.request(`${origin}/identity`, { headers: browser })).json();
  await shared.admin`
    update subscription_provider_cutovers set enabled = false
    where account_id = ${access.defaultAccountId}::uuid and provider = 'claude'`;
  const organization = `${origin}/v1/organizations/${access.defaultAccountId}`;
  const workspace = `${origin}/v1/workspaces/${access.defaultWorkspaceId}`;
  const connectionId = crypto.randomUUID();
  const before = await claudeRowCounts();
  const requests: Array<[string, string, string?]> = [
    ["GET", `${organization}/claude/accounts`],
    ["POST", `${organization}/claude/accounts/${connectionId}/activate`],
    ["DELETE", `${organization}/claude/accounts/${connectionId}`],
    ["PATCH", `${organization}/claude/settings`, JSON.stringify({ rotationEnabled: true })],
    ["GET", `${organization}/claude/accounts/${connectionId}/usage`],
    ["POST", `${organization}/claude/accounts/${connectionId}/usage/refresh`],
    [
      "POST",
      `${organization}/claude/accounts/setup-token`,
      JSON.stringify({ token: "sk-ant-oat01-route-fixture", scope: "workspace" }),
    ],
    ["GET", `${organization}/model-connections/claude_subscription/${connectionId}/access`],
    [
      "PUT",
      `${organization}/model-connections/claude_subscription/${connectionId}/access`,
      JSON.stringify({ allowedModelIds: [] }),
    ],
    ...(["organization", "workspace"] as const).flatMap(
      (scope): Array<[string, string, string]> => {
        const base = `${scope === "organization" ? organization : workspace}/model-providers/claude_subscription/oauth`;
        return [
          ["POST", `${base}/start`, JSON.stringify({ scope: "workspace" })],
          [
            "POST",
            `${base}/complete`,
            JSON.stringify({ attemptId: crypto.randomUUID(), code: "fixture-code" }),
          ],
        ];
      },
    ),
  ];
  for (const [method, path, body] of requests) {
    const response = await app.request(path, { method, headers: browser, body });
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 503 });
    expect(await response.text()).not.toContain("sk-ant-oat01");
  }
  // The same routes still refuse a cross-site browser request first.
  const { origin: _origin, ...crossSite } = browser;
  for (const [method, path, body] of requests.filter(([verb]) => verb !== "GET")) {
    const response = await app.request(path, { method, headers: crossSite, body });
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
  }
  expect(await claudeRowCounts()).toEqual(before);
});

test("unauthenticated callers cannot reach the fail-closed routes, and gating leaves API-key providers independent", async () => {
  const path = `/v1/workspaces/${workspaceId}/claude/accounts/${crypto.randomUUID()}/usage`;
  const { app } = api();
  expect((await app.request(path)).status).toBe(401);
  expect((await app.request(`${path}/refresh`, { method: "POST" })).status).toBe(403);
  expect(
    (await api(false).app.request(path, { headers: await headers(["workspace:read"]) })).status,
  ).toBe(404);
  expect(
    (
      await api(false).app.request(
        `/v1/workspaces/${workspaceId}/model-providers/anthropic/custom-models`,
        { headers: await headers(["workspace:read"]) },
      )
    ).status,
  ).toBe(200);
});
