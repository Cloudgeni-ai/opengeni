import { describe, expect, test } from "bun:test";
import type { AgentSummary, CapabilityCatalogItem, ScheduledTask } from "@opengeni/sdk";

import {
  GUIDED_SETUPS,
  agentForSetup,
  catalogConnectHref,
  catalogItemConnected,
  catalogItemFor,
  guidedSetupByKey,
  setupTriggerOn,
} from "./guided-setups";

function item(overrides: Record<string, unknown>): CapabilityCatalogItem {
  return {
    id: "linear",
    kind: "mcp",
    enabled: false,
    mcpUrl: "https://mcp.linear.app/mcp",
    lifecycle: { readiness: "needs_setup" },
    ...overrides,
  } as unknown as CapabilityCatalogItem;
}

function agent(id: string, templateKey: string | null, canEdit: boolean): AgentSummary {
  return { id, name: id, templateKey, viewer: { canEdit } } as unknown as AgentSummary;
}

describe("guided setups", () => {
  test("at most four, each with a unique key", () => {
    expect(GUIDED_SETUPS.length).toBeLessThanOrEqual(4);
    expect(new Set(GUIDED_SETUPS.map((setup) => setup.key)).size).toBe(GUIDED_SETUPS.length);
    expect(guidedSetupByKey("pr-reviews")?.agentTemplateKey).toBe("pr-reviewer");
    expect(guidedSetupByKey("nope")).toBeNull();
    expect(guidedSetupByKey(undefined)).toBeNull();
  });

  test("finds a catalog connector by its address, preferring one already on", () => {
    const off = item({ id: "off" });
    const on = item({ id: "on", enabled: true, mcpUrl: "HTTPS://mcp.linear.app/mcp/" });
    const other = item({ id: "other", mcpUrl: "https://example.com/mcp" });
    expect(catalogItemFor([off, on, other], "https://mcp.linear.app/mcp")?.id).toBe("on");
    expect(catalogItemFor([off, other], "https://mcp.linear.app/mcp")?.id).toBe("off");
    expect(catalogItemFor([other], "https://mcp.linear.app/mcp")).toBeNull();
  });

  test("a connector counts as connected only when on and ready", () => {
    expect(catalogItemConnected(null)).toBe(false);
    expect(catalogItemConnected(item({ enabled: true }))).toBe(false);
    expect(catalogItemConnected(item({ enabled: true, lifecycle: { readiness: "ready" } }))).toBe(
      true,
    );
  });

  test("picks the agent from the template, one the reader can edit first", () => {
    const setup = { agentTemplateKey: "triage" };
    expect(agentForSetup([agent("a", "pr-reviewer", true)], setup)).toBeNull();
    expect(
      agentForSetup([agent("b", "triage", false), agent("c", "triage", true)], setup)?.id,
    ).toBe("c");
    expect(agentForSetup([agent("b", "triage", false)], setup)?.id).toBe("b");
  });

  test("the trigger is on when the agent has a task named after it", () => {
    const task = (agentId: string, name: string) =>
      ({ name, agentConfig: { agentId } }) as unknown as ScheduledTask;
    const setup = { triggerName: "Every Monday morning" };
    expect(setupTriggerOn([task("a", "Product analyst: Every Monday morning")], "a", setup)).toBe(
      true,
    );
    expect(setupTriggerOn([task("b", "Every Monday morning")], "a", setup)).toBe(false);
    expect(setupTriggerOn([task("a", "Something else")], "a", setup)).toBe(false);
  });

  test("connect links open the connector on Capabilities", () => {
    expect(catalogConnectHref("w 1", "item-1")).toBe(
      "/workspaces/w%201/plugins?open=item%3Aitem-1",
    );
  });
});
