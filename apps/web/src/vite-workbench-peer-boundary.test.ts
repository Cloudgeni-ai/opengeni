import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("web workbench peer-state chunk boundary", () => {
  test("initializes registration state before route-level peer setup", async () => {
    const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const stateGroup = viteConfig.match(/name: "workbench-peer-state",[\s\S]*?priority: (\d+),/u);
    const pattern = stateGroup?.[0].match(/test: \/(.+)\/,/u)?.[1];
    expect(pattern).toBeDefined();
    expect(stateGroup?.[0]).toContain("includeDependenciesRecursively: false");

    const stateTest = new RegExp(pattern!);
    for (const separator of ["/", "\\"]) {
      const moduleId = (relative: string) => `/repo/${relative}`.replaceAll("/", separator);
      expect(stateTest.test(moduleId("packages/react/src/lib/workbench-peers.ts"))).toBe(true);
      for (const relative of [
        "packages/react/src/terminal.ts",
        "packages/react/src/editor.ts",
        "packages/react/src/desktop.ts",
        "packages/react/src/components/sandbox-terminal.tsx",
        "apps/web/src/routes/session.tsx",
      ]) {
        expect(stateTest.test(moduleId(relative))).toBe(false);
      }
    }

    const sessionPriority = viteConfig.match(/name: "session",[\s\S]*?priority: (\d+),/u)?.[1];
    expect(Number(stateGroup?.[1])).toBeGreaterThan(Number(sessionPriority));

    // This state must remain a leaf: component re-exports or runtime imports
    // could recreate the cycle that called an uninitialized registration callback.
    const state = await readFile(
      new URL("../../../packages/react/src/lib/workbench-peers.ts", import.meta.url),
      "utf8",
    );
    expect(state).not.toMatch(/^\s*import\s+(?!type\b)/mu);
    expect(state).not.toMatch(/\b(?:import|require)\s*\(/u);
    expect(state).not.toMatch(/^\s*export\s+.*\bfrom\s+["']/mu);
  });
});
