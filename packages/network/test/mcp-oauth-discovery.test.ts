import { describe, expect, test } from "bun:test";
import {
  McpOAuthDiscoveryError,
  parseMcpOAuthChallenge,
  resolveMcpOAuthDiscovery,
  type McpOAuthMetadataFetchResult,
} from "../src/mcp-oauth-discovery";

const resourceUrl = "https://mcp.example.test/v1/mcp";

function metadataFetcher(
  documents: Record<string, Record<string, unknown> | 404>,
): (input: { url: string }) => Promise<McpOAuthMetadataFetchResult> {
  return async ({ url }) => {
    const document = documents[url] ?? 404;
    return document === 404
      ? { status: "absent", url, httpStatus: 404 }
      : { status: "present", url, document };
  };
}

function validateEndpoint(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("OAuth endpoint must use https");
  return url.toString();
}

function canonicalizeResource(rawResource: string): string {
  const url = new URL(rawResource);
  url.hash = "";
  return url.toString();
}

const modernPrmUrl = "https://mcp.example.test/.well-known/oauth-protected-resource/v1/mcp";
const modernAsMetadataUrl =
  "https://auth.example.test/.well-known/oauth-authorization-server/tenant";
const modernAs = {
  issuer: "https://auth.example.test/tenant",
  authorization_endpoint: "https://auth.example.test/authorize",
  token_endpoint: "https://auth.example.test/token",
  registration_endpoint: "https://auth.example.test/register",
  code_challenge_methods_supported: ["S256"],
};

