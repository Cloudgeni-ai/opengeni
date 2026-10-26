import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diagnoseStep,
  extractDiagnostic,
  parseDiagnostic,
  writeDiagnostic,
} from "./batch-diagnostic";

const root = "/home/runner/work/opengeni/opengeni";
const tracked = new Set([
  "packages/react-native/android/src/main/res/drawable/opengeni_recording_notification.xml",
  ".changeset/provider-unreachable-waits.md",
  ".changeset/signup-promotion-protection.md",
  "apps/api/src/routes/voice.ts",
  "packages/sdk/src/index.ts",
  "scripts/check-public-repo-hygiene.ts",
  "packages/react/src/lib/noto-sans-jp-loader.generated.ts",
  "apps/api/src/routes/github-browser-fonts.gen.ts",
]);
const isFile = (path: string) => tracked.has(path);

test("public hygiene failure names the offending file, not the guard script", () => {
  const output = [
    "$ bun scripts/check-public-repo-hygiene.ts",
    "packages/react-native/android/src/main/res/drawable/opengeni_recording_notification.xml:9 — retired milestone label",
    'error: script "check:public-hygiene" exited with code 1',
  ].join("\n");
  expect(extractDiagnostic("guard:public-hygiene", output, root, isFile)).toEqual({
    check: "guard:public-hygiene",
    paths: [
      "packages/react-native/android/src/main/res/drawable/opengeni_recording_notification.xml",
    ],
    excerpt:
      "packages/react-native/android/src/main/res/drawable/opengeni_recording_notification.xml:9 — retired milestone label",
  });
});

test("changeset errors map the named changeset to its file", () => {
  const missing =
    "🦋  \u001b[31merror\u001b[39m Error: Found changeset provider-unreachable-waits for package @opengeni/worker which is not in the workspace\n🦋  error     at mapGetOrThrow (/home/runner/work/opengeni/opengeni/node_modules/.bun/x/dist/index.cjs.js:10:5)";
  expect(extractDiagnostic("changesets", missing, root, isFile)).toMatchObject({
    paths: [".changeset/provider-unreachable-waits.md"],
    excerpt: expect.stringContaining("Found changeset provider-unreachable-waits"),
  });
  const mixed =
    "🦋  error Error: Found mixed changeset signup-promotion-protection\n🦋  error Found ignored packages: @opengeni/deployment";
  expect(extractDiagnostic("changesets", mixed, root, isFile).paths).toEqual([
    ".changeset/signup-promotion-protection.md",
  ]);
});

test("typecheck and lint output paths are kept; absolute paths inside the tree are relativized", () => {
  const output = [
    "[typecheck] ok   packages/events",
    "[typecheck] FAIL apps/api",
    "apps/api/src/routes/voice.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    "  ,-[/home/runner/work/opengeni/opengeni/packages/sdk/src/index.ts:4:1]",
    "/etc/passwd:1 outside the repository",
    "missing/file.ts:3 not tracked",
  ].join("\n");
  expect(extractDiagnostic("typecheck", output, root, isFile)).toMatchObject({
    paths: ["apps/api/src/routes/voice.ts", "packages/sdk/src/index.ts"],
    excerpt: expect.stringContaining("error TS2322"),
  });
});

test("the guard step counts only the failed guard's own section (Batch CI run 40324131716)", () => {
  // Earlier passing guards name real files; only the last guard failed.
  const tail = [
    "[guard] docs-refs",
    "Docs reference freshness and architecture map guards passed.",
    "[guard] generated-fonts",
    "$ bun scripts/generate-noto-jp-loader.ts --check && bun scripts/generate-github-page-fonts.ts --check",
    `verified ${root}/packages/react/src/lib/noto-sans-jp-loader.generated.ts with 120 unicode shards`,
    `verified ${root}/apps/api/src/routes/github-browser-fonts.gen.ts`,
    "[guard] public-hygiene",
    "$ bun scripts/check-public-repo-hygiene.ts",
    "packages/react-native/android/src/main/res/drawable/opengeni_recording_notification.xml:9 — retired milestone label",
    'error: script "check:public-hygiene" exited with code 1',
  ].join("\n");
  expect(diagnoseStep("guards", tail, root, isFile)).toEqual({
    check: "guard:public-hygiene",
    paths: [
      "packages/react-native/android/src/main/res/drawable/opengeni_recording_notification.xml",
    ],
    excerpt:
      "packages/react-native/android/src/main/res/drawable/opengeni_recording_notification.xml:9 — retired milestone label",
  });
  expect(diagnoseStep("typecheck", "[typecheck] ok   packages/events", root, isFile)).toEqual({
    check: "typecheck",
    paths: [],
    excerpt: "",
  });
});

test("untrusted diagnostics with unsafe paths or checks are rejected", () => {
  expect(parseDiagnostic({ check: "typecheck", paths: ["a/b.ts"], excerpt: "x" })).toEqual({
    check: "typecheck",
    paths: ["a/b.ts"],
    excerpt: "x",
  });
  for (const paths of [["/etc/passwd"], ["../x.ts"], ["a/../b.ts"], ["node_modules/x.js"], [3]])
    expect(parseDiagnostic({ check: "typecheck", paths, excerpt: "x" })).toBeNull();
  expect(parseDiagnostic({ check: "Bad Check", paths: [], excerpt: "x" })).toBeNull();
  expect(parseDiagnostic(null)).toBeNull();
});

test("unit failures from one task accumulate into one diagnostic", () => {
  const directory = mkdtempSync(join(tmpdir(), "batch-diagnostic-"));
  try {
    const file = join(directory, "diagnostic.json");
    writeDiagnostic({ check: "unit", paths: ["b.test.ts"], excerpt: "first" }, file);
    writeDiagnostic({ check: "unit", paths: ["a.test.ts"], excerpt: "second" }, file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      check: "unit",
      paths: ["a.test.ts", "b.test.ts"],
      excerpt: "first",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
