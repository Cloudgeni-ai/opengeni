import { describe, expect, spyOn, test } from "bun:test";
import * as network from "@opengeni/network";
import { testSettings } from "@opengeni/testing/settings";
import { refreshOAuthConnectionCredential, type ConnectionCredentialForBroker } from "@opengeni/db";
import { inspectMcpAuthentication } from "../src/integrations/oauth-client";

const resource = "https://admin-api.example.com/mcp";
const metadata = "https://admin-api.example.com/.well-known/oauth-protected-resource";
const settings = testSettings({
  environment: "production",
  integrationsAllowPrivateNetworkTargets: false,
  integrationsPrivateNetworkAllowedHosts: ["admin-api.example.com:443"],
});

// Preserve the production destination checks and pinning; replace only DNS
// and the final HTTP implementation. Never turn on the local/test exception.
async function withProvider(provider: network.FetchLike, run: () => Promise<void>) {
  const pinned = network.pinnedFetch;
  const transport = spyOn(network, "pinnedFetch").mockImplementation(
    (input, init, policy, options) =>
      pinned(input, init, policy, {
        ...options,
        dnsLookup: async () => [{ address: "10.0.0.8", family: 4 }],
        fetchImpl: provider,
      }),
  );
  try {
    await run();
  } finally {
    transport.mockRestore();
  }
}

describe("private-host policy in connector OAuth paths", () => {
  test.each(["allowed", "metadata_redirect", "other_authorization_server"] as const)(
    "MCP challenge and OAuth metadata: %s",
    async (scenario) => {
      const requests: string[] = [];
      await withProvider(
        async (input, init) => {
          const url = input.toString();
          requests.push(url);
          expect(init?.redirect).toBe("manual");
          if (url === resource)
            return new Response(null, {
              status: 401,
              headers: { "www-authenticate": `Bearer resource_metadata="${metadata}"` },
            });
          if (url === metadata) {
            if (scenario === "metadata_redirect")
              return new Response(null, {
                status: 302,
                headers: { location: "https://other.example.com/metadata" },
              });
            return Response.json({
              resource,
              authorization_servers: [
                scenario === "other_authorization_server"
                  ? "https://other.example.com"
                  : "https://admin-api.example.com",
              ],
            });
          }
          return Response.json({
            issuer: "https://admin-api.example.com",
            authorization_endpoint: "https://admin-api.example.com/authorize",
            token_endpoint: "https://admin-api.example.com/token",
            registration_endpoint: "https://admin-api.example.com/register",
            code_challenge_methods_supported: ["S256"],
          });
        },
        async () => {
          expect((await inspectMcpAuthentication(resource, settings)).kind).toBe(
            scenario === "allowed" ? "oauth2" : "unknown",
          );
        },
      );
      expect(requests).toEqual(
        scenario === "allowed"
          ? [
              resource,
              metadata,
              "https://admin-api.example.com/.well-known/oauth-authorization-server",
            ]
          : [resource, metadata],
      );
    },
  );

  test.each(["admin-api.example.com", "other.example.com"])(
    "refresh token endpoint checks its own host: %s",
    async (hostname) => {
      let requests = 0;
      const credential: ConnectionCredentialForBroker = {
        id: "connection",
        accountId: "account",
        workspaceId: "workspace",
        subjectId: "owner",
        providerDomain: "admin-api.example.com",
        kind: "oauth2",
        status: "active",
        credential: {
          refresh_token: "fixture-refresh",
          client_id: "fixture-client",
          token_endpoint: `https://${hostname}/token`,
        },
        grantedScopes: [],
        expiresAt: null,
        lastRefreshAt: null,
        version: 1,
        authorityGeneration: 1,
        metadata: {},
      };
      await withProvider(
        async (_input, init) => {
          requests++;
          expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(
            "fixture-refresh",
          );
          return Response.json({
            access_token: "fixture-access",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
        async () => {
          const result = refreshOAuthConnectionCredential(
            credential,
            {
              connectionId: "connection",
              providerDomain: "admin-api.example.com",
              kind: "oauth2",
              subjectScope: "subject",
            },
            settings,
          );
          if (hostname === "admin-api.example.com") {
            expect((await result).credential.access_token).toBe("fixture-access");
          } else {
            await expect(result).rejects.toMatchObject({ reason: "private_or_special_use" });
          }
        },
      );
      expect(requests).toBe(hostname === "admin-api.example.com" ? 1 : 0);
    },
  );
});