describe("MCP OAuth discovery", () => {
  test("parses parameterless challenges and stops before the next auth scheme", () => {
    expect(parseMcpOAuthChallenge('Bearer, Basic scope="must-not-leak"')).toEqual({
      scheme: "bearer",
      scope: [],
    });
    expect(
      parseMcpOAuthChallenge(
        'Basic realm="mcp", OAuth scope="documents:read", Basic scope="must-not-leak"',
      ),
    ).toEqual({ scheme: "oauth", scope: ["documents:read"] });
    expect(parseMcpOAuthChallenge('Basic realm="x, Bearer, y"')).toEqual({
      scheme: null,
      scope: [],
    });
    expect(parseMcpOAuthChallenge('Basic realm="x, OAuth scope=realm-value", Bearer')).toEqual({
      scheme: "bearer",
      scope: [],
    });
    expect(
      parseMcpOAuthChallenge('Bearer error="unterminated, Basic realm=x, scope=must-not-leak'),
    ).toEqual({ scheme: null, scope: [] });
    expect(
      parseMcpOAuthChallenge(
        `Bearer, OAuth resource_metadata="${modernPrmUrl}", scope="documents:read"`,
      ),
    ).toEqual({
      scheme: "oauth",
      resourceMetadata: modernPrmUrl,
      scope: ["documents:read"],
    });
    expect(parseMcpOAuthChallenge('Bearer, OAuth resource_metadata=""')).toEqual({
      scheme: "oauth",
      resourceMetadata: "",
      scope: [],
    });
  });

  test("prefers RFC 9728 protected resource metadata and binds provenance", async () => {
    const result = await resolveMcpOAuthDiscovery({
      resourceUrl,
      challenge: parseMcpOAuthChallenge(
        `Bearer resource_metadata="${modernPrmUrl}", scope="documents:read"`,
      ),
      fetchMetadata: metadataFetcher({
        [modernPrmUrl]: {
          resource: "urn:example:mcp",
          authorization_servers: ["https://auth.example.test/tenant"],
          scopes_supported: ["documents:read"],
        },
        [modernAsMetadataUrl]: modernAs,
      }),
      validateEndpoint,
      canonicalizeResource: (value) =>
        value.startsWith("urn:") ? value : canonicalizeResource(value),
    });

    expect(result.mode).toBe("rfc9728_protected_resource");
    expect(result.classification).toBe("oauth_rfc9728");
    expect(result.resource).toBe("urn:example:mcp");
    expect(result.provenance).toMatchObject({
      protectedResourceMetadataUrl: modernPrmUrl,
      authorizationServerMetadataUrl: modernAsMetadataUrl,
    });
    expect(result.provenance.metadataSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("uses same-origin legacy RFC 8414 metadata only after every PRM candidate is absent", async () => {
    const legacyMetadataUrl = "https://mcp.example.test/.well-known/oauth-authorization-server";
    const result = await resolveMcpOAuthDiscovery({
      resourceUrl,
      challenge: parseMcpOAuthChallenge('Bearer error="invalid_token", scope="documents:read"'),
      fetchMetadata: metadataFetcher({
        [legacyMetadataUrl]: {
          issuer: "https://mcp.example.test",
          authorization_endpoint: "https://mcp.example.test/authorize",
          token_endpoint: "https://mcp.example.test/token",
          registration_endpoint: "https://mcp.example.test/register",
          code_challenge_methods_supported: ["S256"],
        },
      }),
      validateEndpoint,
      canonicalizeResource,
    });

    expect(result.mode).toBe("legacy_2025_03_26_metadata");
    expect(result.classification).toBe("oauth_legacy_same_origin_metadata");
    expect(result.resource).toBe(resourceUrl);
    expect(result.protectedResourceMetadata.raw).toEqual({
      resource: resourceUrl,
      authorization_servers: ["https://mcp.example.test/"],
      scopes_supported: ["documents:read"],
    });
    expect(result.provenance.protectedResourceMetadataUrl).toBeNull();
  });

  test("never downgrades an advertised but missing PRM document", async () => {
    await expect(
      resolveMcpOAuthDiscovery({
        resourceUrl,
        challenge: parseMcpOAuthChallenge(`Bearer resource_metadata="${modernPrmUrl}"`),
        fetchMetadata: metadataFetcher({
          "https://mcp.example.test/.well-known/oauth-authorization-server": {
            issuer: "https://mcp.example.test",
            authorization_endpoint: "https://mcp.example.test/authorize",
            token_endpoint: "https://mcp.example.test/token",
            code_challenge_methods_supported: ["S256"],
          },
        }),
        validateEndpoint,
        canonicalizeResource,
      }),
    ).rejects.toMatchObject({
      classification: "oauth_discovery_broken",
      stage: "protected_resource_metadata",
    });

    await expect(
      resolveMcpOAuthDiscovery({
        resourceUrl,
        challenge: parseMcpOAuthChallenge('Bearer resource_metadata=""'),
        fetchMetadata: metadataFetcher({
          "https://mcp.example.test/.well-known/oauth-authorization-server": {
            issuer: "https://mcp.example.test",
            authorization_endpoint: "https://mcp.example.test/authorize",
            token_endpoint: "https://mcp.example.test/token",
            code_challenge_methods_supported: ["S256"],
          },
        }),
        validateEndpoint,
        canonicalizeResource,
      }),
    ).rejects.toMatchObject({
      classification: "oauth_discovery_broken",
      stage: "protected_resource_metadata",
    });
  });

  test("treats malformed PRM as broken instead of trying legacy discovery", async () => {
    await expect(
      resolveMcpOAuthDiscovery({
        resourceUrl,
        challenge: parseMcpOAuthChallenge("Bearer"),
        fetchMetadata: metadataFetcher({
          [modernPrmUrl]: { scopes_supported: ["documents:read"] },
        }),
        validateEndpoint,
        canonicalizeResource,
      }),
    ).rejects.toBeInstanceOf(McpOAuthDiscoveryError);
  });

  test("classifies absent legacy metadata as unverified default endpoints", async () => {
    await expect(
      resolveMcpOAuthDiscovery({
        resourceUrl,
        challenge: parseMcpOAuthChallenge("Bearer"),
        fetchMetadata: metadataFetcher({}),
        validateEndpoint,
        canonicalizeResource,
      }),
    ).rejects.toMatchObject({
      classification: "oauth_legacy_default_endpoints_unverified",
      stage: "authorization_server_metadata",
    });
  });

  test("requires a profile for cross-origin legacy issuers and rejects issuer mismatches", async () => {
    const legacyMetadataUrl = "https://mcp.example.test/.well-known/oauth-authorization-server";
    await expect(
      resolveMcpOAuthDiscovery({
        resourceUrl,
        challenge: parseMcpOAuthChallenge("Bearer"),
        fetchMetadata: metadataFetcher({
          [legacyMetadataUrl]: {
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            code_challenge_methods_supported: ["S256"],
          },
        }),
        validateEndpoint,
        canonicalizeResource,
      }),
    ).rejects.toMatchObject({ classification: "oauth_requires_profile" });

    await expect(
      resolveMcpOAuthDiscovery({
        resourceUrl,
        challenge: parseMcpOAuthChallenge("Bearer"),
        fetchMetadata: metadataFetcher({
          [legacyMetadataUrl]: {
            issuer: "https://mcp.example.test/other-issuer",
            authorization_endpoint: "https://mcp.example.test/authorize",
            token_endpoint: "https://mcp.example.test/token",
            code_challenge_methods_supported: ["S256"],
          },
        }),
        validateEndpoint,
        canonicalizeResource,
      }),
    ).rejects.toMatchObject({ classification: "oauth_discovery_broken" });
  });

  test("rejects unsafe endpoints and missing S256", async () => {
    const legacyMetadataUrl = "https://mcp.example.test/.well-known/oauth-authorization-server";
    await expect(
      resolveMcpOAuthDiscovery({
        resourceUrl,
        challenge: parseMcpOAuthChallenge("Bearer"),
        fetchMetadata: metadataFetcher({
          [legacyMetadataUrl]: {
            issuer: "https://mcp.example.test",
            authorization_endpoint: "http://mcp.example.test/authorize",
            token_endpoint: "https://mcp.example.test/token",
            code_challenge_methods_supported: ["S256"],
          },
        }),
        validateEndpoint,
        canonicalizeResource,
      }),
    ).rejects.toMatchObject({ classification: "oauth_discovery_broken" });

    await expect(
      resolveMcpOAuthDiscovery({
        resourceUrl,
        challenge: parseMcpOAuthChallenge("Bearer"),
        fetchMetadata: metadataFetcher({
          [legacyMetadataUrl]: {
            issuer: "https://mcp.example.test",
            authorization_endpoint: "https://mcp.example.test/authorize",
            token_endpoint: "https://mcp.example.test/token",
            code_challenge_methods_supported: ["plain"],
          },
        }),
        validateEndpoint,
        canonicalizeResource,
      }),
    ).rejects.toMatchObject({ classification: "oauth_discovery_broken" });
  });
});
