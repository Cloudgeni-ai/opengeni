import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  beginConnectAttempt,
  getConnectAttempt,
  listConnectionsMetadata,
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
import { createSignedState } from "@opengeni/github";
import { ATLASSIAN_NATIVE_RETIRED_REASON } from "@opengeni/contracts/atlassian-native-retirement";
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

test("native Atlassian is retired, including pending callbacks, without provider calls or grant writes", async () => {
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
    atlassianFetch: async () => {
      exchanges++;
      throw new Error("Retired native provider must never be called");
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
  expect((await begin()).status).toBe(410);
  expect((await begin("workspace")).status).toBe(410);
  const catalog = await (
    await app.request(base.replace("/attempts", "/catalog"), { headers })
  ).json();
  expect(catalog.some((provider: { id: string }) => provider.id === "atlassian")).toBe(false);
  expect(catalog.some((provider: { id: string }) => provider.id === "mcp-oauth")).toBe(true);

  // Simulate an OAuth attempt accepted by the preceding release. Callback
  // authority still follows the original native human, rather than the reader.
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
  };
  const attemptId = randomUUID();
  await beginConnectAttempt(client.db, scope, {
    idempotencyKey: randomUUID(),
    requestDigest: "a".repeat(64),
    returnUrl,
    attempt: {
      id: attemptId,
      workspaceId: scope.workspaceId,
      providerId: "atlassian",
      ownership: "personal",
      revision: 1,
      state: "requires_user_action",
      credentialsCommitted: false,
      integrationInstalled: false,
      completionRequirement: "connection",
      nextAction: { type: "authorize", url: "https://auth.atlassian.com/authorize" },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
  });
  const state = createSignedState("embedded-atlassian-fixture-state", {
    kind: "atlassian_oauth",
    ...scope,
    personalOwnerVerified: true,
    returnPath: `/workspaces/${scope.workspaceId}/capabilities`,
    connectAttemptId: attemptId,
  });
  const callback = () =>
    app.request(
      `/v1/integrations/atlassian/callback?${new URLSearchParams({ state, code: "fixture-code" })}`,
    );
  expect((await callback()).headers.get("location")).toBe(returnUrl);
  const result = (await getConnectAttempt(client.db, scope, attemptId)).attempt;
  expect(result).toMatchObject({
    state: "failed",
    credentialsCommitted: false,
    integrationInstalled: false,
    nextAction: { type: "none" },
    error: { code: ATLASSIAN_NATIVE_RETIRED_REASON, retryable: false },
  });
  expect((await callback()).headers.get("location")).toBe(returnUrl);
  expect((await getConnectAttempt(client.db, scope, attemptId)).attempt).toEqual(result);
  expect(await listConnectionsMetadata(client.db, grant.workspaceId, grant.subjectId)).toEqual([]);
  expect(exchanges).toBe(0);
});
