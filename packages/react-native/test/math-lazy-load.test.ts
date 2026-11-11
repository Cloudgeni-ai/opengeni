import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "bun:test";

import manifest from "../package.json" with { type: "json" };

type TsupOptions = Record<string, unknown>;

const packageDirectory = join(import.meta.dir, "..");

// MathJax touches the global `document` as its modules load, and React Native's is
// partial, so loading it as a chat opens crashes release builds. The timeline requires
// the math engine only when a message first shows math; this checks the published build
// keeps it that way: a static import of an external MathJax module would be hoisted to
// the top of the timeline module and evaluated with it.
test("the built markdown timeline loads MathJax only when math first renders", async () => {
  expect(Object.keys(manifest.dependencies)).not.toContain("mathjax-full");

  const { build } = (await import(
    pathToFileURL(Bun.resolveSync("tsup", packageDirectory)).href
  )) as { build(options: TsupOptions): Promise<unknown> };
  const { default: config } = (await import("../tsup.config")) as { default: TsupOptions };
  const outDir = await mkdtemp(join(tmpdir(), "opengeni-rn-math-"));
  try {
    await build({
      ...config,
      entry: [join(packageDirectory, "src/timeline/markdown.tsx")],
      outDir,
      sourcemap: false,
      clean: false,
      dts: false,
      silent: true,
    });
    const files = (await readdir(outDir)).filter((name) => name.endsWith(".js"));
    expect(files).toContain("markdown.js");
    for (const file of files) {
      const source = await readFile(join(outDir, file), "utf8");
      const imported = [...source.matchAll(/^import\s(?:[^'"]*?\sfrom\s)?['"]([^'"]+)['"]/gm)].map(
        (match) => match[1],
      );
      expect(imported.filter((specifier) => specifier?.startsWith("mathjax-full"))).toEqual([]);
    }
    const markdown = await readFile(join(outDir, "markdown.js"), "utf8");
    // The math engine is bundled behind a lazy initializer rather than run on load.
    expect(markdown).toMatch(/init_math_engine = __esm\(/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}, 60_000);
