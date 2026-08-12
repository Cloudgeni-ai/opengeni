import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const BUILD_FIXTURE = resolve(import.meta.dir, "fixtures/artifact-public-boundary-build.ts");
const ENTRIES = {
  document: "src/artifacts-document.ts",
  presentation: "src/artifacts-presentation.ts",
  spreadsheet: "src/artifacts-spreadsheet.ts",
} as const;

async function buildBrowserBoundary(entry: string): Promise<string> {
  // Bun.build shares process-global loader state with bun:test. Keep this public
  // closure proof isolated from unrelated package tests and their module state.
  const child = Bun.spawn([process.execPath, BUILD_FIXTURE, resolve(PACKAGE_ROOT, entry)], {
    cwd: PACKAGE_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errorOutput, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(errorOutput || `Artifact boundary build exited with code ${exitCode}`);
  }
  return output;
}

describe("artifact public browser boundaries", () => {
  test("unified workbench is exported without the artifact tool runtime", async () => {
    const output = await buildBrowserBoundary("src/artifacts.ts");

    expect(output).toContain("EditableArtifactWorkbench");
    expect(output).toContain("BrowserEditableArtifactWorkbench");
    expect(output).not.toContain("@opengeni/artifact-tool");
  });

  for (const [modality, entry] of Object.entries(ENTRIES)) {
    test(`${modality} entry is isolated and artifact-runtime-free`, async () => {
      const output = await buildBrowserBoundary(entry);

      expect(output).not.toContain("@opengeni/artifact-tool");
      expect(output).not.toContain("@opengeni/contracts");
      for (const other of Object.keys(ENTRIES)) {
        if (other !== modality) expect(output).not.toContain(`data-og-${other}-editor`);
      }
    });
  }
});
