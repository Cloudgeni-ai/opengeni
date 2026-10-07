import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  checkSubscriptionContract,
  CONTRACT_PATH,
  parseContract,
  testTitles,
} from "./check-subscription-contract";

const repositoryRoot = resolve(import.meta.dir, "..");

test("the repository subscription contract and its test references are consistent", () => {
  expect(checkSubscriptionContract(repositoryRoot)).toEqual([]);
});

function fixtureRepository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "subscription-contract-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test("parses pending and test-backed verification lines across wrapped list items", () => {
  const requirements = parseContract(
    [
      "- **SUB-FIXTURE-01** First requirement.",
      "  Verification: pending (alpha).",
      "- **SUB-FIXTURE-02** Second requirement. Verification:",
      "  `apps/x/test/a.test.ts`, `apps/x/test/b.test.ts`.",
      "- **SUB-FIXTURE-03** Missing verification.",
      "- **SUB-FIXTURE-04** Superseded requirement. Verification: retired.",
    ].join("\n"),
  );
  expect(requirements.map((requirement) => requirement.verification)).toEqual([
    { kind: "pending", workItem: "alpha" },
    { kind: "tests", paths: ["apps/x/test/a.test.ts", "apps/x/test/b.test.ts"] },
    null,
    { kind: "retired" },
  ]);
});

