import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * This package spawns an operator-installed pass-cli, so only the server
 * processes may load it: apps/api and apps/worker, through `import()`.
 */
const REPO = resolve(import.meta.dir, "../../..");
const PACKAGE = "@opengeni/vaults-protonpass";
const PACKAGE_DIR = "packages/vaults-protonpass/";
const LOADERS = ["apps/api/", "apps/worker/"];

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)["']([^"']+)["']/g;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("Proton Pass import guard", () => {
  test(`${PACKAGE} is loaded only by apps/api and apps/worker, through dynamic import()`, () => {
    const glob = new Bun.Glob("{apps,packages,scripts}/**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}");
    const offenders: string[] = [];
    for (const file of glob.scanSync({ cwd: REPO, onlyFiles: true })) {
      if (
        file.includes("node_modules/") ||
        file.includes("/dist/") ||
        file.startsWith(PACKAGE_DIR)
      ) {
        continue;
      }
      const text = withoutComments(readFileSync(join(REPO, file), "utf8"));
      if (!text.includes(PACKAGE)) continue;
      for (const match of text.matchAll(SPECIFIER)) {
        if (!match[1]!.startsWith(PACKAGE)) continue;
        const lineStart = text.lastIndexOf("\n", match.index) + 1;
        const typeOnly = /^\s*(import|export)\s+type\b/.test(text.slice(lineStart, match.index));
        const dynamic = /\bimport\s*\(/.test(match[0]);
        if (typeOnly || (dynamic && LOADERS.some((dir) => file.startsWith(dir)))) continue;
        offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no package manifest outside the loaders depends on the provider package", () => {
    const glob = new Bun.Glob("{apps,packages}/*/package.json");
    const offenders: string[] = [];
    for (const path of glob.scanSync({ cwd: REPO, onlyFiles: true })) {
      if (path.startsWith(PACKAGE_DIR) || LOADERS.some((dir) => path.startsWith(dir))) continue;
      const manifest = JSON.parse(readFileSync(join(REPO, path), "utf8")) as Record<string, object>;
      const deps = { ...manifest.dependencies, ...manifest.peerDependencies } as Record<
        string,
        string
      >;
      if (PACKAGE in deps) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
