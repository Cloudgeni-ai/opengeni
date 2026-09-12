import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import config from "../packages/db/tsup.config";
import { rewriteEntryPointsToDist } from "./rewrite-entry-points";

test("every public DB source subpath has a matching runtime build entry", async () => {
  const directory = join(import.meta.dir, "../packages/db");
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const resolved = typeof config === "function" ? await config({}) : config;
  const configs = Array.isArray(resolved) ? resolved : [resolved];
  const entries = Object.assign({}, ...configs.map((item) => item.entry));
  const published = structuredClone(manifest);
  rewriteEntryPointsToDist(published);

  for (const [subpath, value] of Object.entries(manifest.exports)) {
    const source = value as { types?: string; import?: string; default?: string };
    const runtime = source.import ?? source.default;
    if (!runtime?.startsWith("./src/") || !runtime.endsWith(".ts")) continue;
    const name = runtime.slice("./src/".length, -".ts".length);
    expect(entries[name], `${subpath} runtime build entry`).toBe(runtime.slice(2));
    expect(existsSync(join(directory, runtime))).toBe(true);
    const emittedRuntime = published.exports[subpath].import ?? published.exports[subpath].default;
    expect(emittedRuntime).toBe(`./dist/${name}.js`);
    expect(published.exports[subpath].types).toBe(`./dist/${name}.d.ts`);
    // Unit shards need no dist. Repeat after the canonical package build to
    // verify the actual shipped runtime and declaration artifacts as well.
    if (process.env.OPENGENI_VERIFY_BUILT_EMBEDDING_PACKAGES === "1") {
      expect(existsSync(join(directory, emittedRuntime)), subpath).toBe(true);
      expect(existsSync(join(directory, published.exports[subpath].types)), subpath).toBe(true);
    }
  }
});
