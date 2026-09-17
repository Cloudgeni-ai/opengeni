import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQLWrapper } from "drizzle-orm/sql";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing";
import type { ApiRouteDeps } from "@opengeni/core";
import { apiRequestBindingsForTransportPeer } from "../src/http/request-source";
import {
  completeAuthorizationRedirect,
  isMcpOAuthPublicProtocolPath,
  isMcpOAuthResourcePath,
  mcpOAuthBearerToken,
  mcpOAuthRedirectUriCandidates,
  registerMcpOAuthRoutes,
  renderMcpOAuthConsentPage,
  renderMcpOAuthContinuePage,
  renderMcpOAuthExpiredPage,
} from "../src/mcp-oauth";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function depsWithRows(rows: unknown[] = []): ApiRouteDeps {
  return {
    settings: testSettings({
      mcpOauthEnabled: true,
      publicBaseUrl: "https://api.example.test",
    }),
    db: { execute: async () => rows } as ApiRouteDeps["db"],
  } as ApiRouteDeps;
}

describe("MCP OAuth protocol", () => {
  test("publishes authorization-server and exact protected-resource metadata", async () => {
    const app = new Hono();
    registerMcpOAuthRoutes(app, depsWithRows());

    const authorization = await app.request("/.well-known/oauth-authorization-server");
    expect(authorization.status).toBe(200);
    expect(await authorization.json()).toMatchObject({
      issuer: "https://api.example.test",
      authorization_endpoint: "https://api.example.test/oauth/authorize",
      token_endpoint: "https://api.example.test/oauth/token",
      registration_endpoint: "https://api.example.test/oauth/register",
      scopes_supported: ["mcp:access"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });

    const protectedResource = await app.request(
      `/.well-known/oauth-protected-resource/v1/workspaces/${workspaceId}/mcp/docs`,
    );
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toEqual({
      resource: `https://api.example.test/v1/workspaces/${workspaceId}/mcp/docs`,
      authorization_servers: ["https://api.example.test"],
      scopes_supported: ["mcp:access"],
      bearer_methods_supported: ["header"],
    });
  });

  test("registers only public clients with exact redirect URIs", async () => {
    const app = new Hono();
    registerMcpOAuthRoutes(
      app,
      depsWithRows([
        {
          client_id: "ogmcp_client_fixture",
          redirect_uris: ["http://127.0.0.1:4567/callback"],
          client_name: "Fixture client",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          created_at: "2026-09-02T00:00:00.000Z",
        },
      ]),
    );
    const registered = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:4567/callback"],
        client_name: "Fixture client",
        application_type: "native",
        scope: "mcp:access",
      }),
    });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toEqual({
      client_id: "ogmcp_client_fixture",
      client_id_issued_at: 1_788_307_200,
      redirect_uris: ["http://127.0.0.1:4567/callback"],
      client_name: "Fixture client",
      application_type: "native",
      scope: "mcp:access",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });

    const rejected = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://attacker.example/callback"],
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "invalid_redirect_uri" });
  });

  test("registers any native custom-scheme client, not a vendor-specific redirect", async () => {
    const app = new Hono();
    registerMcpOAuthRoutes(
      app,
      depsWithRows([
        {
          client_id: "ogmcp_client_generic_native",
          redirect_uris: ["myapp://oauth/callback", "http://127.0.0.1:8787/callback"],
          client_name: "Generic MCP client",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          created_at: "2026-09-02T00:00:00.000Z",
        },
      ]),
    );
    const registered = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["myapp://oauth/callback", "http://127.0.0.1:8787/callback"],
        client_name: "Generic MCP client",
        application_type: "native",
        scope: "mcp:access",
      }),
    });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({
      client_id: "ogmcp_client_generic_native",
      client_name: "Generic MCP client",
      redirect_uris: ["myapp://oauth/callback", "http://127.0.0.1:8787/callback"],
    });
  });

  test("consent UI lets any client pick organization and workspace", () => {
    const html = renderMcpOAuthConsentPage({
      clientName: "Claude Code",
      requestToken: "ogmcp_req_fixture",
      accounts: [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Northwind" },
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Contoso" },
      ],
      workspaces: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "Site A",
          kind: "shared",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          name: "Home",
          kind: "personal",
        },
      ],
      selectedWorkspaceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(html).toContain("Claude Code");
    expect(html).toContain('name="organization"');
    expect(html).toContain('name="workspace_id"');
    expect(html).toContain("Northwind");
    expect(html).toContain("Site A");
    expect(html).toContain("Home (Personal)");
    expect(html).not.toContain("cursor://");
    expect(html).not.toContain("Resource:");
    expect(html).not.toContain("letter-spacing");
    expect(html).toContain("event.submitter");
    expect(html).toContain("submitter.name");
    expect(html).toContain("button.disabled=true");
  });

  test("authorization handoff is 200 HTML for loopback and custom-scheme redirects", async () => {
    const app = new Hono();
    app.get("/loopback", (c) =>
      completeAuthorizationRedirect(c, "http://127.0.0.1:4567/callback?code=demo"),
    );
    app.get("/https", (c) =>
      completeAuthorizationRedirect(c, "https://client.example/callback?code=demo"),
    );
    app.get("/native", (c) => completeAuthorizationRedirect(c, "myapp://oauth/callback?code=demo"));

    for (const [path, redirectTo] of [
      ["/loopback", "http://127.0.0.1:4567/callback?code=demo"],
      ["/https", "https://client.example/callback?code=demo"],
      ["/native", "myapp://oauth/callback?code=demo"],
    ] as const) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toMatch(/text\/html/);
      expect(response.headers.get("refresh")).toBe(`0;url=${redirectTo}`);
      const html = await response.text();
      expect(html).toContain("location.replace");
      expect(html).toContain(redirectTo);
      expect(html).not.toContain("Continue</a>");
    }
  });

  test("token exchange can use any registered redirect URI for the same client", () => {
    expect(
      mcpOAuthRedirectUriCandidates(
        ["myapp://oauth/callback", "http://127.0.0.1:8787/callback"],
        "http://127.0.0.1:8787/callback",
      ),
    ).toEqual(["http://127.0.0.1:8787/callback", "myapp://oauth/callback"]);
    expect(
      mcpOAuthRedirectUriCandidates(["https://client.example/callback"], "https://evil.example"),
    ).toEqual([]);
  });

  test("continue and expired pages stay client-agnostic", () => {
    const continueHtml = renderMcpOAuthContinuePage("myapp://oauth/callback?code=demo");
    expect(continueHtml).toContain("Returning to the app");
    expect(continueHtml).toContain("myapp://oauth/callback?code=demo");
    expect(continueHtml).toContain('http-equiv="refresh"');
    expect(continueHtml).not.toContain("Continue</a>");
    expect(continueHtml).not.toContain("cursor://");
    expect(continueHtml).not.toContain("letter-spacing");
    expect(renderMcpOAuthExpiredPage("This authorization request expired.")).toContain(
      "Authorization expired",
    );
  });

  test("registers native clients and ignores extra RFC 7591 metadata", async () => {
    const app = new Hono();
    registerMcpOAuthRoutes(
      app,
      depsWithRows([
        {
          client_id: "ogmcp_client_native",
          redirect_uris: [
            "cursor://anysphere.cursor-mcp/oauth/callback",
            "https://www.cursor.com/agents/mcp/oauth/callback",
            "http://localhost:8787/callback",
          ],
          client_name: "Desktop MCP client",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          created_at: "2026-09-02T00:00:00.000Z",
        },
      ]),
    );
    const registered = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [
          "cursor://anysphere.cursor-mcp/oauth/callback",
          "https://www.cursor.com/agents/mcp/oauth/callback",
          "http://localhost:8787/callback",
        ],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Desktop MCP client",
        logo_uri: "https://client.example/logo.svg",
        scope: "mcp:access",
      }),
    });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({
      client_id: "ogmcp_client_native",
      client_name: "Desktop MCP client",
      scope: "mcp:access",
      redirect_uris: [
        "cursor://anysphere.cursor-mcp/oauth/callback",
        "https://www.cursor.com/agents/mcp/oauth/callback",
        "http://localhost:8787/callback",
      ],
    });
  });

  test("explains reused browser consent instead of a raw OAuth JSON error", async () => {
    const app = new Hono();
    registerMcpOAuthRoutes(app, depsWithRows());
    const response = await app.request("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approve",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    expect(await response.text()).toContain("Authorization expired");
  });

  test("maps durable dynamic-registration admission failures to a retryable OAuth error", async () => {
    const app = new Hono();
    registerMcpOAuthRoutes(app, {
      ...depsWithRows(),
      db: {
        execute: async () => {
          throw Object.assign(new Error("registration rate limited"), {
            code: "P0004",
          });
        },
      } as ApiRouteDeps["db"],
    } as ApiRouteDeps);
    const response = await app.request("/oauth/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:4567/callback"],
      }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
  });

  test("does not let spoofed forwarding-header rotation bypass the source quota", async () => {
    const admittedSourceHashes = new Set<string>();
    const app = new Hono();
    registerMcpOAuthRoutes(app, {
      ...depsWithRows(),
      settings: testSettings({
        mcpOauthEnabled: true,
        mcpOauthTrustedProxyHops: 1,
        publicBaseUrl: "https://api.example.test",
      }),
      db: {
        execute: async (query: SQLWrapper | string) => {
          if (typeof query === "string") throw new Error("expected parameterized registration SQL");
          const compiled = new PgDialect().sqlToQuery(query.getSQL());
          const sourceHash = compiled.params.at(-1);
          if (typeof sourceHash !== "string") throw new Error("missing registration source hash");
          if (admittedSourceHashes.has(sourceHash)) {
            throw Object.assign(new Error("registration rate limited"), { code: "P0004" });
          }
          admittedSourceHashes.add(sourceHash);
          return [
            {
              client_id: compiled.params[0],
              redirect_uris: ["http://127.0.0.1:4567/callback"],
              client_name: null,
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              created_at: "2026-09-02T00:00:00.000Z",
            },
          ];
        },
      } as ApiRouteDeps["db"],
    } as ApiRouteDeps);

    const register = async (forwardedFor: string, realIp: string) =>
      await app.request(
        "/oauth/register",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": forwardedFor,
            "x-real-ip": realIp,
          },
          body: JSON.stringify({
            redirect_uris: ["http://127.0.0.1:4567/callback"],
          }),
        },
        apiRequestBindingsForTransportPeer("10.0.0.10"),
      );

    expect((await register("203.0.113.7, 198.51.100.42", "203.0.113.8")).status).toBe(201);
    expect((await register("192.0.2.99, 198.51.100.42", "192.0.2.100")).status).toBe(429);
    expect(admittedSourceHashes.size).toBe(1);
  });

  test("returns OAuth protocol errors for invalid token resources", async () => {
    const app = new Hono();
    registerMcpOAuthRoutes(
      app,
      depsWithRows([
        {
          client_id: "ogmcp_client_fixture",
          redirect_uris: ["http://127.0.0.1:4567/callback"],
          client_name: "Fixture client",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          created_at: "2026-09-02T00:00:00.000Z",
        },
      ]),
    );
    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "ogmcp_client_fixture",
        resource: "https://attacker.example/v1/workspaces/example/mcp",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_target" });

    const unsupportedGrant = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "ogmcp_client_fixture",
        resource: `https://api.example.test/v1/workspaces/${workspaceId}/mcp`,
      }),
    });
    expect(unsupportedGrant.status).toBe(400);
    expect(await unsupportedGrant.json()).toEqual({
      error: "unsupported_grant_type",
    });

    const invalidScope = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "ogmcp_client_fixture",
        resource: `https://api.example.test/v1/workspaces/${workspaceId}/mcp`,
        scope: "workspace:admin",
      }),
    });
    expect(invalidScope.status).toBe(400);
    expect(await invalidScope.json()).toEqual({ error: "invalid_scope" });
  });

  test("does not authorize refresh for an authorization-code-only client", async () => {
    const app = new Hono();
    registerMcpOAuthRoutes(
      app,
      depsWithRows([
        {
          client_id: "ogmcp_client_code_only",
          redirect_uris: ["http://127.0.0.1:4567/callback"],
          client_name: "Code-only client",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          created_at: "2026-09-02T00:00:00.000Z",
        },
      ]),
    );
    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "ogmcp_client_code_only",
        refresh_token: `ogmcp_rt_${"a".repeat(43)}`,
        resource: `https://api.example.test/v1/workspaces/${workspaceId}/mcp`,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unauthorized_client" });
  });

  test("keeps the public authorization-server surface disabled by default", async () => {
    const app = new Hono();
    registerMcpOAuthRoutes(app, {
      settings: testSettings(),
      db: { execute: async () => [] } as ApiRouteDeps["db"],
    } as ApiRouteDeps);
    expect((await app.request("/.well-known/oauth-authorization-server")).status).toBe(404);
    expect((await app.request("/oauth/register", { method: "POST" })).status).toBe(404);
  });

  test("recognizes OAuth bearer tokens only on the closed MCP resource set", () => {
    const token = `ogmcp_at_${"a".repeat(43)}`;
    expect(
      mcpOAuthBearerToken(
        new Request(`https://api.example.test/v1/workspaces/${workspaceId}/mcp`, {
          headers: { authorization: `bearer ${token}` },
        }),
      ),
    ).toBe(token);
    expect(
      mcpOAuthBearerToken(
        new Request("https://api.example.test/v1/workspaces", {
          headers: { authorization: "Bearer unrelated" },
        }),
      ),
    ).toBeNull();
    expect(isMcpOAuthResourcePath(`/v1/workspaces/${workspaceId}/mcp`)).toBe(true);
    expect(isMcpOAuthResourcePath(`/v1/workspaces/${workspaceId}/mcp/files`)).toBe(true);
    expect(isMcpOAuthResourcePath(`/v1/workspaces/${workspaceId}/tools/catalog`)).toBe(false);
    expect(isMcpOAuthPublicProtocolPath("/oauth/token")).toBe(true);
    expect(isMcpOAuthPublicProtocolPath("/v1/workspaces")).toBe(false);
  });
});
