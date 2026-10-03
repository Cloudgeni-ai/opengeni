import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { GMAIL_REST_MCP_TOOLS } from "@opengeni/runtime";
import { gmailOAuthClientConfigured } from "../src/integrations/oauth-client";
import {
  OFFICIAL_GMAIL_MCP_SCOPES,
  OFFICIAL_GMAIL_MCP_URL,
  builtInOAuthProfileFor,
} from "../src/integrations/oauth-profiles";

const profile = builtInOAuthProfileFor({ mcpUrl: OFFICIAL_GMAIL_MCP_URL })!;

describe("Gmail REST OAuth profile", () => {
  test("only the exact reviewed identity uses pinned Google metadata and Gmail account verification", () => {
    expect(profile.providerOAuthDiscovery).toEqual({
      issuer: "https://accounts.google.com",
      metadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
    });
    expect(profile.localToolVerification).toMatchObject({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      method: "GET",
      required: true,
    });
    expect(profile.sendResourceParameter).toBe(false);
    expect(profile.defaultOwnership).toBe("personal");
    expect(profile.requiredOwnership?.ownership).toBe("personal");
    expect(profile.reportedScopesRequired).toBe(true);
    expect(profile.freshRefreshTokenRequired).toBe(true);
    expect(profile.fullRequestedScopesRequired).toBe(true);
    expect(profile.confidentialClientRequired).toBe(true);
    for (const mcpUrl of [
      `${OFFICIAL_GMAIL_MCP_URL}?other=1`,
      `${OFFICIAL_GMAIL_MCP_URL}/`,
      "https://other.example.test/mcp",
    ]) {
      expect(
        builtInOAuthProfileFor({ mcpUrl, providerDomain: "gmailmcp.googleapis.com" }),
      ).toBeNull();
    }
  });

  test("account verification keeps only the authenticated Gmail profile label", () => {
    expect(
      profile.localToolVerification!.validateIdentity({
        emailAddress: "mailbox@example.test",
        historyId: "opaque",
        messagesTotal: 999,
      }),
    ).toEqual({ gmailEmail: "mailbox@example.test" });
    for (const payload of [{}, { emailAddress: "invalid" }, { emailAddress: "a b@example.test" }])
      expect(() => profile.localToolVerification!.validateIdentity(payload)).toThrow();
  });

  test("verified discovery is bounded by actual reported scopes and the existing reviewed tools", () => {
    const tools = profile.localToolVerification!.toolsForScopes;
    expect(tools([])).toEqual([]);
    expect(tools(["https://www.googleapis.com/auth/drive.readonly"])).toEqual([]);
    expect(tools(OFFICIAL_GMAIL_MCP_SCOPES).map(({ name }) => name)).toEqual(
      GMAIL_REST_MCP_TOOLS.map(({ name }) => name),
    );
    expect(
      tools([OFFICIAL_GMAIL_MCP_SCOPES[0]])
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["get_message", "get_thread", "list_drafts", "list_labels", "search_threads"]);
    expect(
      tools([OFFICIAL_GMAIL_MCP_SCOPES[1]])
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["create_draft", "list_drafts", "send_draft", "send_message"]);
    expect(tools([OFFICIAL_GMAIL_MCP_SCOPES[2]]).map(({ name }) => name)).toEqual(
      GMAIL_REST_MCP_TOOLS.map(({ name }) => name),
    );
  });

  test("readiness requires the registered Google client actually resolved by setup", () => {
    expect(gmailOAuthClientConfigured(testSettings())).toBe(false);
    expect(
      gmailOAuthClientConfigured(
        testSettings({
          integrationsOauthClientsJson: JSON.stringify({
            "https://accounts.google.com": {
              clientId: "public-client",
              tokenEndpointAuthMethod: "none",
            },
          }),
        }),
      ),
    ).toBe(false);
    expect(
      gmailOAuthClientConfigured(
        testSettings({
          integrationsOauthClientsJson: JSON.stringify({
            "https://accounts.google.com": {
              clientId: "normalized-web-client",
              clientSecret: "fixture-secret",
              tokenEndpointAuthMethod: "none",
            },
          }),
        }),
      ),
    ).toBe(true);
    expect(
      gmailOAuthClientConfigured(
        testSettings({
          googleDriveClientId: "drive-client",
          googleDriveClientSecret: "drive-secret",
        }),
      ),
    ).toBe(false);
    expect(
      gmailOAuthClientConfigured(
        testSettings({
          integrationsOauthClientsJson: JSON.stringify({
            "https://other.example.test": { clientId: "other", tokenEndpointAuthMethod: "none" },
          }),
        }),
      ),
    ).toBe(false);
    expect(
      gmailOAuthClientConfigured(
        testSettings({
          integrationsOauthClientsJson: JSON.stringify({
            "https://accounts.google.com/": {
              clientId: "fixture-client",
              clientSecret: "fixture-secret",
              tokenEndpointAuthMethod: "client_secret_post",
            },
          }),
        }),
      ),
    ).toBe(true);
  });
});
