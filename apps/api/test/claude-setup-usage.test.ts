// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
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

// The legacy Claude pool is deleted (design 5.3, C4). Until the shared
// subscription core serves Claude accounts, usage, setup-token connect and
// access policies (C2a, C2b), each route authenticates and then fails closed
// with a typed 503, writing nothing.

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

test("legacy Claude account, usage, setup-token and access routes fail closed after authentication", async () => {
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
    ["POST", `${workspace}/claude/accounts/${connectionId}/usage/refresh`, reader],
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
    expect(text).toContain("served only by the shared subscription core");
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
