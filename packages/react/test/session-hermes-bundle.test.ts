import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { default: generate } = require("@babel/generator") as {
  default(ast: unknown, options?: Record<string, unknown>, source?: string): { code: string };
};
const metroTransformer = require("@react-native/metro-babel-transformer") as {
  transform(input: {
    filename: string;
    src: string;
    options: Record<string, unknown>;
    plugins: unknown[];
  }): { ast: unknown };
};
const { parse } = require("hermes-parser") as {
  parse(source: string, options: { sourceType: "script" }): unknown;
};

const repoRoot = resolve(import.meta.dir, "../../..");
const projectionPath = join(repoRoot, "packages/react/src/timeline/projection.ts");

function metroModule(source: string, filename: string): string {
  const { ast } = metroTransformer.transform({
    filename,
    src: source,
    options: {
      dev: false,
      hot: false,
      minify: false,
      platform: "ios",
      projectRoot: repoRoot,
      enableBabelRCLookup: false,
      enableBabelRuntime: false,
      experimentalImportSupport: false,
      hermesParser: true,
    },
    plugins: [],
  });
  const code = generate(ast, { compact: false }, source).code;
  return `__d(function (global, require, importDefault, importAll, module, exports) {\n${code}\n});`;
}

test("the session timeline is parseable after React Native's Metro transform", async () => {
  const source = await readFile(projectionPath, "utf8");
  const bundleModule = metroModule(source, projectionPath);

  expect(bundleModule).toContain("buildTimeline");
  expect(() => parse(bundleModule, { sourceType: "script" })).not.toThrow();
});

test("the Hermes gate rejects Metro output containing top-level await", () => {
  const plantedSource =
    'const { default: dependency } = await import("./dependency");\nexport { dependency };';
  const bundleModule = metroModule(plantedSource, join(repoRoot, "planted-top-level-await.ts"));

  expect(bundleModule).toContain("await import");
  expect(() => parse(bundleModule, { sourceType: "script" })).toThrow();
});
