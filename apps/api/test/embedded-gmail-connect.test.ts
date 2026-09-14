import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
  createConnection,
  createOrganizationApiKey,
  deleteWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";
import { OFFICIAL_GMAIL_MCP_URL } from "../src/integrations/oauth-profiles";

let fixture: SharedTestDatabase;
let client: DbClient;
const workspaces: string[] = [];
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("embedded-gmail-connect");
  if (!acquired) throw new Error("PostgreSQL fixture required");
  fixture = acquired;
  client = createDb(fixture.appUrl);
}, 180_000);
afterAll(async () => {
  for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  await client?.close();
  await fixture?.release();
});

test("Gmail is discoverable for named users without exposing mailbox credentials or a server URL", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Embedded mail",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "mail-user",
  });
  const key = randomBytes(24).toString("hex");
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["workspace:read", "connections:read", "connections:write"],
  });
  const app = createApp({
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    settings: testSettings({
      productAccessMode: "managed",
      integrationsEnabled: true,
      publicBaseUrl: "https://runtime.example.test",
      environmentsEncryptionKey: randomBytes(32).toString("base64"),
      integrationsStateSecret: "embedded-mail-fixture-state",
    }),
  });
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
    ),
  };
  const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect`;
  const catalog = await app.request(`${base}/catalog`, { headers });
  expect(catalog.status).toBe(200);
  expect((await catalog.json()).find((item: { id: string }) => item.id === "gmail")).toMatchObject({
    label: "Gmail",
    ownership: ["personal"],
    setup: ["oauth"],
  });
  const serviceCatalog = await app.request(`/v1/workspaces/${grant.workspaceId}/connect/catalog`, {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(serviceCatalog.status).toBe(200);
  expect(
    (await serviceCatalog.json()).find((item: { id: string }) => item.id === "gmail"),
  ).toMatchObject({
    readiness: "unsupported",
    ownership: [],
  });
  const begin = (ownership: string, idempotencyKey = randomUUID()) =>
    app.request(`${base}/attempts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "gmail",
        ownership,
        idempotencyKey,
        returnUrl: "https://product.example.test/chat",
      }),
    });
  expect((await begin("workspace")).status).toBe(422);
  const operation = randomUUID();
  const started = await begin("personal", operation);
  expect(started.status).toBe(200);
  const attempt = await started.json();
  expect(attempt).toMatchObject({
    providerId: "gmail",
    ownership: "personal",
    credentialsCommitted: false,
    integrationInstalled: false,
    nextAction: { type: "credentials", fields: [] },
  });
  const repeated = await begin("personal", operation);
  expect(repeated.status).toBe(200);
  expect((await repeated.json()).id).toBe(attempt.id);
  const accounts = await app.request(`${base}/accounts`, { headers });
  expect(accounts.status).toBe(200);
  expect(await accounts.json()).toEqual([]);
  const connection = async (mcpUrl: string) =>
    createConnection(client.db, {
      accountId: grant.accountId,
      workspaceId: identity.personalWorkspaceId,
      subjectId: identity.subjectId,
      providerDomain: new URL(mcpUrl).hostname,
      kind: "oauth2",
      credentialEncrypted: "synthetic-unreadable-credential",
      metadata: { oauthDiscovery: { issuer: "https://accounts.google.com" }, mcpUrl },
      createdBySubjectId: identity.subjectId,
    });
  const gmail = await connection(OFFICIAL_GMAIL_MCP_URL);
  const other = await connection("https://other.example.test/mcp");
  const reconnect = (reconnectAccountId: string) =>
    app.request(`${base}/attempts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "gmail",
        ownership: "personal",
        reconnectAccountId,
        idempotencyKey: randomUUID(),
        returnUrl: "https://product.example.test/chat",
      }),
    });
  expect((await reconnect(other.id)).status).toBe(404);
  const reconnected = await reconnect(gmail.id);
  expect(reconnected.status).toBe(200);
  expect(await reconnected.json()).toMatchObject({
    account: { id: gmail.id, providerId: "gmail", ownership: "personal" },
  });
  const listed = await (await app.request(`${base}/accounts`, { headers })).json();
  expect(listed.find((account: { id: string }) => account.id === gmail.id)).toMatchObject({
    providerId: "gmail",
    ownership: "personal",
  });
  expect(JSON.stringify(listed)).not.toContain("synthetic-unreadable-credential");
});
