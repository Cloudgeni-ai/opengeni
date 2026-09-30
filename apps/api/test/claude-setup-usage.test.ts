// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  decryptEnvironmentValue,
  recordClaudeSubscriptionUsage,
  type DbClient,
} from "@opengeni/db";
import { parseClaudeUsageHeaders } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerConnectionRoutes } from "../src/routes/connections";
import { registerWorkspaceModelProviderRoutes } from "../src/routes/workspace-model-providers";

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
  });
  const app = new Hono();
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  });
  const deps = { db: client.db, settings } as ApiRouteDeps;
  registerConnectionRoutes(app, deps);
  registerWorkspaceModelProviderRoutes(app, deps);
  return { app, settings };
}
async function headers(permissions: Permission[]) {
  return {
    "content-type": "application/json",
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
test("public setup accepts only a token, preserves idempotency and never returns identity or credentials", async () => {
  const { app, settings } = api();
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
  expect(response.status).toBe(201);
  const value = await response.json();
  const replay = await app.request(path, { method: "POST", headers: auth, body });
  expect(replay.status).toBe(201);
  expect((await replay.json()).connection.id).toBe(value.connection.id);
  const [stored] =
    await shared.admin`select credential_encrypted from connections where id = ${value.connection.id}`;
  const credential = JSON.parse(decryptEnvironmentValue(key, stored!.credential_encrypted));
  const bundle = JSON.parse(credential.apiKey);
  expect(bundle.identity.accountUuid).toBe("");
  expect(bundle.identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(value)).not.toContain("sk-ant-oat");
  expect(JSON.stringify(value)).not.toContain(bundle.identity.deviceId);
  await recordClaudeSubscriptionUsage(
    client.db,
    settings,
    { accountId, workspaceId, scope: "workspace" },
    {
      token: bundle.token,
      observation: parseClaudeUsageHeaders(
        new Headers({
          "anthropic-ratelimit-unified-5h-utilization": "1",
          "anthropic-ratelimit-unified-7d-utilization": ".5",
        }),
      )!,
    },
  );
  const usage = await app.request(
    `/v1/workspaces/${workspaceId}/model-providers/claude_subscription/usage`,
    { headers: await headers(["workspace:read"]) },
  );
  expect(usage.status).toBe(200);
  expect(usage.headers.get("cache-control")).toBe("private, no-store");
  expect(
    (await usage.json()).windows.map((window: { usedPercent: number }) => window.usedPercent),
  ).toEqual([100, 50]);
  const replaced = await app.request(`${path}/${value.connection.id}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({
      credential: { apiKey: "sk-ant-oat01-route-replacement" },
      status: "active",
      expectedVersion: value.connection.version,
      operationId: crypto.randomUUID(),
    }),
  });
  expect(replaced.status).toBe(200);
  const cleared = await app.request(
    `/v1/workspaces/${workspaceId}/model-providers/claude_subscription/usage`,
    { headers: auth },
  );
  expect((await cleared.json()).windows).toEqual([]);
});
test("readers cannot refresh, unauthenticated callers cannot read, and gating leaves API-key providers independent", async () => {
  const path = `/v1/workspaces/${workspaceId}/model-providers/claude_subscription/usage`;
  const { app } = api();
  const response = await app.request(`${path}/refresh`, {
    method: "POST",
    headers: await headers(["workspace:read"]),
  });
  expect(response.status).toBe(403);
  expect((await app.request(path)).status).toBe(401);
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
