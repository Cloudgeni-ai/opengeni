import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { inspectMcpAuthentication } from "../src/integrations/oauth-client";

function provider(metadataStatus = 200, malformed = false) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === "/mcp")
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${url.origin}/metadata"`,
          },
        });
      if (url.pathname === "/metadata")
        return Response.json({
          resource: `${url.origin}/mcp`,
          authorization_servers: [url.origin],
          scopes_supported: ["records.read"],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (!request.headers.get("user-agent") || metadataStatus !== 200)
          return new Response("Synthetic upstream diagnostic", {
            status: metadataStatus === 200 ? 403 : metadataStatus,
          });
        if (malformed)
          return new Response("invalid metadata", {
            headers: { "content-type": "application/json" },
          });
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          registration_endpoint: `${url.origin}/register`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  return { server, requests, resource: `http://127.0.0.1:${server.port}/mcp` };
}

describe("MCP sign-in inspection", () => {
  test("discovers OAuth when provider metadata requires an identified HTTP client", async () => {
    const fixture = provider();
    try {
      expect(await inspectMcpAuthentication(fixture.resource, testSettings())).toEqual({
        kind: "oauth2",
      });
      expect(fixture.requests).toEqual([
        "/mcp",
        "/metadata",
        "/.well-known/oauth-authorization-server",
      ]);
    } finally {
      fixture.server.stop(true);
    }
  });

  test.each([403, 503])(
    "reports metadata HTTP %i without downgrading to unauthenticated",
    async (status) => {
      const fixture = provider(status);
      try {
        const result = await inspectMcpAuthentication(fixture.resource, testSettings());
        expect(result.kind).toBe("unknown");
        expect(result.message).toContain(`HTTP ${status}`);
        expect(result.message).toContain("Retry");
        expect(result.message).not.toContain("Synthetic upstream diagnostic");
        expect(fixture.requests).toEqual([
          "/mcp",
          "/metadata",
          "/.well-known/oauth-authorization-server",
        ]);
      } finally {
        fixture.server.stop(true);
      }
    },
  );

  test("keeps malformed metadata unavailable with retry guidance", async () => {
    const fixture = provider(200, true);
    try {
      const result = await inspectMcpAuthentication(fixture.resource, testSettings());
      expect(result.kind).toBe("unknown");
      expect(result.message).toContain("Retry");
      expect(result.message).not.toContain("invalid metadata");
    } finally {
      fixture.server.stop(true);
    }
  });
});
