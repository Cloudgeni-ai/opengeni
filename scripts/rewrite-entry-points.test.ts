import { describe, expect, test } from "bun:test";
import { rewriteEntryPointsToDist, rewriteEntryPointsToSrc } from "./rewrite-entry-points";
import type { PackageJson } from "./publishable-workspaces";

describe("release entry-point rewriting", () => {
  test("round-trips source entries without mutating CSS or dual conditions", () => {
    const source = {
      name: "@opengeni/rewrite-fixture",
      main: "./src/index.ts",
      module: "./src/index.ts",
      types: "./src/index.ts",
      bin: {
        "opengeni-fixture": "./src/cli.ts",
      },
      exports: {
        ".": { types: "./src/index.ts", default: "./src/index.ts" },
        "./dual": {
          types: "./src/dual.ts",
          import: "./src/dual.ts",
          default: "./src/dual.ts",
        },
        "./compiled.css": {
          types: "./styles/compiled.d.ts",
          style: "./styles/compiled.css",
          default: "./styles/compiled.css",
        },
      },
    } satisfies PackageJson;
    const manifest = structuredClone(source);

    expect(rewriteEntryPointsToDist(manifest)).toBe(true);
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./dual": {
        types: "./dist/dual.d.ts",
        import: "./dist/dual.js",
        default: "./dist/dual.js",
      },
      "./compiled.css": source.exports["./compiled.css"],
    });
    expect(manifest.bin).toEqual({ "opengeni-fixture": "./dist/cli.js" });
    expect(rewriteEntryPointsToDist(manifest)).toBe(false);

    expect(rewriteEntryPointsToSrc(manifest)).toBe(true);
    expect(manifest).toEqual(source);
    expect(rewriteEntryPointsToSrc(manifest)).toBe(false);
  });
});
