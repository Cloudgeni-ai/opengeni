import { expect, test } from "bun:test";
import { chooseMcpAuthorizeScopes } from "../src/integrations/oauth-client";
import {
  OFFICIAL_GMAIL_MCP_SCOPES,
  OFFICIAL_GMAIL_MCP_URL,
} from "../src/integrations/oauth-profiles";

const generic = {
  mcpUrl: "https://mcp.example.test/platform",
  requested: undefined,
  challenged: ["mcp:use"],
  supported: ["mcp:use"],
};

test("generic OAuth requests AS-supported offline access alongside the MCP challenge", () => {
  expect(
    chooseMcpAuthorizeScopes({
      ...generic,
      authorizationServerScopesSupported: ["mcp:use", "offline_access"],
    }),
  ).toEqual(["mcp:use", "offline_access"]);
  expect(
    chooseMcpAuthorizeScopes({
      ...generic,
      requested: ["mcp:use", "offline_access"],
      authorizationServerScopesSupported: ["offline_access"],
    }),
  ).toEqual(["mcp:use", "offline_access"]);
});

test("does not add refresh scope when the authorization server does not advertise it", () => {
  expect(chooseMcpAuthorizeScopes(generic)).toEqual(["mcp:use"]);
  expect(
    chooseMcpAuthorizeScopes({
      ...generic,
      authorizationServerScopesSupported: ["other:permission"],
    }),
  ).toEqual(["mcp:use"]);
});

test("reviewed Gmail scope pins remain exact even when the AS advertises offline_access", () => {
  expect(
    chooseMcpAuthorizeScopes({
      ...generic,
      mcpUrl: OFFICIAL_GMAIL_MCP_URL,
      authorizationServerScopesSupported: ["offline_access"],
    }),
  ).toEqual([...OFFICIAL_GMAIL_MCP_SCOPES]);
});
