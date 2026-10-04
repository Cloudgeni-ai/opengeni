import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  buildConnectionTokenResolver,
  createConnection,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  ensureExternalIdentity,
  encryptEnvironmentValue,
  getConnectionMetadata,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  type DbClient,
} from "@opengeni/db";
import {
  normalizeSlackScopes,
  OPENGENI_SLACK_REST_USER_SCOPES,
  SLACK_REST_MCP_TOOLS,
  slackRestMcpToolsForScopes,
} from "@opengeni/contracts/slack-rest-mcp";
import * as network from "@opengeni/network";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createApp } from "../src/app";
import { chooseMcpAuthorizeScopes } from "../src/integrations/oauth-client";
import { builtInOAuthProfileFor, OFFICIAL_SLACK_MCP_URL } from "../src/integrations/oauth-profiles";

let database: SharedTestDatabase;
let client: DbClient;
const workspaces: string[] = [];
const ACCESS_TOKEN = "slack-rest-oauth-fixture-access";
const REFRESH_TOKEN = "slack-rest-oauth-fixture-refresh";
const TOKEN_URL = "https://slack.com/api/oauth.v2.user.access";
const AUTH_TEST_URL = "https://slack.com/api/auth.test";

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) {
    throw new Error("The PostgreSQL admin and app fixture URLs must be set together");
  }
  const admin = adminUrl ? postgres(adminUrl, { max: 4 }) : null;
  const acquired =
    admin && adminUrl && appUrl
      ? { admin, adminUrl, appUrl, release: async () => await admin.end() }
      : await acquireSharedTestDatabase("slack-rest-oauth");
  if (!acquired) throw new Error("Slack OAuth proof requires the PostgreSQL test fixture");
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

