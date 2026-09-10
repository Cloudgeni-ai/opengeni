import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
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
import { ATLASSIAN_REQUIRED_SCOPES } from "@opengeni/contracts/atlassian";
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

test("embedded Atlassian preserves personal ownership, exact returns, replay and denial", async () => {
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
  let exchanges = 0;
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
      atlassianClientId: "fixture-client",
      atlassianClientSecret: "fixture-secret",
    }),
    atlassianFetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        exchanges++;
        return Response.json({
          access_token: "fixture-token",
          refresh_token: "fixture-refresh",
          expires_in: 3600,
          scope: ATLASSIAN_REQUIRED_SCOPES.join(" "),
        });
      }
      if (url.endsWith("/me"))
        return Response.json({ account_id: "provider-user", name: "Product User" });
      if (url.endsWith("/accessible-resources"))
        return Response.json([
          {
            id: "cloud-1",
            name: "Product",
            url: "https://fixture.atlassian.net",
            scopes: ["read:jira-work"],
          },
        ]);
      throw new Error("Unexpected provider request");
    },
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
  expect((await begin("workspace")).status).toBe(422);
  const started = await begin();
  expect(started.status).toBe(200);
  const attempt = await started.json();
  const state = new URL(attempt.nextAction.url).searchParams.get("state")!;
  const callback = (callbackState: string, denied = false) =>
    app.request(
      `/v1/integrations/atlassian/callback?${new URLSearchParams({ state: callbackState, ...(denied ? { error: "access_denied" } : { code: "fixture-code" }) })}`,
    );
  expect((await callback(state)).headers.get("location")).toBe(returnUrl);
  const result = await (await app.request(`${base}/${attempt.id}`, { headers })).json();
  expect(result).toMatchObject({
    state: "complete",
    completionRequirement: "connection",
    credentialsCommitted: true,
    account: { providerId: "atlassian", ownership: "personal" },
  });
  expect((await callback(state)).headers.get("location")).toBe(returnUrl);
  expect(exchanges).toBe(1);
  const denied = await (await begin()).json();
  const deniedState = new URL(denied.nextAction.url).searchParams.get("state")!;
  expect((await callback(deniedState, true)).headers.get("location")).toBe(returnUrl);
  expect(await (await app.request(`${base}/${denied.id}`, { headers })).json()).toMatchObject({
    state: "cancelled",
    credentialsCommitted: false,
  });
  expect(exchanges).toBe(1);
});