test("reports duplicate, unverified, missing, unclaimed and undefined requirement IDs", () => {
  const root = fixtureRepository({
    [CONTRACT_PATH]: [
      "- **SUB-FIXTURE-01** Verification: pending (alpha).",
      "- **SUB-FIXTURE-01** Verification: pending (alpha).",
      "- **SUB-FIXTURE-02** No verification.",
      "- **SUB-FIXTURE-03** Verification: `apps/x/test/missing.test.ts`.",
      "- **SUB-FIXTURE-04** Verification: `apps/x/test/claims.test.ts`.",
      "- **SUB-FIXTURE-05** Verification: pending (beta).",
      "",
      "## Work items",
      "",
      "| Work item | Delivers |",
      "| --- | --- |",
      "| `alpha` | Fixture work. |",
    ].join("\n"),
    "apps/x/test/claims.test.ts": 'test("SUB-FIXTURE-09 unknown requirement", () => {});\n',
  });
  try {
    const messages = checkSubscriptionContract(root).map((finding) => finding.message);
    expect(messages).toEqual([
      "SUB-FIXTURE-01 is defined more than once",
      "SUB-FIXTURE-02 needs 'Verification: pending (<work item>).', 'Verification: retired.' or a list of backticked test files",
      "SUB-FIXTURE-03 names a test file that does not exist: apps/x/test/missing.test.ts",
      "does not name SUB-FIXTURE-04 in any test title",
      "SUB-FIXTURE-05 names an unknown work item: beta",
      "SUB-FIXTURE-09 is not defined in " + CONTRACT_PATH,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a test-backed requirement passes when its test names the ID", () => {
  const root = fixtureRepository({
    [CONTRACT_PATH]: "- **SUB-FIXTURE-01** Verification: `apps/x/test/ok.test.ts`.\n",
    "apps/x/test/ok.test.ts": 'test("SUB-FIXTURE-01 behaves", () => {});\n',
  });
  try {
    expect(checkSubscriptionContract(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration and end-to-end tests, including the root test tree, are verification and are scanned", () => {
  const root = fixtureRepository({
    [CONTRACT_PATH]: [
      "- **SUB-FIXTURE-01** Verification: `test/integration/flow.integration.ts`.",
      "- **SUB-FIXTURE-02** Verification: `apps/x/test/flow.e2e.ts`.",
    ].join("\n"),
    "test/integration/flow.integration.ts": 'test("SUB-FIXTURE-01 behaves", () => {});\n',
    "apps/x/test/flow.e2e.ts": 'test("SUB-FIXTURE-02 behaves", () => {});\n',
    "test/e2e/other.e2e.ts": 'test("SUB-FIXTURE-07 is not defined", () => {});\n',
  });
  try {
    expect(checkSubscriptionContract(root)).toEqual([
      {
        file: "test/e2e/other.e2e.ts",
        line: 1,
        message: "SUB-FIXTURE-07 is not defined in " + CONTRACT_PATH,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("test titles are the first string argument of test, it and describe calls", () => {
  const source = [
    "// SUB-FIXTURE-01 in a comment is not a title",
    "/* SUB-FIXTURE-02 */",
    'const fixture = "SUB-FIXTURE-03";',
    'describe("SUB-FIXTURE-04 group", () => {',
    "  it(`SUB-FIXTURE-05 template ${fixture}`, () => {});",
    '  test.each([1, 2])("SUB-FIXTURE-06 row %d", () => {});',
    '  test.only("SUB-FIXTURE-07 focused", () => {});',
    '  test.skip("SUB-FIXTURE-08 skipped", () => {});',
    '  test.todo("SUB-FIXTURE-09 placeholder");',
    '  expect(run("SUB-FIXTURE-10")).toBe(true);',
    "});",
  ].join("\n");
  expect(testTitles("fixture.test.ts", source)).toEqual([
    "SUB-FIXTURE-04 group",
    "SUB-FIXTURE-05 template \n",
    "SUB-FIXTURE-06 row %d",
    "SUB-FIXTURE-07 focused",
  ]);
});

test("an ID mentioned only outside test titles does not verify a requirement", () => {
  const root = fixtureRepository({
    [CONTRACT_PATH]: "- **SUB-FIXTURE-01** Verification: `apps/x/test/comment.test.ts`.\n",
    "apps/x/test/comment.test.ts": [
      "// Covers SUB-FIXTURE-01.",
      'test("behaves", () => expect("SUB-FIXTURE-01").toBeTruthy());',
      'test.skip("SUB-FIXTURE-01 later", () => {});',
    ].join("\n"),
  });
  try {
    expect(checkSubscriptionContract(root).map((finding) => finding.message)).toEqual([
      "does not name SUB-FIXTURE-01 in any test title",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requirement IDs match only on whole-ID boundaries", () => {
  const root = fixtureRepository({
    [CONTRACT_PATH]: "- **SUB-FIXTURE-01** Verification: `apps/x/test/near.test.ts`.\n",
    "apps/x/test/near.test.ts": [
      'test("SUB-FIXTURE-012 is a different ID", () => {});',
      'test("XSUB-FIXTURE-01 is not an ID", () => {});',
    ].join("\n"),
  });
  try {
    expect(checkSubscriptionContract(root).map((finding) => finding.message)).toEqual([
      "does not name SUB-FIXTURE-01 in any test title",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retired requirement needs no tests and stays defined", () => {
  const root = fixtureRepository({
    [CONTRACT_PATH]: "- **SUB-FIXTURE-01** Superseded. Verification: retired.\n",
    "apps/x/test/history.test.ts": "// SUB-FIXTURE-01 was retired.\n",
  });
  try {
    expect(checkSubscriptionContract(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a model: mention must be defined but never verifies a requirement", () => {
  const root = fixtureRepository({
    [CONTRACT_PATH]: "- **SUB-FIXTURE-01** Verification: `packages/x/test/model.test.ts`.\n",
    "packages/x/test/model.test.ts": [
      'test("model:SUB-FIXTURE-01 the reference model agrees", () => {});',
      'test("model:SUB-FIXTURE-09 is still checked", () => {});',
    ].join("\n"),
  });
  try {
    expect(checkSubscriptionContract(root).map((finding) => finding.message)).toEqual([
      "does not name SUB-FIXTURE-01 in any test title",
      "SUB-FIXTURE-09 is not defined in " + CONTRACT_PATH,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
