import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const ENTRIES = {
  document: "src/artifacts-document.ts",
  presentation: "src/artifacts-presentation.ts",
  spreadsheet: "src/artifacts-spreadsheet.ts",
} as const;

describe("artifact public browser boundaries", () => {
  test("unified workbench is exported without the artifact tool runtime", async () => {
    const result = await Bun.build({
      entrypoints: [resolve(PACKAGE_ROOT, "src/artifacts.ts")],
      target: "browser",
      format: "esm",
      splitting: false,
      minify: false,
      external: ["@opengeni/*", "react", "react/*", "lucide-react"],
    });
    expect(result.success).toBe(true);
    const output = (await Promise.all(result.outputs.map((item) => item.text()))).join("\n");

    expect(output).toContain("EditableArtifactWorkbench");
    expect(output).toContain("BrowserEditableArtifactWorkbench");
    expect(output).not.toContain("@opengeni/artifact-tool");
  });

  for (const [modality, entry] of Object.entries(ENTRIES)) {
    test(`${modality} entry is isolated and artifact-runtime-free`, async () => {
      const result = await Bun.build({
        entrypoints: [resolve(PACKAGE_ROOT, entry)],
        target: "browser",
        format: "esm",
        splitting: false,
        minify: false,
        external: ["@opengeni/*", "react", "react/*", "lucide-react"],
      });
      expect(result.success).toBe(true);
      const output = (await Promise.all(result.outputs.map((item) => item.text()))).join("\n");

      expect(output).not.toContain("@opengeni/artifact-tool");
      expect(output).not.toContain("@opengeni/contracts");
      for (const other of Object.keys(ENTRIES)) {
        if (other !== modality) expect(output).not.toContain(`data-og-${other}-editor`);
      }
    });
  }
});
