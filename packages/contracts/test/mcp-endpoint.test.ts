import { describe, expect, test } from "bun:test";
import { mcpHostsDeploymentCannotConnect, pluginMcpUnavailableReason } from "../src/mcp-endpoint";

describe("plugin MCP servers on a provider this deployment cannot connect", () => {
  const catalog = [
    {
      kind: "mcp",
      mcpUrl: "https://mcp.dropbox.com/chatgpt_app_mcp",
      runtime: { operatorOAuthClient: { configured: false } },
    },
    {
      kind: "mcp",
      mcpUrl: "https://mcp.asana.com/v2/mcp",
      runtime: { operatorOAuthClient: { configured: true } },
    },
    { kind: "mcp", endpointUrl: "https://mcp.linear.app/mcp", runtime: {} },
    {
      kind: "api",
      mcpUrl: "https://api.x.com/2",
      runtime: { operatorOAuthClient: { configured: false } },
    },
  ];

  test("collects only MCP hosts whose operator OAuth client is missing", () => {
    expect([...mcpHostsDeploymentCannotConnect(catalog)]).toEqual(["mcp.dropbox.com"]);
  });

  test("a bundled server on such a host cannot connect here; others are unaffected", () => {
    const cannotConnectHosts = mcpHostsDeploymentCannotConnect(catalog);
    expect(
      pluginMcpUnavailableReason(
        { endpoint: "https://mcp.dropbox.com/mcp", transport: "http" },
        { cannotConnectHosts },
      ),
    ).toBe("The provider only accepts apps it has approved");
    expect(
      pluginMcpUnavailableReason(
        { endpoint: "https://mcp.linear.app/mcp", transport: "http" },
        { cannotConnectHosts },
      ),
    ).toBeNull();
    // Without deployment facts the rule is unchanged.
    expect(pluginMcpUnavailableReason({ endpoint: "https://mcp.dropbox.com/mcp" })).toBeNull();
  });
});
