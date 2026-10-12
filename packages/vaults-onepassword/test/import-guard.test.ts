import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * OP-5: the 1Password SDK (a ~10 MB WASM core) must never reach a browser
 * bundle or a package that embedders install. Only this package imports it,
 * and only apps/api and apps/worker load this package, through `import()`.
 */
const REPO = resolve(import.meta.dir, "../../..");
const SDK = "@1password/sdk";
const PACKAGE = "@opengeni/vaults-onepassword";
const PACKAGE_DIR = "packages/vaults-onepassword/";
const LOADERS = ["apps/api/", "apps/worker/"];

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)["']([^"']+)["']/g;

function sourceFiles(): string[] {
  const glob = new Bun.Glob("{apps,packages,scripts}/**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}");
  return [...glob.scanSync({ cwd: REPO, onlyFiles: true })].filter(
    (path) => !path.includes("node_modules/") && !path.includes("/dist/"),
  );
}

type Import = { file: string; specifier: string; dynamic: boolean; typeOnly: boolean };

function importsOf(file: string): Import[] {
  const text = readFileSync(join(REPO, file), "utf8");
  if (!text.includes(SDK) && !text.includes(PACKAGE)) return [];
  const found: Import[] = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1]!;
    if (!specifier.startsWith(SDK) && !specifier.startsWith(PACKAGE)) continue;
    const head = match[0];
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const line = text.slice(lineStart, match.index + head.length);
    found.push({
      file,
      specifier,
      dynamic: /\bimport\s*\(/.test(head),
      typeOnly: /^\s*(import|export)\s+type\b/.test(line),
    });
  }
  return found;
}

describe("OP-5 import guard", () => {
  const imports = sourceFiles().flatMap(importsOf);

  test(`${SDK} is imported only inside ${PACKAGE_DIR}`, () => {
    const offenders = imports
      .filter((entry) => entry.specifier.startsWith(SDK))
      .filter((entry) => !entry.file.startsWith(PACKAGE_DIR))
      .map((entry) => entry.file);
    expect(offenders).toEqual([]);
  });

  test(`${SDK} is loaded lazily even inside the package`, () => {
    const eager = imports
      .filter((entry) => entry.specifier.startsWith(SDK) && entry.file.startsWith(`${PACKAGE_DIR}src/`))
      .filter((entry) => !entry.dynamic && !entry.typeOnly)
      .map((entry) => `${entry.file}: ${entry.specifier}`);
    expect(eager).toEqual([]);
  });

  test(`${PACKAGE} is loaded only by apps/api and apps/worker, through dynamic import()`, () => {
    const offenders = imports
      .filter((entry) => entry.specifier.startsWith(PACKAGE))
      .filter((entry) => !entry.file.startsWith(PACKAGE_DIR))
      .filter(
        (entry) =>
          entry.typeOnly ? false : !(entry.dynamic && LOADERS.some((dir) => entry.file.startsWith(dir))),
      )
      .map((entry) => `${entry.file}: ${entry.specifier}${entry.dynamic ? " (dynamic)" : ""}`);
    expect(offenders).toEqual([]);
  });

  test("no package manifest outside the loaders depends on the SDK or the provider package", () => {
    const glob = new Bun.Glob("{apps,packages}/*/package.json");
    const offenders: string[] = [];
    for (const path of glob.scanSync({ cwd: REPO, onlyFiles: true })) {
      if (path.startsWith(PACKAGE_DIR)) continue;
      const manifest = JSON.parse(readFileSync(join(REPO, path), "utf8")) as Record<string, unknown>;
      const deps = {
        ...(manifest.dependencies as object),
        ...(manifest.peerDependencies as object),
        ...(manifest.optionalDependencies as object),
      } as Record<string, string>;
      const loader = LOADERS.some((dir) => path.startsWith(dir));
      if (SDK in deps || (!loader && PACKAGE in deps)) offenders.push(relative(REPO, join(REPO, path)));
    }
    expect(offenders).toEqual([]);
  });

  test("the scanner recognises static, dynamic and type-only forms", () => {
    const sample = [
      `import { createClient } from "${SDK}";`,
      `const sdk = await import("${SDK}");`,
      `import type { Client } from "${SDK}";`,
    ].join("\n");
    const matches = [...sample.matchAll(SPECIFIER)].map((match) => match[0]);
    expect(matches).toHaveLength(3);
    expect(/import\s*\(\s*["']/.test(matches[1]!)).toBe(true);
  });
});
