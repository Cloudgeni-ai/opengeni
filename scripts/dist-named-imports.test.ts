import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyDistNamedImports, type BuiltPackage } from "./dist-named-imports";

const root = mkdtempSync(join(tmpdir(), "dist-named-imports-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string, files: Record<string, string>, exports?: unknown): BuiltPackage {
  const pkgRoot = join(root, name.replace("/", "__"));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(pkgRoot, path)), { recursive: true });
    writeFileSync(join(pkgRoot, path), source);
  }
  return {
    name,
    root: pkgRoot,
    packageJson: {
      exports: exports ?? { ".": { types: "./src/index.ts", default: "./src/index.ts" } },
    },
  };
}

describe("built named imports between @opengeni packages", () => {
  const contracts = fixture(
    "@opengeni/contracts",
    {
      "dist/nango.js": "export const NANGO_TAG = {};\nexport function nangoApiUrl() {}\n",
      "dist/index.js": 'export * from "./nango.js";\nexport default 1;\n',
    },
    {
      ".": { default: "./src/index.ts" },
      "./nango": { types: "./src/nango.ts", default: "./src/nango.ts" },
    },
  );

  test("accepts names exported directly and through static export chains", () => {
    const capabilities = fixture("@opengeni/capabilities", {
      "dist/index.js":
        'export { NANGO_TAG, nangoApiUrl } from "@opengeni/contracts/nango";\nexport * from "zod";\nconst local = 1;\nexport { local as renamed };\n',
    });
    const consumer = fixture("@opengeni/core", {
      "dist/index.js":
        'import contracts, { nangoApiUrl } from "@opengeni/contracts";\nimport { NANGO_TAG, renamed, anythingFromZod } from "@opengeni/capabilities";\nexport { NANGO_TAG as tag } from "@opengeni/capabilities";\nimport { z } from "zod";\n',
    });
    expect(verifyDistNamedImports([contracts, capabilities, consumer])).toEqual([]);
  });

  test("rejects a name lost to a runtime-only re-export", () => {
    const capabilities = fixture("@opengeni/capabilities-runtime", {
      "dist/index.js":
        'import * as nango_star from "@opengeni/contracts/nango";\nvar nango_exports = {};\n__reExport(nango_exports, nango_star);\nexport function verify() {}\n',
    });
    const consumer = fixture("@opengeni/core-runtime", {
      "dist/chunk.js":
        'import { NANGO_TAG, verify } from "@opengeni/capabilities-runtime";\nexport { nangoApiUrl } from "@opengeni/capabilities-runtime";\n',
    });
    const failures = verifyDistNamedImports([contracts, capabilities, consumer]);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("imports { NANGO_TAG } from @opengeni/capabilities-runtime");
    expect(failures[1]).toContain("imports { nangoApiUrl } from @opengeni/capabilities-runtime");
  });

  test("rejects a missing built entry", () => {
    const consumer = fixture("@opengeni/core-missing", {
      "dist/index.js": 'import { x } from "@opengeni/contracts/missing";\n',
    });
    expect(verifyDistNamedImports([contracts, consumer])).toEqual([
      expect.stringContaining("which has no built runtime entry"),
    ]);
  });
});
