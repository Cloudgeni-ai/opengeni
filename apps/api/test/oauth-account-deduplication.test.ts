import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  ensureExternalIdentity,
  getConnectionMetadata,
  listConnectionsMetadata,
  type DbClient,
} from "@opengeni/db";
import * as network from "@opengeni/network";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";
import { createApp } from "../src/app";
import {
  OFFICIAL_GMAIL_MCP_SCOPES,
  OFFICIAL_GMAIL_MCP_URL,
} from "../src/integrations/oauth-profiles";

let database: SharedTestDatabase;
let client: DbClient;
const workspaces: string[] = [];
beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl))
    throw new Error("Both PostgreSQL fixture URLs are required");
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
      : await acquireSharedTestDatabase("oauth-account-deduplication");
  if (!acquired) throw new Error("OAuth account deduplication requires PostgreSQL");
  database = acquired;
  client = createDb(database.appUrl);
}, 180_000);
afterAll(async () => {
  try {
    for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  } finally {
    await client?.close();
    await database?.release();
  }
}, 180_000);

async function fixture(kind: "gmail" | "opaque") {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "OAuth deduplication",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "oauth-user",
  });
  const key = randomBytes(24).toString("hex");
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["workspace:read", "connections:read", "connections:write"],
  });
  const issuer = kind === "gmail" ? "https://accounts.google.com" : "https://oauth.example.test";
  const tokenUrl = kind === "gmail" ? "https://oauth2.googleapis.com/token" : `${issuer}/token`;
  const endpoint = kind === "gmail" ? OFFICIAL_GMAIL_MCP_URL : "https://connector.example.test/mcp";
  const scopes = kind === "gmail" ? OFFICIAL_GMAIL_MCP_SCOPES : ["documents:read"];
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
      integrationsStateSecret: "oauth-account-deduplication-synthetic-state",
      integrationsOauthClientsJson: JSON.stringify({
        [issuer]: {
          clientId: "fixture-client",
          clientSecret: "fixture-secret",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      }),
    }),
  });
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
    ),
  };
  const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect/attempts`;
  let email = "mailbox@example.test";
  let exchanges = 0;
  const transport = spyOn(network, "pinnedFetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === tokenUrl)
      return Response.json({
        access_token: `synthetic-access-${++exchanges}`,
        refresh_token: `synthetic-refresh-${exchanges}`,
        token_type: "Bearer",
        scope: scopes.join(" "),
      });
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile")
      return Response.json({ emailAddress: email });
    if (url.startsWith(`${issuer}/.well-known/`))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenUrl,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        scopes_supported: scopes,
      });
    if (url.startsWith("https://connector.example.test/prm")) {
      const resource = new URL(url).searchParams.get("resource")!;
      return Response.json({ resource, authorization_servers: [issuer], scopes_supported: scopes });
    }
    if (url.startsWith("https://connector.example.test/")) {
      if (!new Headers(init?.headers).has("authorization"))
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="https://connector.example.test/prm?resource=${encodeURIComponent(url)}"`,
          },
        });
      const message = JSON.parse(String(init?.body ?? "{}"));
      if (message.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "opaque-fixture", version: "1" },
          },
        });
      if (message.method === "tools/list")
        return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
      return new Response(null, { status: 202 });
    }
    throw new Error(`Unexpected synthetic OAuth destination: ${url}`);
  });
  async function begin(
    options: {
      reconnectAccountId?: string;
      mcpUrl?: string;
      ownership?: "personal" | "workspace";
    } = {},
  ) {
    const begun = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: kind === "gmail" ? "gmail" : "mcp-oauth",
        ownership: options.ownership ?? "personal",
        ...(options.reconnectAccountId ? { reconnectAccountId: options.reconnectAccountId } : {}),
        returnUrl: "https://product.example.test/settings",
        idempotencyKey: randomUUID(),
      }),
    });
    expect(begun.status).toBe(200);
    const attempt = await begun.json();
    const advanced = await app.request(`${base}/${attempt.id}/advance`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: attempt.revision,
        idempotencyKey: randomUUID(),
        action: {
          type: "credentials",
          values: kind === "gmail" ? {} : { mcpUrl: options.mcpUrl ?? endpoint },
        },
      }),
    });
    expect(advanced.status).toBe(200);
    const ready = await advanced.json();
    expect(ready.state).toBe("requires_user_action");
    return { id: ready.id, state: new URL(ready.nextAction.url).searchParams.get("state")! };
  }
  const read = async (id: string) => (await app.request(`${base}/${id}`, { headers })).json();
  const callback = async (attempt: { id: string; state: string }) => {
    await app.request(
      `/v1/integrations/oauth/callback?${new URLSearchParams({ state: attempt.state, code: "fixture-code" })}`,
    );
    return read(attempt.id);
  };
  return {
    begin,
    callback,
    read,
    setEmail: (value: string) => {
      email = value;
    },
    connections: () =>
      listConnectionsMetadata(client.db, identity.personalWorkspaceId, identity.subjectId),
    connection: (id: string) =>
      getConnectionMetadata(client.db, identity.personalWorkspaceId, id, identity.subjectId),
    restore: () => transport.mockRestore(),
  };
}

