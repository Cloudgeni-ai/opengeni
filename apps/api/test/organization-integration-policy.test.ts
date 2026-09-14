import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  revokeOrganizationApiKey,
  type DbClient,
} from "@opengeni/db";
import { OrganizationIntegrationDeniedError } from "@opengeni/contracts";
import { OpenGeniClient } from "@opengeni/sdk";
import {
  getOrganizationIntegrationCatalog,
  getOrganizationIntegrationPolicy,
  updateOrganizationIntegrationPolicy,
} from "@opengeni/sdk/organization-integration-policy";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps } from "@opengeni/core";
import { registerOrganizationIntegrationPolicyRoutes } from "../src/routes/organization-integration-policy";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";
import { registerConnectRoutes } from "../src/routes/connect";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_APP_URL;
  const acquired =
    adminUrl && appUrl
      ? {
          admin: postgres(adminUrl),
          adminUrl,
          appUrl,
          release: async () => {
            await shared?.admin.end();
          },
        }
      : await acquireSharedTestDatabase("organization-integration-policy-api");
  if (!acquired) throw new Error("Organization integration policy routes require PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

test("organization server configuration is workspace-independent, fenced and cannot cross organizations", async () => {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Policy fixture') returning id`;
  const [other] =
    await shared.admin`insert into managed_accounts (name) values ('Other fixture') returning id`;
  const token = crypto.randomUUID();
  const apiKey = await createOrganizationApiKey(db.db, {
    accountId: account!.id,
    name: "Policy administrator",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: organizationApiKeyPermissionsForAccess("full"),
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof OrganizationIntegrationDeniedError)
      return c.json({ message: error.message }, 403);
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  const deps = {
    db: db.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "configured",
      integrationsEnabled: true,
    }),
    bus: new MemoryEventBus(),
  } as unknown as ApiRouteDeps;
  registerOrganizationIntegrationPolicyRoutes(app, deps);
  registerConnectRoutes(app, deps);
  const client = new OpenGeniClient({
    baseUrl: "http://fixture",
    apiKey: token,
    fetch: (input, init) => app.request(input, init),
  });
  expect(await getOrganizationIntegrationPolicy(client, account!.id)).toEqual({
    mode: "unrestricted",
    allowedIntegrationKeys: [],
    revision: 0,
  });
  const workspace = await createWorkspace(db.db, {
    accountId: account!.id,
    name: "Connect policy fixture",
  });
  const beginRequest = {
    providerId: "mcp-install",
    ownership: "workspace",
    idempotencyKey: crypto.randomUUID(),
    returnUrl: "https://host.example.test/return",
  };
  const begin = (body = beginRequest) =>
    app.request(`/v1/workspaces/${workspace.id}/connect/attempts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const initialBegin = await begin();
  const initialAttempt = await initialBegin.json();
  expect({ status: initialBegin.status, error: initialBegin.ok ? null : initialAttempt }).toEqual({
    status: 200,
    error: null,
  });
  const request = {
    mode: "restricted" as const,
    allowedIntegrationKeys: [],
    expectedRevision: 0,
    operationId: crypto.randomUUID(),
  };
  const catalog = await getOrganizationIntegrationCatalog(client, account!.id);
  expect(catalog.integrations).toContainEqual({ key: "gmail", label: "Gmail", kind: "curated" });
  expect(catalog.integrations.some((item) => item.key === "microsoft-outlook-mail")).toBe(true);
  expect(catalog.integrations.filter((item) => item.kind === "custom")).toHaveLength(3);
  await expect(getOrganizationIntegrationCatalog(client, other!.id)).rejects.toMatchObject({
    status: 403,
  });
  expect(await updateOrganizationIntegrationPolicy(client, account!.id, request)).toEqual({
    mode: "restricted",
    allowedIntegrationKeys: [],
    revision: 1,
  });
  const replayBegin = await begin();
  expect(replayBegin.status).toBe(200);
  expect(await replayBegin.json()).toEqual(initialAttempt);
  expect((await begin({ ...beginRequest, idempotencyKey: crypto.randomUUID() })).status).toBe(403);
  const cancelRequest = {
    idempotencyKey: crypto.randomUUID(),
    expectedRevision: initialAttempt.revision,
  };
  const cancel = () =>
    app.request(`/v1/workspaces/${workspace.id}/connect/attempts/${initialAttempt.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(cancelRequest),
    });
  const cancelled = await cancel();
  expect(cancelled.status).toBe(200);
  const cancelledAttempt = await cancelled.json();
  expect(cancelledAttempt.state).toBe("cancelled");
  const cancelReplay = await cancel();
  expect(cancelReplay.status).toBe(200);
  expect(await cancelReplay.json()).toEqual(cancelledAttempt);
  expect(await updateOrganizationIntegrationPolicy(client, account!.id, request)).toEqual({
    mode: "restricted",
    allowedIntegrationKeys: [],
    revision: 1,
  });
  await expect(
    updateOrganizationIntegrationPolicy(client, account!.id, {
      ...request,
      operationId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(getOrganizationIntegrationPolicy(client, other!.id)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    updateOrganizationIntegrationPolicy(client, other!.id, request),
  ).rejects.toMatchObject({ status: 403 });
  await revokeOrganizationApiKey(db.db, account!.id, apiKey.id);
  expect((await begin()).status).toBe(401);
  expect((await cancel()).status).toBe(401);
});
