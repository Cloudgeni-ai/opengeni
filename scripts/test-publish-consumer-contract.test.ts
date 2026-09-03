import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const scriptPath = resolve(import.meta.dir, "test-publish-consumer.ts");

describe("publish consumer PostCSS override contract", () => {
  test("requires an exact React PostCSS version and applies it to every clean consumer", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain("const postcssVersion = reactSource.devDependencies?.postcss;");
    expect(source).toContain("!/^\\d+\\.\\d+\\.\\d+$/u.test(postcssVersion)");
    expect(source).toContain(
      'throw new Error("React package must pin an exact PostCSS version for clean consumers")',
    );
    expect(source).not.toContain("postcssOverride");
    expect(source.match(/postcss: postcssVersion,/gu)).toHaveLength(4);
  });
});