describe("OAuth account deduplication across connector profiles", () => {
  test("concurrent verified-account Connect callbacks reuse one account without refreshing it", async () => {
    const provider = await fixture("gmail");
    try {
      const first = await provider.begin();
      const second = await provider.begin();
      const results = await Promise.all([provider.callback(first), provider.callback(second)]);
      expect(results.map((result) => result.state)).toEqual(["complete", "complete"]);
      expect(results[0].account.id).toBe(results[1].account.id);
      const rows = await provider.connections();
      expect(rows).toHaveLength(1);
      const before = await provider.connection(rows[0]!.id);
      const repeated = await provider.callback(await provider.begin());
      expect(repeated.state).toBe("complete");
      expect(repeated.account.id).toBe(rows[0]!.id);
      expect(await provider.connection(rows[0]!.id)).toEqual(before);
    } finally {
      provider.restore();
    }
  }, 60_000);

  test("different verified accounts remain separate and reconnect cannot switch identity", async () => {
    const provider = await fixture("gmail");
    try {
      const first = await provider.callback(await provider.begin());
      expect(first.state).toBe("complete");
      const before = await provider.connection(first.account.id);
      provider.setEmail("another@example.test");
      const second = await provider.callback(await provider.begin());
      expect(second.state).toBe("complete");
      expect(second.account.id).not.toBe(first.account.id);
      const mismatch = await provider.callback(
        await provider.begin({ reconnectAccountId: first.account.id }),
      );
      expect(mismatch).toMatchObject({ state: "failed", error: { code: "account_mismatch" } });
      expect(await provider.connection(first.account.id)).toEqual(before);
      expect(await provider.connections()).toHaveLength(2);
    } finally {
      provider.restore();
    }
  }, 60_000);

  test("an opaque OAuth provider cannot create duplicate account rows through concurrent Connect", async () => {
    const provider = await fixture("opaque");
    try {
      const first = await provider.begin();
      const second = await provider.begin();
      const results = await Promise.all([provider.callback(first), provider.callback(second)]);
      expect(results.map((result) => result.state).sort()).toEqual(["complete", "failed"]);
      const failure = results.find((result) => result.state === "failed");
      expect(failure.error.message.toLowerCase()).toContain("reconnect");
      expect(await provider.connections()).toHaveLength(1);
    } finally {
      provider.restore();
    }
  }, 60_000);

  test("opaque connections keep endpoint and owner boundaries separate", async () => {
    const provider = await fixture("opaque");
    try {
      const first = await provider.callback(await provider.begin());
      const otherEndpoint = await provider.callback(
        await provider.begin({ mcpUrl: "https://connector.example.test/other" }),
      );
      const shared = await provider.callback(await provider.begin({ ownership: "workspace" }));
      expect([first.state, otherEndpoint.state, shared.state]).toEqual([
        "complete",
        "complete",
        "complete",
      ]);
      expect(new Set([first.account.id, otherEndpoint.account.id, shared.account.id]).size).toBe(3);
      expect(await provider.connections()).toHaveLength(3);
    } finally {
      provider.restore();
    }
  }, 60_000);
});
