import { describe, expect, test } from "bun:test";
import {
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  McpOAuthAuthorizationServerMetadata,
  McpOAuthClientRegistrationRequest,
  McpOAuthTokenResponse,
} from "../src";

describe("MCP OAuth contracts", () => {
  test("pins public clients, PKCE metadata, and bounded token lifetimes", () => {
    expect(
      McpOAuthClientRegistrationRequest.parse({
        redirect_uris: ["https://client.example/callback"],
      }),
    ).toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(
      McpOAuthAuthorizationServerMetadata.parse({
        issuer: "https://api.example.test",
        authorization_endpoint: "https://api.example.test/oauth/authorize",
        token_endpoint: "https://api.example.test/oauth/token",
        registration_endpoint: "https://api.example.test/oauth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp:access"],
        authorization_response_iss_parameter_supported: true,
      }),
    ).toBeTruthy();
    expect(() =>
      McpOAuthClientRegistrationRequest.parse({
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["refresh_token"],
      }),
    ).toThrow("authorization_code grant is required");
    expect(
      McpOAuthClientRegistrationRequest.parse({
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code"],
        scope: "mcp:access",
      }),
    ).toMatchObject({
      grant_types: ["authorization_code"],
      scope: "mcp:access",
    });
    expect(
      McpOAuthTokenResponse.parse({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        scope: "mcp:access",
      }),
    ).not.toHaveProperty("refresh_token");
    expect(MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS).toBe(2_592_000);
  });
});
