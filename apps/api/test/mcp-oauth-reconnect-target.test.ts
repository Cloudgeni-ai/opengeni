import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { mcpOAuthReconnectConnection } from "../src/integrations/oauth-client";
import { builtInOAuthProfileFor, OFFICIAL_SLACK_MCP_URL } from "../src/integrations/oauth-profiles";

const person = "user:person";

function row(input: {
  providerDomain: string;
  mcpUrl: string;
  subjectId?: string | null;
  kind?: "oauth2" | "api_key";
}) {
  return {
    kind: input.kind ?? "oauth2",
    subjectId: input.subjectId === undefined ? null : input.subjectId,
    providerDomain: input.providerDomain,
    metadata: { mcpUrl: input.mcpUrl, oauthDiscovery: { mode: "rfc9728_protected_resource" } },
  } as const;
}

describe("MCP OAuth Reconnect target", () => {
  // Connect saves the server's host as the provider domain, while the
  // Capabilities page's Reconnect sends the catalog's vendor domain. The
  // start answered 404 ("It may have been removed") for exactly these rows.
  test.each([
    ["Sentry", "https://mcp.sentry.dev/mcp", "mcp.sentry.dev"],
    ["Stripe", "https://mcp.stripe.com/", "mcp.stripe.com"],
  ])("%s: the reconnected row is found whatever domain the caller named", (_, mcpUrl, host) => {
    for (const subjectId of [null, person]) {
      const saved = row({ providerDomain: host, mcpUrl, subjectId });
      expect(mcpOAuthReconnectConnection(saved, { mcpUrl, subjectId: person })).toBe(saved);
      expect(
        mcpOAuthReconnectConnection(saved, {
          mcpUrl,
          subjectId: person,
          requestedOwnership: subjectId === null ? "workspace" : "personal",
        })?.providerDomain,
      ).toBe(host);
    }
  });

  test("a row saved under the catalog's vendor domain keeps that domain", () => {
    const saved = row({ providerDomain: "sentry.io", mcpUrl: "https://mcp.sentry.dev/mcp" });
    expect(
      mcpOAuthReconnectConnection(saved, {
        mcpUrl: "https://mcp.sentry.dev/mcp",
        subjectId: person,
      })?.providerDomain,
    ).toBe("sentry.io");
  });

  test("another endpoint, an API-key row or no row is not reconnected", () => {
    const mcpUrl = "https://mcp.sentry.dev/mcp";
    expect(
      mcpOAuthReconnectConnection(
        row({ providerDomain: "mcp.sentry.dev", mcpUrl: "https://other.example/mcp" }),
        { mcpUrl, subjectId: person },
      ),
    ).toBeNull();
    expect(
      mcpOAuthReconnectConnection(
        row({ providerDomain: "mcp.sentry.dev", mcpUrl, kind: "api_key" }),
        { mcpUrl, subjectId: person },
      ),
    ).toBeNull();
    expect(mcpOAuthReconnectConnection(null, { mcpUrl, subjectId: person })).toBeNull();
  });

  test("ownership cannot change during reconnect", () => {
    const mcpUrl = "https://mcp.stripe.com/";
    expect(() =>
      mcpOAuthReconnectConnection(row({ providerDomain: "mcp.stripe.com", mcpUrl }), {
        mcpUrl,
        subjectId: person,
        requestedOwnership: "personal",
      }),
    ).toThrow(HTTPException);
  });

  test("a built-in profile's fixed provider domain is still required", () => {
    const profileProviderDomain = builtInOAuthProfileFor({
      mcpUrl: OFFICIAL_SLACK_MCP_URL,
    })?.canonicalProviderDomain;
    expect(profileProviderDomain).toBe("slack.com");
    const input = { mcpUrl: OFFICIAL_SLACK_MCP_URL, subjectId: person, profileProviderDomain };
    expect(
      mcpOAuthReconnectConnection(
        row({ providerDomain: "mcp.slack.com", mcpUrl: OFFICIAL_SLACK_MCP_URL }),
        input,
      ),
    ).toBeNull();
    const slack = row({ providerDomain: "slack.com", mcpUrl: OFFICIAL_SLACK_MCP_URL });
    expect(mcpOAuthReconnectConnection(slack, input)).toBe(slack);
  });
});