async function fixture(
  options: { scopeText?: string; omitScope?: boolean; identity?: Record<string, unknown> } = {},
) {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Slack API pilot",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Slack callback fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "slack-callback-user",
  });
  const key = randomBytes(24).toString("hex");
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Slack callback fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["workspace:read", "connections:read", "connections:write"],
  });
  const settings = testSettings({
    productAccessMode: "managed",
    integrationsEnabled: true,
    publicBaseUrl: "https://runtime.example.test",
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
    integrationsStateSecret: "slack-rest-oauth-fixture-state",
    slackClientId: "slack-rest-oauth-fixture-client",
    slackClientSecret: "slack-rest-oauth-fixture-secret",
  });
  const app = createApp({
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    settings,
  });
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
    ),
  };
  const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect/attempts`;
  const returnUrl = "https://product.example.test/settings?connected=slack";
  const requests: Array<{ url: string; authorization: string | null; body: URLSearchParams }> = [];
  let authenticatedMcpRequests = 0;
  const transport = spyOn(network, "pinnedFetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ url, authorization, body: new URLSearchParams(String(init?.body ?? "")) });
    if (url === OFFICIAL_SLACK_MCP_URL) {
      if (!authorization)
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer resource_metadata="https://mcp.slack.com/prm"',
          },
        });
      authenticatedMcpRequests++;
      return Response.json(
        { error: "App not approved for Slack MCP server access." },
        { status: 400 },
      );
    }
    if (url === "https://mcp.slack.com/prm")
      return Response.json({
        resource: OFFICIAL_SLACK_MCP_URL,
        authorization_servers: ["https://slack.com"],
        scopes_supported: ["search:read.public", "chat:write", "mcp:access"],
      });
    if (url.startsWith("https://slack.com/.well-known/"))
      return Response.json({
        issuer: "https://slack.com",
        authorization_endpoint: "https://slack.com/oauth/v2/authorize",
        token_endpoint: TOKEN_URL,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        scopes_supported: ["search:read.public", "offline_access", "chat:write"],
      });
    if (url === TOKEN_URL)
      return Response.json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        token_type: "Bearer",
        ...(options.omitScope
          ? {}
          : { scope: options.scopeText ?? OPENGENI_SLACK_REST_USER_SCOPES.join(",") }),
      });
    if (url === AUTH_TEST_URL)
      return Response.json(
        options.identity ?? { ok: true, team_id: "T_EXTERNAL", user_id: "U_EXTERNAL" },
      );
    throw new Error(`Unexpected synthetic Slack OAuth destination: ${url}`);
  });
  async function begin(ownership: "personal" | "workspace" = "personal") {
    const response = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "slack-personal",
        ownership,
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
        action: { type: "credentials", values: {} },
      }),
    });
    expect(advanced.status).toBe(200);
    const ready = await advanced.json();
    expect(ready.state).toBe("requires_user_action");
    const authorizationUrl = new URL(ready.nextAction.url);
    return { attempt: ready, authorizationUrl, state: authorizationUrl.searchParams.get("state")! };
  }
  const callback = (state: string) =>
    app.request(
      `/v1/integrations/oauth/callback?${new URLSearchParams({ state, code: "fixture-code" })}`,
    );
  const read = async (id: string) => (await app.request(`${base}/${id}`, { headers })).json();
  return {
    settings,
    identity,
    requests,
    returnUrl,
    begin,
    callback,
    read,
    authenticatedMcpRequests: () => authenticatedMcpRequests,
    restore: () => transport.mockRestore(),
  };
}

describe("Slack API-backed personal OAuth", () => {
  test.each(["personal", "workspace"] as const)(
    "%s account callback verifies the Web API and saves the reviewed tools without an installed bot",
    async (ownership) => {
      const provider = await fixture();
      try {
        const begun = await provider.begin(ownership);
        expect(begun.authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual([
          ...OPENGENI_SLACK_REST_USER_SCOPES,
        ]);
        expect(begun.authorizationUrl.searchParams.has("code_verifier")).toBe(false);
        expect((await provider.callback(begun.state)).headers.get("location")).toBe(
          provider.returnUrl,
        );
        const completed = await provider.read(begun.attempt.id);
        expect(completed).toMatchObject({
          state: "complete",
          credentialsCommitted: true,
          integrationInstalled: false,
          account: { providerId: "slack-personal", ownership, status: "connected" },
        });
        const saved = await getConnectionMetadata(
          client.db,
          provider.identity.personalWorkspaceId,
          completed.account.id,
          provider.identity.subjectId,
        );
        expect(saved?.subjectId).toBe(
          ownership === "personal" ? provider.identity.subjectId : null,
        );
        expect(saved?.kind).toBe("oauth2");
        expect(saved?.grantedScopes).toEqual(normalizeSlackScopes(OPENGENI_SLACK_REST_USER_SCOPES));
        expect(saved?.metadata).toMatchObject({
          mcpUrl: OFFICIAL_SLACK_MCP_URL,
          slackTeamId: "T_EXTERNAL",
          slackUserId: "U_EXTERNAL",
          mcpToolsVerification: { status: "ok", toolCount: 9 },
        });
        expect(
          (saved!.metadata.mcpTools as Array<{ name: string }>).map((tool) => tool.name),
        ).toEqual(SLACK_REST_MCP_TOOLS.map((tool) => tool.name));
        const tokenRequest = provider.requests.find((request) => request.url === TOKEN_URL)!;
        expect(tokenRequest.body.get("client_id")).toBe("slack-rest-oauth-fixture-client");
        expect(tokenRequest.body.get("client_secret")).toBe("slack-rest-oauth-fixture-secret");
        expect(tokenRequest.body.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
        expect(
          provider.requests.find((request) => request.url === AUTH_TEST_URL)?.authorization,
        ).toBe(`Bearer ${ACCESS_TOKEN}`);
        expect(provider.authenticatedMcpRequests()).toBe(0);
        const visible = await listConnectionsMetadata(
          client.db,
          provider.identity.personalWorkspaceId,
          provider.identity.subjectId,
        );
        expect(visible).toHaveLength(1);
        expect(visible[0]?.kind).not.toBe("app_install");
        expect((await provider.callback(begun.state)).headers.get("location")).toBe(
          provider.returnUrl,
        );
        expect(provider.requests.filter((request) => request.url === TOKEN_URL)).toHaveLength(1);
        expect(provider.requests.filter((request) => request.url === AUTH_TEST_URL)).toHaveLength(
          1,
        );
      } finally {
        provider.restore();
      }
    },
    30_000,
  );

  test("a reduced comma-delimited grant exposes only the tools Slack actually allowed", async () => {
    const provider = await fixture({ scopeText: "chat:write,users:read, chat:write" });
    try {
      const begun = await provider.begin();
      await provider.callback(begun.state);
      const completed = await provider.read(begun.attempt.id);
      const saved = await getConnectionMetadata(
        client.db,
        provider.identity.personalWorkspaceId,
        completed.account.id,
        provider.identity.subjectId,
      );
      expect(saved?.grantedScopes).toEqual(["chat:write", "users:read"]);
      expect(
        (saved!.metadata.mcpTools as Array<{ name: string }>).map((tool) => tool.name),
      ).toEqual(["slack_list_users", "slack_get_user_info", "slack_send_message"]);
      expect(saved?.metadata.mcpToolsVerification).toMatchObject({ status: "ok", toolCount: 3 });
      expect(provider.authenticatedMcpRequests()).toBe(0);
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("a revoked token preserves its encrypted grant and failed verification without hosted MCP retry", async () => {
    const provider = await fixture({ identity: { ok: false, error: "token_revoked" } });
    try {
      const begun = await provider.begin();
      expect((await provider.callback(begun.state)).headers.get("location")).toBe(
        provider.returnUrl,
      );
      const completed = await provider.read(begun.attempt.id);
      expect(completed).toMatchObject({
        state: "complete",
        credentialsCommitted: true,
        account: { status: "auth_needed" },
      });
      const saved = await getConnectionMetadata(
        client.db,
        provider.identity.personalWorkspaceId,
        completed.account.id,
        provider.identity.subjectId,
      );
      expect(saved?.status).toBe("needs_reauth");
      expect(saved?.metadata.mcpToolsVerification).toMatchObject({ status: "failed" });
      expect(saved?.metadata.slackTeamId).toBeUndefined();
      expect(saved?.metadata.mcpTools).toBeUndefined();
      const credential = await loadConnectionCredentialForBroker(client.db, provider.settings, {
        workspaceId: provider.identity.personalWorkspaceId,
        connectionId: completed.account.id,
        providerDomain: "slack.com",
        kind: "oauth2",
        subjectId: provider.identity.subjectId,
        allowSubjectOwned: true,
      });
      expect(credential?.credential).toMatchObject({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
      });
      expect(provider.authenticatedMcpRequests()).toBe(0);
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("a token response without reported scopes exposes no tools rather than assuming requested grants", async () => {
    const provider = await fixture({ omitScope: true });
    try {
      const begun = await provider.begin();
      expect(begun.authorizationUrl.searchParams.get("scope")?.split(" ")).toHaveLength(11);
      await provider.callback(begun.state);
      const completed = await provider.read(begun.attempt.id);
      const saved = await getConnectionMetadata(
        client.db,
        provider.identity.personalWorkspaceId,
        completed.account.id,
        provider.identity.subjectId,
      );
      expect(saved?.grantedScopes).toEqual([]);
      expect(saved?.metadata.mcpTools).toEqual([]);
      expect(saved?.metadata.mcpToolsVerification).toMatchObject({ status: "ok", toolCount: 0 });
      expect(provider.authenticatedMcpRequests()).toBe(0);
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("temporary Slack verification failure keeps the saved grant usable for a later retry", async () => {
    const provider = await fixture({ identity: { ok: false, error: "internal_error" } });
    try {
      const begun = await provider.begin();
      await provider.callback(begun.state);
      const completed = await provider.read(begun.attempt.id);
      const saved = await getConnectionMetadata(
        client.db,
        provider.identity.personalWorkspaceId,
        completed.account.id,
        provider.identity.subjectId,
      );
      expect(saved?.status).toBe("active");
      expect(saved?.metadata.mcpToolsVerification).toMatchObject({ status: "failed" });
      expect(provider.authenticatedMcpRequests()).toBe(0);
    } finally {
      provider.restore();
    }
  }, 30_000);

  test("an existing hosted-MCP failure and comma-packed saved scopes do not force reconnection for Web API use", async () => {
    const provider = await fixture();
    try {
      const saved = await createConnection(client.db, {
        accountId: provider.identity.accountId,
        workspaceId: provider.identity.personalWorkspaceId,
        subjectId: provider.identity.subjectId,
        providerDomain: "slack.com",
        kind: "oauth2",
        grantedScopes: ["users:read,chat:write"],
        credentialEncrypted: encryptEnvironmentValue(
          Buffer.from(provider.settings.environmentsEncryptionKey!, "base64"),
          JSON.stringify({
            access_token: ACCESS_TOKEN,
            token_type: "Bearer",
            mcp_url: OFFICIAL_SLACK_MCP_URL,
            resource: OFFICIAL_SLACK_MCP_URL,
          }),
        ),
        metadata: {
          mcpUrl: OFFICIAL_SLACK_MCP_URL,
          resource: OFFICIAL_SLACK_MCP_URL,
          mcpToolsVerification: {
            status: "failed",
            reason: "App not approved for Slack MCP server access.",
          },
        },
        createdBySubjectId: provider.identity.subjectId,
      });
      const resolved = await buildConnectionTokenResolver(
        client.db,
        provider.settings,
      )({
        workspaceId: provider.identity.personalWorkspaceId,
        subjectId: provider.identity.subjectId,
        serverId: "slack-pilot",
        destinationUrl: "https://slack.com/api/users.info",
        connectionRef: {
          connectionId: saved.id,
          providerDomain: "slack.com",
          kind: "oauth2",
          subjectScope: "subject",
          scopes: ["users:read"],
          resource: OFFICIAL_SLACK_MCP_URL,
        },
      });
      expect(resolved).toMatchObject({ status: "ok" });
      if (resolved.status !== "ok") throw new Error("Legacy Slack grant did not resolve");
      expect(resolved.grantedScopes).toEqual(["chat:write", "users:read"]);
      expect(resolved.connectionId).toBe(saved.id);
      expect(provider.requests).toHaveLength(0);
      expect(slackRestMcpToolsForScopes(resolved.grantedScopes!).map((tool) => tool.name)).toEqual([
        "slack_list_users",
        "slack_get_user_info",
        "slack_send_message",
      ]);
    } finally {
      provider.restore();
    }
  }, 30_000);
});

test("reviewed Slack scopes cannot be widened by caller or hosted metadata and normalize legacy saved arrays", () => {
  const profile = builtInOAuthProfileFor({ mcpUrl: OFFICIAL_SLACK_MCP_URL })!;
  const requested = chooseMcpAuthorizeScopes({
    mcpUrl: OFFICIAL_SLACK_MCP_URL,
    requested: ["search:read.public", "files:write"],
    challenged: ["search:read.enterprise"],
    supported: ["search:read.private"],
    authorizationServerScopesSupported: ["offline_access", "search:read.public"],
  });
  expect(requested).toEqual([...OPENGENI_SLACK_REST_USER_SCOPES]);
  expect(requested).toHaveLength(11);
  expect(requested.some((scope) => scope.startsWith("search:"))).toBe(false);
  expect(profile.normalizeGrantedScopes?.(["users:read,chat:write", " users:read "])).toEqual([
    "chat:write",
    "users:read",
  ]);
  expect(slackRestMcpToolsForScopes(["users:read,chat:write"]).map((tool) => tool.name)).toEqual([
    "slack_list_users",
    "slack_get_user_info",
    "slack_send_message",
  ]);
});
