import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDb, createOrganizationApiKey, type DbClient } from "@opengeni/db";
import { OpenGeniClient } from "@opengeni/sdk";
import {
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

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_APP_URL;
  const acquired = adminUrl && appUrl
    ? {admin: postgres(adminUrl), adminUrl, appUrl, release: async () => { await shared?.admin.end(); }}
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
  await createOrganizationApiKey(db.db, {
    accountId: account!.id,
    name: "Policy administrator",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: organizationApiKeyPermissionsForAccess("full"),
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  registerOrganizationIntegrationPolicyRoutes(app, {
    db: db.db,
    settings: testSettings({ databaseUrl: shared.appUrl, productAccessMode: "configured" }),
    bus: new MemoryEventBus(),
  } as unknown as ApiRouteDeps);
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
  const request = {
    mode: "restricted" as const,
    allowedIntegrationKeys: [],
    expectedRevision: 0,
    operationId: crypto.randomUUID(),
  };
  expect(await updateOrganizationIntegrationPolicy(client, account!.id, request)).toEqual({
    mode: "restricted",
    allowedIntegrationKeys: [],
    revision: 1,
  });
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
});
