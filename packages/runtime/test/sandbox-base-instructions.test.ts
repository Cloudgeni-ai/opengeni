import { describe, expect, test } from "bun:test";
import { getDefaultSandboxInstructions } from "@openai/agents/sandbox";

import { sandboxBaseInstructions } from "../src/sandbox-base-instructions";

describe("sandbox base instructions", () => {
  test("do not tell agents to look for AGENTS.md files", () => {
    const base = sandboxBaseInstructions();
    expect(base).not.toContain("Look for AGENTS.md");
  });

  test("keep every other SDK default line, so SDK updates still flow through", () => {
    const sdkLines = getDefaultSandboxInstructions().split("\n");
    const baseLines = sandboxBaseInstructions().split("\n");
    const removed = sdkLines.filter((line) => line.startsWith("- Look for AGENTS.md"));
    expect(removed).toHaveLength(1);
    expect(baseLines).toEqual(sdkLines.filter((line) => !removed.includes(line)));
  });

  test("are the same text on every call, so the prompt prefix stays cacheable", () => {
    expect(sandboxBaseInstructions()).toBe(sandboxBaseInstructions());
  });
});
