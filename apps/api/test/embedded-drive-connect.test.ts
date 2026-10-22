import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  decryptEnvironmentValue,
  deleteWorkspace,
  ensureExternalIdentity,
  getConnectionMetadata,
  loadIntegrationOAuthPendingState,
  type DbClient,
} from "@opengeni/db";
import { readSignedState } from "@opengeni/github";
import * as network from "@opengeni/network";
import { testSettings } from "@opengeni/testing/settings";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { createApp } from "../src/app";
import {
  OFFICIAL_DRIVE_MCP_SCOPES,
  OFFICIAL_DRIVE_MCP_URL,
} from "../src/integrations/oauth-profiles";

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
      : await acquireSharedTestDatabase("embedded-drive-connect");
  if (!acquired) throw new Error("PostgreSQL fixture required");
  fixture = acquired;
  client = createDb(fixture.appUrl);
}, 180_000);
afterAll(async () => {
  for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  await client?.close();
  await fixture?.release();
});

test("Drive callback requires an authenticated read and binds one exact personal MCP connection", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Drive callback",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "drive-callback-user",
  });
  const key = randomBytes(24).toString("hex");
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["workspace:read", "connections:read", "connections:write"],
  });
  const secret = "drive-callback-synthetic-state";
  const encryptionKey = randomBytes(32).toString("base64");
  const returnUrl = "https://host.example.test/settings#Drive";
  const settings = testSettings({
    productAccessMode: "managed",
    integrationsEnabled: true,
    googleConnectorSetupEnabled: true,
    googleDriveMcpEnabled: true,
    publicBaseUrl: "https://runtime.example.test",
    environmentsEncryptionKey: encryptionKey,
    integrationsStateSecret: secret,
    integrationsOauthClientsJson: JSON.stringify({
      "https://accounts.google.com": {
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        tokenEndpointAuthMethod: "client_secret_post",
      },
    }),
  });
  const configuredApp = (overrides: Partial<typeof settings> = {}) =>
    createApp({
      db: client.db,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
      settings: { ...settings, ...overrides },
    });
  const app = configuredApp();
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
  const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect`;
  let exchanges = 0;
  let toolsLists = 0;
  let authenticatedReads = 0;
  let readRejected = true;
  let reportedScopes = OFFICIAL_DRIVE_MCP_SCOPES.join(" ");
  let hasRefreshToken = true;
  // Exercise the real HTTP routes, PKCE state, MCP handshake, claims and database
  // writes. Only external provider transport is synthetic, with no live fallback.
  const transport = spyOn(network, "pinnedFetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://accounts.google.com/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      exchanges++;
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe("fixture-client");
      expect(body.get("client_secret")).toBe("fixture-secret");
      expect(body.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
      expect(body.get("redirect_uri")).toBe(
        "https://runtime.example.test/v1/integrations/oauth/callback",
      );
      expect(body.has("resource")).toBe(false);
      return Response.json({
        access_token: "synthetic-drive-access",
        ...(hasRefreshToken ? { refresh_token: "synthetic-drive-refresh" } : {}),
        token_type: "Bearer",
        expires_in: 3600,
        scope: reportedScopes,
      });
    }
    if (url === OFFICIAL_DRIVE_MCP_URL) {
      if (init?.method === "GET" || init?.method === "DELETE")
        return new Response(null, { status: 405 });
      const request = JSON.parse(String(init?.body));
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: request.id, result });
      if (request.method === "server/discover")
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        });
      if (request.method === "initialize")
        return reply({
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-drive", version: "1" },
        });
      if (request.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (request.method === "tools/list") {
        toolsLists++;
        // Deliberately public: this succeeds even while authenticated access fails.
        return reply({
          tools: [
            {
              name: "list_recent_files",
              description: "List recent files",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      }
      if (request.method === "tools/call") {
        authenticatedReads++;
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer synthetic-drive-access",
        );
        expect(request.params).toEqual({
          name: "list_recent_files",
          arguments: { pageSize: 1, excludeContentSnippets: true },
        });
        return reply(
          readRejected
            ? {
                isError: true,
                content: [{ type: "text", text: "Drive data access is not authorized" }],
              }
            : {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      files: [{ id: "private-file-id", name: "private-file-name" }],
                    }),
                  },
                ],
              },
        );
      }
      throw new Error(`Unexpected synthetic Drive MCP method: ${request.method}`);
    }
    throw new Error(`Unexpected synthetic Drive OAuth destination: ${url}`);
  });
  const callback = (state: string) =>
    app.request(
      `/v1/integrations/oauth/callback?${new URLSearchParams({ state, code: "synthetic-code" })}`,
    );
  const read = async (id: string) =>
    (await app.request(`${base}/attempts/${id}`, { headers })).json();
  const accounts = async () => (await app.request(`${base}/accounts`, { headers })).json();
  const begin = async (reconnectAccountId?: string) => {
    const created = await app.request(`${base}/attempts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "google-drive",
        ownership: "personal",
        returnUrl,
        ...(reconnectAccountId ? { reconnectAccountId } : {}),
        idempotencyKey: randomUUID(),
      }),
    });
    expect(created.status).toBe(200);
    const attempt = await created.json();
    expect(attempt).toMatchObject({
      providerId: "google-drive",
      ownership: "personal",
      nextAction: { type: "credentials", fields: [] },
    });
    const advanced = await app.request(`${base}/attempts/${attempt.id}/advance`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: attempt.revision,
        idempotencyKey: randomUUID(),
        action: { type: "credentials", values: {} },
      }),
    });
    expect(advanced.status).toBe(200);
    const ready = await advanced.json();
    expect(ready.state).toBe("requires_user_action");
    const authorize = new URL(ready.nextAction.url);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorize.searchParams.get("scope")?.split(" ").sort()).toEqual(
      [...OFFICIAL_DRIVE_MCP_SCOPES].sort(),
    );
    expect(authorize.searchParams.get("access_type")).toBe("offline");
    expect(authorize.searchParams.get("prompt")).toBe("consent");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    return { attempt: ready, state: authorize.searchParams.get("state")! };
  };
  try {
    const catalog = await (await app.request(`${base}/catalog`, { headers })).json();
    expect(
      catalog.find((provider: { id: string }) => provider.id === "google-drive"),
    ).toMatchObject({
      readiness: "available",
      ownership: ["personal"],
      setup: ["oauth"],
    });
    for (const overrides of [
      { googleDriveMcpEnabled: false },
      { googleConnectorSetupEnabled: false },
      { integrationsOauthClientsJson: "{}" },
    ]) {
      const unavailable = await (
        await configuredApp(overrides).request(`${base}/catalog`, { headers })
      ).json();
      expect(
        unavailable.find((provider: { id: string }) => provider.id === "google-drive"),
      ).toMatchObject({ readiness: "needs_configuration" });
    }
    const wrongOwnership = await app.request(`${base}/attempts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "google-drive",
        ownership: "workspace",
        returnUrl,
        idempotencyKey: randomUUID(),
      }),
    });
    expect(wrongOwnership.status).toBe(422);
    const shared = await app.request(
      `/v1/workspaces/${identity.personalWorkspaceId}/connections/oauth/start`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ mcpUrl: OFFICIAL_DRIVE_MCP_URL, ownership: "workspace", returnUrl }),
      },
    );
    expect(shared.status).toBe(422);
    expect(await shared.text()).toContain("personal-owned");

    const rejected = await begin();
    expect((await callback(rejected.state)).headers.get("location")).toBe(returnUrl);
    expect(toolsLists).toBe(1);
    expect(authenticatedReads).toBe(1);
    expect(await read(rejected.attempt.id)).toMatchObject({
      state: "failed",
      credentialsCommitted: false,
      error: { code: "tools_list_failed", retryable: true },
    });
    expect(await accounts()).toEqual([]);

    readRejected = false;
    for (const failure of ["missing_refresh", "readonly_only"] as const) {
      hasRefreshToken = failure !== "missing_refresh";
      reportedScopes =
        failure === "readonly_only"
          ? "https://www.googleapis.com/auth/drive.readonly"
          : OFFICIAL_DRIVE_MCP_SCOPES.join(" ");
      const failed = await begin();
      await callback(failed.state);
      expect(await read(failed.attempt.id)).toMatchObject({
        state: "failed",
        credentialsCommitted: false,
        error: {
          code: failure === "missing_refresh" ? "offline_access_unavailable" : "insufficient_scope",
        },
      });
      expect(await accounts()).toEqual([]);
    }
    hasRefreshToken = true;
    reportedScopes = OFFICIAL_DRIVE_MCP_SCOPES.join(" ");
    const success = await begin();
    const reference = readSignedState(success.state, secret) as Record<string, unknown>;
    const encrypted = await loadIntegrationOAuthPendingState(client.db, {
      id: reference.id as string,
      accountId: reference.accountId as string,
      workspaceId: reference.workspaceId as string,
    });
    if (!encrypted) throw new Error("pending Drive OAuth state missing");
    const payload = readSignedState(
      decryptEnvironmentValue(Buffer.from(encryptionKey, "base64"), encrypted),
      secret,
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      mcpUrl: OFFICIAL_DRIVE_MCP_URL,
      resource: OFFICIAL_DRIVE_MCP_URL,
      providerDomain: "drivemcp.googleapis.com",
      ownership: "personal",
      subjectId: identity.subjectId,
      integrationKey: "google-drive",
      resourceParameterSupported: false,
    });
    const beforeTampering = exchanges;
    for (const change of [
      { mcpUrl: `${OFFICIAL_DRIVE_MCP_URL}?other=1` },
      { ownership: "workspace" },
      { integrationKey: "gmail" },
      { integrationKey: "caller-invented-provider" },
    ]) {
      const encoded = Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url");
      await callback(
        `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`,
      );
      expect(exchanges).toBe(beforeTampering);
      expect(await read(success.attempt.id)).toMatchObject({ state: "requires_user_action" });
    }
    expect((await callback(success.state)).headers.get("location")).toBe(returnUrl);
    const completed = await read(success.attempt.id);
    expect(completed).toMatchObject({
      state: "complete",
      credentialsCommitted: true,
      account: { providerId: "google-drive", ownership: "personal" },
    });
    const saved = await getConnectionMetadata(
      client.db,
      identity.personalWorkspaceId,
      completed.account.id,
      identity.subjectId,
    );
    expect(saved).toMatchObject({
      subjectId: identity.subjectId,
      providerDomain: "drivemcp.googleapis.com",
      grantedScopes: [...OFFICIAL_DRIVE_MCP_SCOPES],
      metadata: {
        mcpUrl: OFFICIAL_DRIVE_MCP_URL,
        mcpToolsVerification: { status: "ok", toolCount: 1 },
      },
    });
    expect(JSON.stringify(saved)).not.toContain("private-file-id");
    expect(JSON.stringify(saved)).not.toContain("private-file-name");
    expect(await accounts()).toHaveLength(1);
    const completedExchanges = exchanges;
    await callback(success.state);
    expect(exchanges).toBe(completedExchanges);
    expect(await read(success.attempt.id)).toEqual(completed);
    expect(await accounts()).toHaveLength(1);

    readRejected = true;
    const reconnect = await begin(completed.account.id);
    await callback(reconnect.state);
    expect(await read(reconnect.attempt.id)).toMatchObject({
      state: "failed",
      credentialsCommitted: false,
    });
    expect(
      await getConnectionMetadata(
        client.db,
        identity.personalWorkspaceId,
        completed.account.id,
        identity.subjectId,
      ),
    ).toEqual(saved);
    expect(await accounts()).toHaveLength(1);
  } finally {
    transport.mockRestore();
  }
}, 30_000);
