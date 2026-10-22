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
  test("skill steps say skill and name which one", () => {
    const skillOutput = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            skillId: "3e8b5d21-7c4a-4f9e-b6d2-1a0c9e8f7b53",
            files: [
              {
                path: "SKILL.md",
                content:
                  "---\nname: operate-smart-home\ndescription: Use for the house.\n---\n# Home",
              },
            ],
          }),
        },
      ],
    };
    const read = toolRowPresentation(
      englishText,
      call({
        name: "skill_read",
        arguments: { skill: "3e8b5d21-7c4a-4f9e-b6d2-1a0c9e8f7b53" },
        output: skillOutput,
      }),
    );
    expect(read.title).toBe("Read skill");
    expect(read.preview).toEqual({ kind: "text", text: "Operate smart home" });
    const running = toolRowPresentation(
      englishText,
      call({ name: "skill_read", status: "running", arguments: { skill: "builtin:documents" } }),
    );
    expect(running.title).toBe("Reading skill");
    expect(running.preview).toMatchObject({ text: "Documents" });
    const byId = toolRowPresentation(
      englishText,
      call({
        name: "skill_read",
        arguments: { skill: "3e8b5d21-7c4a-4f9e-b6d2-1a0c9e8f7b53" },
        output: { content: [{ type: "text", text: '{"alreadyInContext":true}' }] },
      }),
    );
    expect(byId.preview).toEqual({ kind: "text", text: "Done" });
    const search = toolRowPresentation(
      englishText,
      call({ name: "skill_search", arguments: { query: "excel" }, output: "[]" }),
    );
    expect(search.title).toBe("Searched skills");
    expect(search.preview).toEqual({ kind: "text", text: "excel" });
    const preview = (skill: string, content: string) =>
      toolRowPresentation(
        englishText,
        call({
          name: "skill_read",
          arguments: { skill },
          output: {
            content: [
              { type: "text", text: JSON.stringify({ files: [{ path: "SKILL.md", content }] }) },
            ],
          },
        }),
      ).preview;
    const id = "3e8b5d21-7c4a-4f9e-b6d2-1a0c9e8f7b53";
    expect(preview(id, '---\r\nname: "quoted-name"\r\n---\r\n# Body')).toMatchObject({
      text: "Quoted name",
    });
    expect(preview(id, "---\ndescription: none\n---\nname: body-line\n")).toEqual({
      kind: "text",
      text: "Done",
    });
    expect(preview(`builtin:${id}`, "no front matter")).toEqual({ kind: "text", text: "Done" });
  });

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
    expect(title.icon).toBe("rename");
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

  test("screen-driver and discovery steps read as plain steps too", () => {
    const row = (partial: Partial<ToolCallItem> & Pick<ToolCallItem, "name">) =>
      toolRowPresentation(englishText, call(partial));
    expect(row({ name: "interaction__interaction_discover" })).toMatchObject({
      tool: "machine",
      title: "Looked for a screen to use",
      icon: "screen",
    });
    expect(row({ name: "interaction__cua_get_desktop_state" }).title).toBe("Looked at the screen");
    expect(row({ name: "interaction__cua_click" }).title).toBe("Clicked on the screen");
    expect(row({ name: "interaction__cua_type_text" }).title).toBe("Typed on the keyboard");
    expect(row({ name: "interaction__cua_launch_app" }).title).toBe("Used the screen");
  });

  test("a screen step that didn't work says so without a raw error preview", () => {
    const failedOpen = toolRowPresentation(
      englishText,
      call({
        name: "interaction__computer_open",
        output: JSON.stringify({
          error: { code: "validation_failed", message: "Opengeni API 422: not placed here." },
        }),
        status: "failed",
      }),
    );
    expect(failedOpen.title).toBe("Couldn't open the screen");
    expect(failedOpen.chip).toEqual({ tone: "bad", text: "error" });
    expect(failedOpen.preview).toBeUndefined();
    expect(failedOpen.body).toMatchObject({
      kind: "payloads",
      blocks: [{ label: "Arguments" }, { label: "Error", failed: true }],
    });
    expect(
      toolRowPresentation(englishText, call({ name: "sandbox_swap", status: "failed" })).title,
    ).toBe("Couldn't move to the machine");
    expect(
      toolRowPresentation(
        englishText,
        call({ name: "interaction__cua_get_desktop_state", status: "failed" }),
      ).title,
    ).toBe("Couldn't use the screen");
  });

  test("platform plumbing tools get plain names", () => {
    expect(toolRowPresentation(englishText, call({ name: "tool_list" })).title).toBe(
      "Looked up tools",
    );
    expect(
      toolRowPresentation(englishText, call({ name: "opengeni__sandbox_file_publish" })).title,
    ).toBe("Shared a file");
  });

  test("error previews show the readable message, not the transport wrapper", () => {
    const wrapped = toolRowPresentation(
      englishText,
      call({
        name: "issues_create",
        status: "failed",
        output:
          'An error occurred while running the tool. Please try again. Error: Example API 409: {"error":{"code":"conflict","message":"The issue already exists. Reference: 0f2c1a7e-1111-4222-8333-944445555666."}}',
      }),
    );
    expect(wrapped.preview).toEqual({ kind: "text", text: "The issue already exists." });
    const neutral = toolRowPresentation(
      englishText,
      call({
        name: "issues_create",
        status: "failed",
        output: "API 500: The workspace could not complete the request. Reference: req_tool_1.",
      }),
    );
    expect(neutral.preview).toEqual({
      kind: "text",
      text: "The workspace could not complete the request.",
    });
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
    expect(plain.title).toBe("Used a tool");
  });
});
