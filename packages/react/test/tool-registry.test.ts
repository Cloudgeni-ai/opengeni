import { describe, expect, test } from "bun:test";
import { createDefaultToolRegistry } from "../src/timeline/tool-renderers";
import { mcpToolLeaf, toolMatchesLeaf } from "../src/timeline/tool-display-name";
import type { ToolCallItem } from "../src/timeline/types";

function tool(partial: Partial<ToolCallItem> & Pick<ToolCallItem, "name">): ToolCallItem {
  return {
    kind: "tool-call",
    id: "t1",
    turnId: null,
    callId: "c1",
    arguments: null,
    output: undefined,
    raw: undefined,
    status: "complete",
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("mcpToolLeaf / toolMatchesLeaf", () => {
  test("leaf after first __", () => {
    expect(mcpToolLeaf("opengeni__environment_set_variable")).toBe("environment_set_variable");
    expect(mcpToolLeaf("apply_patch")).toBe("apply_patch");
  });

  test("matches exact or prefixed leaf only", () => {
    expect(toolMatchesLeaf("opengeni__session_create", "session_create")).toBe(true);
    expect(toolMatchesLeaf("session_create", "session_create")).toBe(true);
    expect(toolMatchesLeaf("not_session_create", "session_create")).toBe(false);
  });
});

describe("defaultToolRegistry leaf resolution", () => {
  const registry = createDefaultToolRegistry();

  test("resolves SecretSet for prefixed environment_set_variable", () => {
    const a = registry.resolve(tool({ name: "environment_set_variable" }));
    const b = registry.resolve(tool({ name: "opengeni__environment_set_variable" }));
    const c = registry.resolve(tool({ name: "opengeni__variable_set_set_variable" }));
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a.name).toBe("SecretSetRenderer");
  });

  test("resolves ApplyPatch for function apply_patch name", () => {
    const renderer = registry.resolve(tool({ name: "apply_patch" }));
    expect(renderer.name).toBe("ApplyPatchRenderer");
  });

  test("resolves DocsSearch for knowledge_search leaf", () => {
    const renderer = registry.resolve(tool({ name: "docs__knowledge_search" }));
    expect(renderer.name).toBe("DocsSearchRenderer");
  });

  test("resolves ToolSearch by name and tool_search_call raw type", () => {
    const byName = registry.resolve(tool({ name: "tool_search" }));
    const byRaw = registry.resolve(
      tool({
        name: "tool",
        raw: { type: "tool_search_call", call_id: "c1", arguments: { query: "email" } },
      }),
    );
    expect(byName.name).toBe("ToolSearchRenderer");
    expect(byRaw.name).toBe("ToolSearchRenderer");
  });
});
