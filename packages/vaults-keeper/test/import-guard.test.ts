import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The Keeper SDK keeps module-global key state, so code may reach it only
 * through this package, which evaluates a fresh copy per operation. The SDK
 * is never imported as a module (only its types), and only apps/api and
 * apps/worker load this package, through `import()`.
 */
const REPO = resolve(import.meta.dir, "../../..");
const SDK = "@keeper-security/secrets-manager-core";
const PACKAGE = "@opengeni/vaults-keeper";
const PACKAGE_DIR = "packages/vaults-keeper/";
const LOADERS = ["apps/api/", "apps/worker/"];

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)["']([^"']+)["']/g;

type Import = { file: string; specifier: string; dynamic: boolean; typeOnly: boolean };

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function imports(): Import[] {
  const glob = new Bun.Glob("{apps,packages,scripts}/**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}");
  const found: Import[] = [];
  for (const file of glob.scanSync({ cwd: REPO, onlyFiles: true })) {
    if (file.includes("node_modules/") || file.includes("/dist/")) continue;
    const text = withoutComments(readFileSync(join(REPO, file), "utf8"));
    if (!text.includes(SDK) && !text.includes(PACKAGE)) continue;
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(SDK) && !specifier.startsWith(PACKAGE)) continue;
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const line = text.slice(lineStart, match.index + match[0].length);
      found.push({
        file,
        specifier,
        dynamic: /\bimport\s*\(/.test(match[0]),
        typeOnly: /^\s*(import|export)\s+type\b/.test(line),
      });
    }
  }
  return found;
}

describe("Keeper import guard", () => {
  const found = imports();

  test(`${SDK} is referenced only inside ${PACKAGE_DIR}, and only for types`, () => {
    const offenders = found
      .filter((entry) => entry.specifier.startsWith(SDK))
      .filter((entry) => !entry.file.startsWith(PACKAGE_DIR) || !entry.typeOnly)
      .map((entry) => `${entry.file}: ${entry.specifier}`);
    expect(offenders).toEqual([]);
  });

  test(`${PACKAGE} is loaded only by apps/api and apps/worker, through dynamic import()`, () => {
    const offenders = found
      .filter((entry) => entry.specifier.startsWith(PACKAGE))
      .filter((entry) => !entry.file.startsWith(PACKAGE_DIR))
      .filter((entry) =>
        entry.typeOnly
          ? false
          : !(entry.dynamic && LOADERS.some((dir) => entry.file.startsWith(dir))),
      )
      .map((entry) => `${entry.file}: ${entry.specifier}`);
    expect(offenders).toEqual([]);
  });

  test("no package manifest outside the loaders depends on the SDK or the provider package", () => {
    const glob = new Bun.Glob("{apps,packages}/*/package.json");
    const offenders: string[] = [];
    for (const path of glob.scanSync({ cwd: REPO, onlyFiles: true })) {
      if (path.startsWith(PACKAGE_DIR) || LOADERS.some((dir) => path.startsWith(dir))) continue;
      const manifest = JSON.parse(readFileSync(join(REPO, path), "utf8")) as Record<string, object>;
      const deps = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      } as Record<string, string>;
      if (SDK in deps || PACKAGE in deps) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test("the scanner recognises static, dynamic and type-only forms and skips comments", () => {
    const sample = [
      `import { SecretManagerOptions } from "${SDK}";`,
      `const sdk = await import("${PACKAGE}");`,
      `import type { KeeperRecord } from "${SDK}";`,
      `// import("${SDK}")`,
    ].join("\n");
    expect([...withoutComments(sample).matchAll(SPECIFIER)]).toHaveLength(3);
  });
});
