import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { ToolRef } from "@opengeni/contracts";
import { goalContinuationPrompt, withCodexAppsTool } from "../src/activities/goals";

describe("goalContinuationPrompt", () => {
  test("continues from durable context instead of restarting turn housekeeping", () => {
    const prompt = goalContinuationPrompt(
      {
        text: "Ship the fix",
        successCriteria: "Tests pass",
      } as Parameters<typeof goalContinuationPrompt>[0],
      3,
      null,
    );

    expect(prompt).toContain("[GOAL CONTINUATION 3]");
    expect(prompt).toContain(
      "Do not repeat completed session setup, persistent metadata settings, or context checks",
    );
  });
});

describe("withCodexAppsTool", () => {
  const appsServer = {
    id: "codex_apps",
    name: "codex_apps",
    url: "https://chatgpt.com/backend-api/ps/mcp",
    cacheToolsList: false,
  };

  test("appends the codex_apps ToolRef when the server is configured", () => {
    const settings = testSettings({ mcpServers: [appsServer] });
    const result = withCodexAppsTool(settings, []);
    expect(result).toContainEqual({ kind: "mcp", id: "codex_apps" });
  });

  test("is a no-op when the codex_apps server is not configured (every non-codex turn)", () => {
    const settings = testSettings({ mcpServers: [] });
    const tools: ToolRef[] = [{ kind: "mcp", id: "opengeni" }];
    const result = withCodexAppsTool(settings, tools);
    expect(result).toBe(tools); // same reference, untouched
  });

  test("is idempotent — does not double-add when already present", () => {
    const settings = testSettings({ mcpServers: [appsServer] });
    const once = withCodexAppsTool(settings, []);
    const twice = withCodexAppsTool(settings, once);
    expect(twice.filter((t) => t.kind === "mcp" && t.id === "codex_apps")).toHaveLength(1);
  });
});
