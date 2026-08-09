import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const xlsxSubpath = "@opengeni/artifact-tool/spreadsheet/xlsx";

describe("spreadsheet browser closure", () => {
  test("keeps ExcelJS and XML parsing outside the file facade", async () => {
    const result = await Bun.build({
      entrypoints: [join(packageRoot, "src/spreadsheet-file.ts")],
      external: [xlsxSubpath],
      format: "esm",
      minify: true,
      splitting: true,
      target: "browser",
    });

    expect(result.success).toBe(true);
    const browserClosure = (
      await Promise.all(result.outputs.map(async (output) => await output.text()))
    ).join("\n");
    expect(browserClosure).toContain(xlsxSubpath);
    expect(browserClosure).not.toContain("exceljs");
    expect(browserClosure).not.toContain("saxes");
  });

  test("keeps the explicit XLSX codec bounded and free of Node-only imports", async () => {
    const resolvedNodeImports = new Set<string>();
    const result = await Bun.build({
      entrypoints: [join(packageRoot, "src/spreadsheet-xlsx-codec.ts")],
      external: ["exceljs"],
      format: "esm",
      minify: true,
      splitting: true,
      target: "browser",
      plugins: [
        {
          name: "spreadsheet-node-closure-audit",
          setup(build): void {
            build.onResolve({ filter: /^node:/ }, (args) => {
              resolvedNodeImports.add(args.path);
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });

    expect(result.success).toBe(true);
    expect([...resolvedNodeImports]).toEqual([]);
    expect(result.outputs.reduce((bytes, output) => bytes + output.size, 0)).toBeLessThan(250_000);
  });
});
