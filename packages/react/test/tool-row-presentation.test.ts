import { describe, expect, test } from "bun:test";
import { toolRowPresentation } from "../src/timeline-model";
import type { ToolCallItem } from "../src/timeline/types";
import { createOpenGeniText } from "../src/messages/runtime";

const englishText = createOpenGeniText();

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
      englishText,
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
      toolRowPresentation(
        englishText,
        call({ name: "tool_search", status: "running", arguments: {} }),
      ),
    ).toMatchObject({ title: "Looking up tools", running: true, iconTone: "running" });
    expect(
      toolRowPresentation(
        englishText,
        call({ name: "tool_search", output: "No matching tools found." }),
      ).body,
    ).toMatchObject({ empty: "no deferred tools matched this capability query." });
    expect(
      toolRowPresentation(
        englishText,
        call({ name: "tool_search", status: "failed", output: "boom" }),
      ),
    ).toMatchObject({ title: "Tool lookup failed", failed: true });
  });

  test("docs search counts hits and session titles preview the new title", () => {
    const docs = toolRowPresentation(
      englishText,
      call({
        name: "knowledge_search",
        arguments: { query: "release notes" },
        output: JSON.stringify({ results: [{ title: "Notes", snippet: "v2" }] }),
      }),
    );
    expect(docs.title).toBe("Search \u201crelease notes\u201d");
    expect(docs.preview).toEqual({ kind: "text", text: "1 hit" });
    const title = toolRowPresentation(
      englishText,
      call({ name: "set_session_title", arguments: { title: "Fibonacci script" } }),
    );
    expect(title.icon).toBe("sessions");
    expect(title.preview).toEqual({ kind: "text", text: "Fibonacci script" });
  });

  test("moving between machines and using a screen read as plain steps", () => {
    const row = (partial: Partial<ToolCallItem> & Pick<ToolCallItem, "name">) =>
      toolRowPresentation(englishText, call(partial));
    expect(row({ name: "opengeni__sandboxes_list" }).title).toBe("Looked for machines");
    expect(row({ name: "sandbox_swap", arguments: { target: "m1" } }).title).toBe(
      "Moved to a machine",
    );
    expect(row({ name: "sandbox_swap", arguments: { target: "session" } }).title).toBe(
      "Moved back",
    );
    expect(row({ name: "interaction__computer_open" }).title).toBe("Opened the screen");
    expect(row({ name: "computer_observe" }).title).toBe("Looked at the screen");
    const typed = row({
      name: "computer_act",
      arguments: { action: { type: "keyboard", value: "hello" } },
    });
    expect(typed.title).toBe("Typed on the keyboard");
    expect(typed.preview).toEqual({ kind: "text", text: "\u201chello\u201d" });
    const clicked = row({
      name: "computer_act",
      status: "running",
      arguments: { action: { type: "pointer", locator: { name: "Save" } } },
    });
    expect(clicked.title).toBe("Clicked on the screen");
    expect(clicked.preview).toEqual({ kind: "text", text: "\u201cSave\u201d" });
    expect(row({ name: "computer_act", arguments: {} }).title).toBe("Used the screen");
    const swedish = createOpenGeniText({
      locale: "sv",
      messages: { "timeline.toolPresentation.openedTheScreen": "Öppnade skärmen" },
    });
    expect(toolRowPresentation(swedish, call({ name: "computer_open" })).title).toBe(
      "Öppnade skärmen",
    );
  });

  test("a tool_invoke call reads as the tool it ran", () => {
    const row = toolRowPresentation(
      englishText,
      call({
        name: "tool_invoke",
        arguments: { name: "opengeni__run_on", arguments: { target: "m1", op: "exec", cmd: "ls" } },
      }),
    );
    expect(row.tool).toBe("run_on");
    const plain = toolRowPresentation(englishText, call({ name: "tool_invoke", arguments: {} }));
    expect(plain.title).toBe("Tool invoke");
  });
});
