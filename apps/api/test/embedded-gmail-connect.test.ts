import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
  createConnection,
  createOrganizationApiKey,
  deleteWorkspace,
  ensureExternalIdentity,
  revokeOrganizationApiKey,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";
import { OFFICIAL_GMAIL_MCP_URL } from "../src/integrations/oauth-profiles";
import * as network from "@opengeni/network";
import { readSignedState } from "@opengeni/github";
import postgres from "postgres";

let fixture: SharedTestDatabase;
let client: DbClient;
const workspaces: string[] = [];
beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = adminUrl ? postgres(adminUrl, { max: 4 }) : null;
  const acquired =
    admin && adminUrl && appUrl
      ? {
          admin,
          adminUrl,
          appUrl,
          release: async () => {
            await admin.end();
          },
        }
      : await acquireSharedTestDatabase("embedded-gmail-connect");
  if (!acquired) throw new Error("PostgreSQL fixture required");
  fixture = acquired;
  client = createDb(fixture.appUrl);
}, 180_000);
afterAll(async () => {
  for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  await client?.close();
  await fixture?.release();
});

test("Gmail callback binds the exact attempt and preserves lifecycle authority", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Mail callback",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "callback-user",
  });
  const key = randomBytes(24).toString("hex");
  const apiKey = await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["workspace:read", "connections:read", "connections:write"],
  });
  const secret = "gmail-callback-synthetic-state";
  const returnUrl = "https://HOST.example:443/settings?opaque=%2f#Gmail";
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
      integrationsStateSecret: secret,
      integrationsOauthClientsJson: JSON.stringify({
        "https://accounts.google.com": {
          clientId: "fixture-client",
          tokenEndpointAuthMethod: "none",
        },
      }),
    }),
  });
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({
        mode: "external",
        identity: { externalId: identity.externalId },
      }),
    ),
  };
  const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect/attempts`;
  let exchanges = 0;
  // Exercise real routes, signed state, database claims and receipts. Only the
  // outbound transport is synthetic; unexpected destinations fail closed.
  const transport = spyOn(network, "pinnedFetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === OFFICIAL_GMAIL_MCP_URL) {
      if (!new Headers(init?.headers).has("authorization"))
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer resource_metadata="https://gmailmcp.googleapis.com/prm"',
          },
        });
      // Verification is explicitly non-fatal; no tool/account call is made.
      return new Response(null, { status: 503 });
    }
    if (url === "https://gmailmcp.googleapis.com/prm")
      return Response.json({
        resource: OFFICIAL_GMAIL_MCP_URL,
        authorization_servers: ["https://accounts.google.com"],
      });
    if (url.startsWith("https://accounts.google.com/.well-known/"))
      return Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url === "https://oauth2.googleapis.com/token") {
      exchanges++;
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe("fixture-client");
      expect(body.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
      expect(body.has("resource")).toBe(false);
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected synthetic OAuth destination: ${url}`);
  });
  const callback = (state: string, code = true) =>
    app.request(
      `/v1/integrations/oauth/callback?${new URLSearchParams({ state, ...(code ? { code: "synthetic-code" } : {}) })}`,
    );
  const read = async (id: string) => (await app.request(`${base}/${id}`, { headers })).json();
  const begin = async (providerId = "gmail") => {
    const response = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId,
        ownership: "personal",
        returnUrl,
        idempotencyKey: randomUUID(),
      }),
    });
    expect(response.status).toBe(200);
    const attempt = await response.json();
    const advanced = await app.request(`${base}/${attempt.id}/advance`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: attempt.revision,
        idempotencyKey: randomUUID(),
        action: { type: "credentials", values: { mcpUrl: OFFICIAL_GMAIL_MCP_URL } },
      }),
    });
    expect(advanced.status).toBe(200);
    const ready = await advanced.json();
    expect(ready.state).toBe("requires_user_action");
    return { attempt: ready, state: new URL(ready.nextAction.url).searchParams.get("state")! };
  };
  try {
    const { attempt, state } = await begin();
    const payload = readSignedState(state, secret) as Record<string, unknown>;
    // Deliberately preserve the original nonce/time when modifying signed
    // fixtures. createSignedState always generates a fresh nonce and timestamp,
    // which would not exercise same-key digest mismatch or expired state.
    const alteredState = (change: Record<string, unknown>) => {
      const encoded = Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url");
      return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
    };
    const wrongProviderResponse = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "mcp-bearer",
        ownership: "personal",
        returnUrl,
        idempotencyKey: randomUUID(),
      }),
    });
    expect(wrongProviderResponse.status).toBe(200);
    const wrongProvider = await wrongProviderResponse.json();
    await callback(alteredState({ connectAttemptId: wrongProvider.id }));
    expect(await read(wrongProvider.id)).toEqual(wrongProvider);
    expect(exchanges).toBe(0);
    for (const change of [
      { mcpUrl: "https://other.example.test/mcp" },
      { mcpUrl: `${OFFICIAL_GMAIL_MCP_URL}?other=1` },
      { providerDomain: "other.example.test" },
      { ownership: "workspace" },
      { subjectId: "external_user:other" },
      { returnUrl: "https://other.example.test/return" },
      { personalOwnerVerified: false },
      { iat: Math.floor(Date.now() / 1000) - 3600 },
    ]) {
      await callback(alteredState(change));
      expect(exchanges).toBe(0);
      expect(await read(attempt.id)).toMatchObject({
        state: "requires_user_action",
        revision: attempt.revision,
      });
    }
    expect((await callback(state)).headers.get("location")).toBe(returnUrl);
    const completed = await read(attempt.id);
    expect(completed).toMatchObject({
      state: "complete",
      credentialsCommitted: true,
      account: { providerId: "gmail", ownership: "personal" },
    });
    expect(exchanges).toBe(1);
    expect((await callback(state)).headers.get("location")).toBe(returnUrl);
    expect(await read(attempt.id)).toEqual(completed);
    // Same operation key with altered signed bytes must not reuse its receipt;
    // a different nonce must not restart an already completed attempt either.
    await callback(alteredState({ clientId: "different" }));
    await callback(alteredState({ nonce: randomUUID() }));
    expect(exchanges).toBe(1);
    expect(await read(attempt.id)).toEqual(completed);

    const cancelled = await begin();
    const cancel = await app.request(`${base}/${cancelled.attempt.id}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: cancelled.attempt.revision,
        idempotencyKey: randomUUID(),
      }),
    });
    expect(cancel.status).toBe(200);
    await callback(cancelled.state);
    expect(await read(cancelled.attempt.id)).toMatchObject({
      state: "cancelled",
      credentialsCommitted: false,
    });
    expect(exchanges).toBe(1);

    const denied = await begin();
    expect((await callback(denied.state, false)).headers.get("location")).toBe(returnUrl);
    const failed = await read(denied.attempt.id);
    expect(failed).toMatchObject({
      state: "failed",
      credentialsCommitted: false,
      error: { code: "missing_code" },
    });
    await callback(denied.state);
    expect(await read(denied.attempt.id)).toEqual(failed);
    expect(exchanges).toBe(1);

    const revoked = await begin();
    await revokeOrganizationApiKey(client.db, grant.accountId, apiKey.id);
    await callback(revoked.state);
    await callback(state); // Receipt replay still requires live origin authority.
    expect(exchanges).toBe(1);
  } finally {
    transport.mockRestore();
  }
}, 30_000);

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
