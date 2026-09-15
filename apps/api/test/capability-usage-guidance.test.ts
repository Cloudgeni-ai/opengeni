import { expect, test } from "bun:test";
import { CapabilityCatalogItem, FIRST_PARTY_REMOTE_MCP_TOOL_NAMES } from "@opengeni/contracts";
import { capabilityUsageGuidance } from "../src/mcp/capability-usage-guidance";

test("only the official hosted Slack MCP receives personal identity guidance", () => {
  for (const [kind, endpointUrl, expected] of [
    ["mcp", "https://mcp.slack.com/mcp", true],
    ["mcp", "https://mcp.slack.com/mcp/", true],
    ["api", "https://mcp.slack.com/mcp", false],
    ["mcp", "https://slack.com/api", false],
    ["mcp", "https://mcp.slack.com.attacker.example/mcp", false],
    ["mcp", "https://example.com/mcp", false],
  ] as const) {
    const item = CapabilityCatalogItem.parse({
      id: "test",
      kind,
      source: "manual",
      name: "Slack",
      endpointUrl,
    });
    const usage = capabilityUsageGuidance(item);
    expect(usage?.identity === "personal_user").toBe(expected);
    if (usage) {
      for (const tool of usage.alternative.discoveryTools) {
        expect(FIRST_PARTY_REMOTE_MCP_TOOL_NAMES as readonly string[]).toContain(tool);
      }
    }
  }
});
