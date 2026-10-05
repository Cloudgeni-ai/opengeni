import { describe, expect, test } from "bun:test";
import { applyDiff } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import {
  withCodexAddFileApplyPatchInput,
  withCodexAddFileDiff,
  withCodexAddFilePatch,
} from "../src/apply-patch-add-file";
import { buildAgentCapabilities } from "../src/index";

// Codex (`codex-rs/apply-patch`) appends "\n" after every "+" line of an Add
// File section; the SDK's V4A create mode does not. These tests pin the Codex
// result through the real SDK parser and `applyDiff`, and pin that Update File
// semantics are unchanged.

type Operation = { type: string; path: string; diff?: string };
type BindableCap = {
  clone: () => BindableCap;
  bind: (session: unknown) => BindableCap;
  bindRunAs: (r?: unknown) => BindableCap;
  bindModel: (m: string, i?: unknown) => BindableCap;
  tools: () => Array<Record<string, any>>;
};

class OpenAIResponsesModel {
  readonly transport = "responses";
}

/** A stub sandbox whose editor applies operations with the SDK's real `applyDiff`. */
function boundApplyPatchTool(structuredToolTransport: boolean) {
  const files = new Map<string, string>([["existing.txt", "one\ntwo\n"]]);
  const operations: Operation[] = [];
  const editor = {
    async createFile(operation: Operation) {
      operations.push(operation);
      files.set(operation.path, applyDiff("", operation.diff!, "create"));
    },
    async updateFile(operation: Operation) {
      operations.push(operation);
      files.set(operation.path, applyDiff(files.get(operation.path) ?? "", operation.diff!));
    },
    async deleteFile(operation: Operation) {
      operations.push(operation);
      files.delete(operation.path);
    },
  };
  const caps = buildAgentCapabilities(testSettings({ sandboxBackend: "docker" }), [], {
    structuredToolTransport,
  });
  const filesystemCap = caps.find(
    (cap) => (cap as { type?: unknown }).type === "filesystem",
  ) as unknown as BindableCap;
  const tool = filesystemCap
    .clone()
    .bind({ createEditor: () => editor, viewImage: async () => "img" })
    .bindRunAs(undefined)
    .bindModel("gpt-5.6-sol", new OpenAIResponsesModel())
    .tools()
    .find((candidate) => candidate.name === "apply_patch")!;
  return { tool, files, operations };
}

const ADD_AND_UPDATE_PATCH = [
  "*** Begin Patch",
  "*** Add File: notes/example.txt",
  "+first line",
  "+second line",
  "*** Update File: existing.txt",
  "@@",
  " one",
  "-two",
  "+three",
  "*** End Patch",
].join("\n");

describe("apply_patch Add File follows Codex trailing-newline semantics", () => {
  test("create diffs gain exactly one trailing newline, like Codex", () => {
    const content = (diff: string) => applyDiff("", withCodexAddFileDiff(diff), "create");
    expect(content("+a\n+b")).toBe("a\nb\n");
    expect(content("+a\n+b\n")).toBe("a\nb\n");
    expect(content("+a\r\n+b\r\n")).toBe("a\nb\n");
    // A trailing blank "+" line is an intentional extra empty line.
    expect(content("+a\n+")).toBe("a\n\n");
    expect(content("+")).toBe("\n");
    expect(withCodexAddFileDiff("")).toBe("");
  });

  test("freeform patches only extend Add File sections", () => {
    expect(withCodexAddFilePatch(ADD_AND_UPDATE_PATCH)).toBe(
      [
        "*** Begin Patch",
        "*** Add File: notes/example.txt",
        "+first line",
        "+second line",
        "+",
        "*** Update File: existing.txt",
        "@@",
        " one",
        "-two",
        "+three",
        "*** End Patch",
      ].join("\n"),
    );
    const updateOnly = "*** Begin Patch\n*** Update File: a\n@@\n-x\n+y\n*** End Patch\n";
    expect(withCodexAddFilePatch(updateOnly)).toBe(updateOnly);
    const notAPatch = "*** Begin Patch\n*** Add File: a\n+x";
    expect(withCodexAddFilePatch(notAPatch)).toBe(notAPatch);
    expect(withCodexAddFileApplyPatchInput("{not json")).toBe("{not json");
  });

  for (const structuredToolTransport of [false, true]) {
    const variant = structuredToolTransport ? "hosted" : "function";
    test(`${variant} apply_patch creates files ending in a newline and keeps Update File unchanged`, async () => {
      const { tool, files, operations } = boundApplyPatchTool(structuredToolTransport);
      if (structuredToolTransport) {
        expect(tool.type).toBe("apply_patch");
        await tool.editor.createFile({
          type: "create_file",
          path: "notes/example.txt",
          diff: "+first line\n+second line\n",
        });
        await tool.editor.updateFile({
          type: "update_file",
          path: "existing.txt",
          diff: "@@\n one\n-two\n+three\n",
        });
      } else {
        expect(tool.type).toBe("function");
        const output = await tool.invoke({}, JSON.stringify({ patch: ADD_AND_UPDATE_PATCH }));
        expect(String(output)).not.toContain("Failed");
      }
      expect(files.get("notes/example.txt")).toBe("first line\nsecond line\n");
      expect(files.get("existing.txt")).toBe("one\nthree\n");
      expect(operations.find((operation) => operation.type === "update_file")?.diff).toBe(
        "@@\n one\n-two\n+three\n",
      );
    });
  }

  test("function apply_patch accepts every SDK input form with Codex Add File content", async () => {
    const inputs = [
      "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch",
      JSON.stringify({
        command: ["apply_patch", "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch"],
      }),
      JSON.stringify({ operations: [{ type: "create_file", path: "a.txt", diff: "+x\n" }] }),
      JSON.stringify({ operation: { type: "create_file", path: "a.txt", diff: "+x" } }),
      JSON.stringify({ type: "create_file", path: "a.txt", diff: "+x\n" }),
      JSON.stringify([{ type: "create_file", path: "a.txt", diff: "+x\n" }]),
    ];
    for (const input of inputs) {
      const { tool, files } = boundApplyPatchTool(false);
      await tool.invoke({}, input);
      expect(files.get("a.txt"), input).toBe("x\n");
    }
  });
});
