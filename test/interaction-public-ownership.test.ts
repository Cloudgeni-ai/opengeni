import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

async function source(path: string): Promise<string> {
  return await readFile(join(repositoryRoot, path), "utf8");
}

describe("public Browser/Computer ownership", () => {
  test("keeps apps/web as a thin SandboxWorkspace adapter", async () => {
    const adapter = await source("apps/web/src/components/session/sandbox-workspace.tsx");

    expect(adapter).toContain('from "@opengeni/react"');
    expect(adapter).toContain("<SandboxWorkspace");
    expect(adapter).not.toMatch(/@opengeni\/(?:react|sdk)\/interaction/u);
    expect(adapter).not.toMatch(
      /(?:BrowserViewer|ComputerViewer|useBrowserSessions|useComputerSessions)/u,
    );
    expect(adapter).not.toMatch(/packages\/react\/src|packages\/sdk\/src/u);
  });

  test("runs standalone and workbench demos through published SDK/React entrypoints", async () => {
    const [browser, computer, workbench] = await Promise.all([
      source("packages/react/demo/browser-harness.tsx"),
      source("packages/react/demo/computer-harness.tsx"),
      source("packages/react/demo/workbench-embed-harness.tsx"),
    ]);

    expect(browser).toContain('from "@opengeni/react/interaction"');
    expect(browser).toContain("<BrowserViewer");
    expect(computer).toContain('from "@opengeni/react/interaction"');
    expect(computer).toContain("<ComputerViewer");
    expect(workbench).toContain('from "@opengeni/react"');
    expect(workbench).toContain("<SandboxWorkspace");

    for (const harness of [browser, computer, workbench]) {
      expect(harness).not.toMatch(
        /(?:from\s+|import\s*)["'][^"']*(?:\.\.\/src|apps\/web)(?:\/|["'])/u,
      );
    }
  });
});
