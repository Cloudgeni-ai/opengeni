import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const renderSubpath = "@opengeni/artifact-tool/document/render";
const docxSubpath = "@opengeni/artifact-tool/document/docx";

describe("document browser closure", () => {
  test("keeps renderers and DOCX code outside the authoring entry", async () => {
    const result = await Bun.build({
      entrypoints: [join(packageRoot, "src/document.ts")],
      external: [renderSubpath, docxSubpath],
      format: "esm",
      minify: true,
      splitting: true,
      target: "browser",
    });

    expect(result.success).toBe(true);
    const browserClosure = (
      await Promise.all(result.outputs.map(async (output) => await output.text()))
    ).join("\n");

    expect(browserClosure).toContain(renderSubpath);
    expect(browserClosure).toContain(docxSubpath);
    expect(browserClosure).not.toContain('from"docx"');
    expect(browserClosure).not.toContain("@resvg/resvg-js");
  });

  test("does not resolve the Node inflate fallback into the browser DOCX graph", async () => {
    const resolvedNodeImports = new Set<string>();
    const result = await Bun.build({
      entrypoints: [join(packageRoot, "src/document-docx-codec.ts")],
      external: ["docx", "@resvg/resvg-js"],
      format: "esm",
      minify: true,
      splitting: true,
      target: "browser",
      plugins: [
        {
          name: "document-node-closure-audit",
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
    expect(result.outputs.reduce((bytes, output) => bytes + output.size, 0)).toBeLessThan(200_000);
  });
});
