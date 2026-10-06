import { describe, expect, test } from "bun:test";
import { toolRowPresentation } from "../src/timeline-model";
import type { ToolCallItem } from "../src/timeline/types";

function call(partial: Partial<ToolCallItem> & Pick<ToolCallItem, "name">): ToolCallItem {
  return {
    kind: "tool-call",
    id: "t1",
    turnId: null,
    callId: "c1",
    arguments: {},
    output: undefined,
    raw: undefined,
    status: "complete",
    occurredAt: "2026-10-04T00:00:00.000Z",
    ...partial,
  };
}

describe("shared tool row presentation", () => {
  test("tool_search reads as a lookup with the disclosed tools", () => {
    const row = toolRowPresentation(
      call({
        name: "tool_search",
        arguments: { query: "time entries" },
        output: "Disclosed tools: mcp__entries_list, mcp__entries_get",
      }),
    );
    expect(row.title).toBe("Looked up tools");
    expect(row.preview).toEqual({ kind: "text", text: "2 tools · entries_list" });
    expect(row.body).toMatchObject({
      kind: "listing",
      note: "capability query: time entries",
      entries: [
        { title: "entries_list", eyebrow: "mcp", mono: true },
        { title: "entries_get", eyebrow: "mcp", mono: true },
      ],
    });
  });

  test("tool_search running, empty and failed states", () => {
    expect(
      toolRowPresentation(call({ name: "tool_search", status: "running", arguments: {} })),
    ).toMatchObject({ title: "Looking up tools", running: true, iconTone: "running" });
    expect(
      toolRowPresentation(call({ name: "tool_search", output: "No matching tools found." })).body,
    ).toMatchObject({ empty: "no deferred tools matched this capability query." });
    expect(
      toolRowPresentation(call({ name: "tool_search", status: "failed", output: "boom" })),
    ).toMatchObject({ title: "Tool lookup failed", failed: true });
  });

  test("docs search counts hits and session titles preview the new title", () => {
    const docs = toolRowPresentation(
      call({
        name: "knowledge_search",
        arguments: { query: "release notes" },
        output: JSON.stringify({ results: [{ title: "Notes", snippet: "v2" }] }),
      }),
    );
    expect(docs.title).toBe("Search \u201crelease notes\u201d");
    expect(docs.preview).toEqual({ kind: "text", text: "1 hit" });
    const title = toolRowPresentation(
      call({ name: "set_session_title", arguments: { title: "Fibonacci script" } }),
    );
    expect(title.icon).toBe("sessions");
    expect(title.preview).toEqual({ kind: "text", text: "Fibonacci script" });
  });
});
