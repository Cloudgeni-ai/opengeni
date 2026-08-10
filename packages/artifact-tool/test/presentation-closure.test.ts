import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const renderSubpath = "@opengeni/artifact-tool/presentation/render";
const pptxSubpath = "@opengeni/artifact-tool/presentation/pptx";

describe("presentation browser closure", () => {
  test("keeps renderers and file codecs outside the authoring entry", async () => {
    const result = await Bun.build({
      entrypoints: [join(packageRoot, "src/presentation.ts")],
      external: [renderSubpath, pptxSubpath],
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
    expect(browserClosure).toContain(pptxSubpath);
    expect(browserClosure).not.toContain("pptxgenjs");
    expect(browserClosure).not.toContain("@resvg/resvg-js");
    expect(browserClosure).not.toContain('"sharp"');
  });
});
