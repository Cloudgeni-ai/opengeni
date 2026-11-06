import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  listConnectionsMetadata,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

let fixture: SharedTestDatabase;
let client: DbClient;
const workspaces: string[] = [];
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("embedded-atlassian-connect");
  if (!acquired) throw new Error("PostgreSQL fixture required");
  fixture = acquired;
  client = createDb(fixture.appUrl);
}, 180_000);
afterAll(async () => {
  for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  await client?.close();
  await fixture?.release();
});

test("native Atlassian connect answers 410 and its OAuth callback is gone", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Embedded Atlassian",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "product-user",
  });
  // The personal workspace is a membership-owned lifecycle anchor, not an
  // independently deletable fixture. The shared database lease owns its cleanup.
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
      publicBaseUrl: "https://opengeni.example.test",
      environmentsEncryptionKey: randomBytes(32).toString("base64"),
      integrationsStateSecret: "embedded-atlassian-fixture-state",
    }),
  } as never);
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
    ),
  };
  const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect/attempts`;
  const returnUrl = "https://HOST.example:443/settings?opaque=%2f#Atlassian";
  const begin = async (ownership = "personal") =>
    app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "atlassian",
        ownership,
        returnUrl,
        idempotencyKey: randomUUID(),
      }),
    });
  expect((await begin()).status).toBe(410);
  expect((await begin("workspace")).status).toBe(410);
  const catalog = await (
    await app.request(base.replace("/attempts", "/catalog"), { headers })
  ).json();
  expect(catalog.some((provider: { id: string }) => provider.id === "atlassian")).toBe(false);
  expect(catalog.some((provider: { id: string }) => provider.id === "mcp-oauth")).toBe(true);

  const callback = await app.request(
    `/v1/integrations/atlassian/callback?${new URLSearchParams({ state: "old", code: "fixture-code" })}`,
  );
  expect(callback.status).toBe(404);
  expect(await listConnectionsMetadata(client.db, grant.workspaceId, grant.subjectId)).toEqual([]);
});
