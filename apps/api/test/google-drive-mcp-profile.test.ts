import { describe, expect, test } from "bun:test";
import {
  assertAuthorizationServerNotReserved,
  builtInOAuthProfileFor,
  DEFAULT_OAUTH_PROFILE,
} from "../src/integrations/oauth-profiles";

const url = "https://drivemcp.googleapis.com/mcp/v1";
const google = {
  issuer: "https://accounts.google.com",
  authorizationServer: "https://accounts.google.com",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
};

describe("official Drive MCP setup", () => {
  test("a Drive connection may authenticate to Google without opening arbitrary Google MCP targets", () => {
    const drive = builtInOAuthProfileFor({ mcpUrl: url });
    expect(drive).not.toBeNull();
    expect(() => assertAuthorizationServerNotReserved(google, drive!)).not.toThrow();
    expect(() => assertAuthorizationServerNotReserved(google, DEFAULT_OAUTH_PROFILE)).toThrow();
    for (const invalid of [`${url}/`, `${url}?other=1`, "https://attacker.test/mcp"]) {
      expect(builtInOAuthProfileFor({ mcpUrl: invalid })).toBeNull();
    }
  });

  test("scheduled Drive use requires offline consent and actual read/write grants", () => {
    const drive = builtInOAuthProfileFor({ mcpUrl: url });
    expect(drive).toMatchObject({
      defaultOwnership: "personal",
      sendResourceParameter: false,
      extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
      reportedScopesRequired: true,
      freshRefreshTokenRequired: true,
      fullRequestedScopesRequired: true,
      confidentialClientRequired: true,
      remoteToolVerification: {
        toolName: "list_recent_files",
        arguments: { pageSize: 1, excludeContentSnippets: true },
      },
      requestedScopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file",
      ],
    });
    // Actual tool discovery must come from Google's server, never a synthetic local bridge.
    expect(drive?.localToolVerification).toBeUndefined();
  });
});
