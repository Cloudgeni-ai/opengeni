import { describe, expect, test } from "bun:test";
import { getDefaultSandboxInstructions } from "@openai/agents/sandbox";

import { sandboxBaseInstructions } from "../src/sandbox-base-instructions";

describe("sandbox base instructions", () => {
  test("do not tell agents to look for AGENTS.md files", () => {
    const base = sandboxBaseInstructions();
    expect(base).not.toContain("Look for AGENTS.md");
  });

  test("keep every other SDK default line, extending two in place, so SDK updates still flow through", () => {
    const sdkLines = getDefaultSandboxInstructions().split("\n");
    const base = sandboxBaseInstructions();
    const filesystem = base.indexOf("\n\n# Filesystem\n");
    expect(filesystem).toBeGreaterThan(0);
    const baseLines = base.slice(0, filesystem).split("\n");
    const removed = sdkLines.filter((line) => line.startsWith("- Look for AGENTS.md"));
    expect(removed).toHaveLength(1);
    const kept = sdkLines
      .filter((line) => !removed.includes(line))
      .join("\n")
      .trimEnd()
      .split("\n");
    expect(baseLines).toHaveLength(kept.length);
    const extended = kept.filter((line, index) => baseLines[index] !== line);
    expect(extended).toEqual([
      "- Make changes inside the workspace unless the user explicitly asks for another location.",
      "- Verify changes when practical, especially after editing code, tests, build scripts, generated artifacts, or configuration.",
    ]);
    kept.forEach((line, index) => expect(baseLines[index]!.startsWith(line)).toBe(true));
  });

  test("close with a filesystem section that names no machine, so a machine swap keeps the prompt", () => {
    const base = sandboxBaseInstructions();
    expect(base.endsWith("supersedes it.\n")).toBe(true);
    const section = base.slice(base.indexOf("# Filesystem\n"));
    expect(section).toContain("<opengeni_workspace_filesystem>");
    expect(section).not.toContain("/workspace");
  });

  test("keep the agent's own scratch work out of the user's project", () => {
    const base = sandboxBaseInstructions();
    expect(base).toContain("Keep your own scratch work out of the user's project");
    expect(base).toContain("in a temporary directory outside it, and remove them when done");
    // Tests the user asked for or the project expects are still welcome in it.
    expect(base).toContain("Tests the user asked for or the project expects belong in it.");
  });

  test("finish changes to running systems on the running instance", () => {
    const base = sandboxBaseInstructions();
    expect(base).toContain("restart or reload the process that actually serves it");
    expect(base).toContain("exercise the real entry point");
    expect(base).toContain("unit tests alone do not show it works");
    // A restart that could hurt others or lose work still needs a yes first.
    expect(base).toContain(
      "Ask first only if a restart could disrupt others or lose work in progress.",
    );
  });

  test("are the same text on every call, so the prompt prefix stays cacheable", () => {
    expect(sandboxBaseInstructions()).toBe(sandboxBaseInstructions());
  });
});
