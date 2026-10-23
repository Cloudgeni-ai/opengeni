import { describe, expect, test } from "bun:test";

import { connectorLogo, connectorLogoIndex } from "./connector-logo-index";

const url = (path: string | null | undefined) => (path ? `/v1/${path}` : null);

describe("connectorLogoIndex", () => {
  test("a connector's server host finds the provider's logo", () => {
    const index = connectorLogoIndex(
      [
        {
          providerDomain: "linear.app",
          mcpUrl: "https://mcp.linear.app/mcp",
          logoAssetPath: "logos/linear.png",
        },
        {
          providerDomain: "notion.com",
          connectionRef: { providerDomain: "mcp.notion.com" },
          logoAssetPath: "logos/notion.png",
        },
      ],
      url,
    );
    expect(connectorLogo(index, "mcp.linear.app")).toBe("/v1/logos/linear.png");
    expect(connectorLogo(index, "Linear.app")).toBe("/v1/logos/linear.png");
    expect(connectorLogo(index, "mcp.notion.com")).toBe("/v1/logos/notion.png");
    expect(connectorLogo(index, "example.com")).toBeNull();
  });

  test("a provider's own domain wins over another entry's server host", () => {
    const index = connectorLogoIndex(
      [
        {
          providerDomain: "relay.example",
          mcpUrl: "https://github.com/mcp",
          logoAssetPath: "logos/relay.png",
        },
        { providerDomain: "github.com", logoAssetPath: "logos/github.png" },
        { providerDomain: "nologo.app", logoAssetPath: null },
      ],
      url,
    );
    expect(connectorLogo(index, "github.com")).toBe("/v1/logos/github.png");
    expect(connectorLogo(index, "nologo.app")).toBeNull();
  });
});
