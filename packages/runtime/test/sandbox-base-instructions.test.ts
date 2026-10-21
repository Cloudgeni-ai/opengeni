import { describe, expect, test } from "bun:test";
import { getDefaultSandboxInstructions } from "@openai/agents/sandbox";

import { sandboxBaseInstructions } from "../src/sandbox-base-instructions";

describe("sandbox base instructions", () => {
  test("look for AGENTS.md only in a code repository", () => {
    const base = sandboxBaseInstructions();
    expect(base).toContain(
      "- In a code repository, look for AGENTS.md files that apply to the files you are reading or editing. A workspace with no repository has none, so do not search for them there.",
    );
    expect(base).not.toContain(
      "- Look for AGENTS.md files that apply to the files you are reading or editing.",
    );
  });

  test("keep every other SDK default line, so SDK updates still flow through", () => {
    const sdkLines = getDefaultSandboxInstructions().split("\n");
    const baseLines = sandboxBaseInstructions().split("\n");
    expect(baseLines).toHaveLength(sdkLines.length);
    const changed = baseLines.filter((line, index) => line !== sdkLines[index]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toStartWith("- In a code repository, look for AGENTS.md");
  });

  test("are the same text on every call, so the prompt prefix stays cacheable", () => {
    expect(sandboxBaseInstructions()).toBe(sandboxBaseInstructions());
  });
});
