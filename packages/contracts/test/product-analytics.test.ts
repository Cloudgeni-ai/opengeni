import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ANALYTICS_MODEL_PROVIDERS,
  SESSION_TURN_SURFACES,
  TOOL_FAMILY_INTEGRATION_DOMAINS,
  ToolFamily,
  analyticsModelProvider,
  firstPartyToolFamily,
  integrationToolFamily,
  sessionTurnSurfaceOrNull,
} from "../src/index";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("product analytics dimensions", () => {
  test("turn surfaces parse only from the fixed list", () => {
    for (const surface of SESSION_TURN_SURFACES) {
      expect(sessionTurnSurfaceOrNull(surface)).toBe(surface);
    }
    expect(sessionTurnSurfaceOrNull("email")).toBeNull();
    expect(sessionTurnSurfaceOrNull(null)).toBeNull();
    expect(sessionTurnSurfaceOrNull(undefined)).toBeNull();
  });

  test("model providers keep reserved ids and fold every operator-configured id into registry", () => {
    expect(analyticsModelProvider("codex-subscription")).toBe("codex-subscription");
    expect(analyticsModelProvider("supergrok-subscription")).toBe("supergrok-subscription");
    expect(analyticsModelProvider("workspace-openrouter")).toBe("workspace-openrouter");
    expect(analyticsModelProvider("self-hosted-llm")).toBe("registry");
    expect(analyticsModelProvider("has spaces")).toBeNull();
    expect(analyticsModelProvider(null)).toBeNull();
  });

  test("integration families expose only reviewed domains", () => {
    expect(integrationToolFamily(["mcp.linear.app"])).toBe("integration:mcp.linear.app");
    expect(integrationToolFamily(["GitHub.com."])).toBe("integration:github.com");
    // The first reviewed candidate wins; a tenant host never becomes a value.
    expect(integrationToolFamily(["gitlab.internal.example", "gitlab.com"])).toBe(
      "integration:gitlab.com",
    );
    expect(integrationToolFamily(["tenant.atlassian.net"])).toBe("custom");
    expect(integrationToolFamily([null, undefined, ""])).toBe("custom");
  });

  test("every curated catalog MCP host is a reviewed integration domain", () => {
    const curated = JSON.parse(readFileSync(`${repoRoot}data/catalog/curated.json`, "utf8")) as {
      entries: Array<{ mcpUrl: string }>;
    };
    const reviewed = new Set<string>(TOOL_FAMILY_INTEGRATION_DOMAINS);
    const missing = curated.entries
      .map((entry) => new URL(entry.mcpUrl).hostname)
      .filter((host) => !reviewed.has(host));
    expect(missing).toEqual([]);
    for (const domain of TOOL_FAMILY_INTEGRATION_DOMAINS) {
      expect(ToolFamily.safeParse(`integration:${domain}`).success).toBe(true);
    }
  });

  test("first-party families come from OpenGeni's own fixed names only", () => {
    expect(firstPartyToolFamily("goal_set")).toBe("goal_set");
    expect(firstPartyToolFamily("exec_command")).toBe("exec_command");
    expect(firstPartyToolFamily("skill_checkout")).toBe("skill_checkout");
    expect(firstPartyToolFamily("web_search_call")).toBe("web_search_call");
    expect(firstPartyToolFamily("opengeni__goal_set")).toBeNull();
    expect(firstPartyToolFamily("make_invoice_for_customer")).toBeNull();
    expect(firstPartyToolFamily(undefined)).toBeNull();
  });

  test("the tool-family wire format rejects free text", () => {
    expect(ToolFamily.safeParse("custom").success).toBe(true);
    expect(ToolFamily.safeParse("exec_command").success).toBe(true);
    expect(ToolFamily.safeParse("integration:Customer Host").success).toBe(false);
    expect(ToolFamily.safeParse("Exec Command").success).toBe(false);
  });

  test("migration 0533 mirrors the fixed lists", () => {
    const sql = readFileSync(
      `${repoRoot}packages/db/drizzle/0533_turn_surface_analytics.sql`,
      "utf8",
    );
    for (const surface of SESSION_TURN_SURFACES) expect(sql).toContain(`'${surface}'`);
    for (const provider of ANALYTICS_MODEL_PROVIDERS) expect(sql).toContain(`'${provider}'`);
  });
});
