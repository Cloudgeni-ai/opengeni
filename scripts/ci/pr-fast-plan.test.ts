import { expect, test } from "bun:test";
import { PR_UNIT_FILE_CAP, selectPrFastPlan } from "./pr-fast-plan";
import { createImpactPlan } from "./impact";

const plan = {
  schemaVersion: 1 as const,
  mode: "focused" as const,
  reasons: [],
  changedFiles: ["packages/a/src/index.ts"],
  unitTests: [
    "packages/a/test/one.test.ts",
    "packages/ab/test/two.test.ts",
    "packages/b/test/three.test.ts",
  ],
  typecheckProjects: ["packages/a", "packages/b"],
  head: "exact-head",
};
const dirs = ["packages/a", "packages/ab", "packages/b"];
test("only directly touched package units are selected; affected types and identity remain", () => {
  const selected = selectPrFastPlan(plan, dirs);
  expect(selected.unitTests).toEqual(["packages/a/test/one.test.ts"]);
  expect(selected.typecheckProjects).toEqual(plan.typecheckProjects);
  expect(selected.head).toBe(plan.head);
  expect(plan.unitTests).toHaveLength(3);
});
test("broad impact explicitly defers all admission units to unchanged Batch coverage", () => {
  const selected = selectPrFastPlan({ ...plan, mode: "full" }, dirs);
  expect(selected.unitTests).toEqual([]);
  expect(selected.prAdmissionUnits).toMatchObject({
    reason: "broad-impact-deferred-to-batch",
    originalCount: 3,
    deferredCount: 3,
  });
});
test("cap is deterministic and changed tests are prioritized", () => {
  const tests = Array.from(
    { length: 80 },
    (_, i) => `packages/a/test/${String(i).padStart(3, "0")}.test.ts`,
  );
  const input = { ...plan, changedFiles: [tests[79]!], unitTests: tests };
  const selected = selectPrFastPlan(input, dirs);
  expect(selected.unitTests).toHaveLength(PR_UNIT_FILE_CAP);
  expect(selected.unitTests[0]).toBe(tests[79]);
  expect(selected.unitTests).toEqual(
    selectPrFastPlan({ ...input, unitTests: [...tests].reverse() }, dirs).unitTests,
  );
  expect(selected.prAdmissionUnits).toMatchObject({
    reason: "direct-package-cap",
    deferredCount: 40,
  });
});
test("docs and non-package paths select no units without treating missing tests as passed", () => {
  expect(selectPrFastPlan({ ...plan, mode: "docs" }, dirs).prAdmissionUnits.reason).toBe(
    "docs-no-admission-units",
  );
  expect(
    selectPrFastPlan({ ...plan, changedFiles: ["scripts/example.ts"] }, dirs).unitTests,
  ).toEqual([]);
  expect(
    selectPrFastPlan({ ...plan, changedFiles: ["scripts/example.ts"] }, dirs).prAdmissionUnits
      .reason,
  ).toBe("no-direct-package-units");
  expect(() => selectPrFastPlan({ ...plan, mode: "invalid" } as never, dirs)).toThrow(
    "Invalid PR impact plan",
  );
});

test("product plus release note selects units, but changeset cannot mask another broad fence", () => {
  const paths = [".changeset/example.md", "packages/runtime/src/index.ts"];
  const product = createImpactPlan(paths);
  expect(product.mode).toBe("full");
  expect(selectPrFastPlan(product, ["packages/runtime"]).unitTests).toHaveLength(PR_UNIT_FILE_CAP);
  for (const fence of ["package.json", ".github/workflows/pr-ci.yml"]) {
    const broad = createImpactPlan([...paths, fence]);
    expect(selectPrFastPlan(broad, ["packages/runtime"]).prAdmissionUnits.reason).toBe(
      "broad-impact-deferred-to-batch",
    );
    expect(selectPrFastPlan(broad, ["packages/runtime"]).unitTests).toEqual([]);
  }
});

test("duplicates count once and ordering uses code units", () => {
  const units = [
    "packages/a/test/z.test.ts",
    "packages/a/test/Z.test.ts",
    "packages/a/test/Z.test.ts",
  ];
  const selected = selectPrFastPlan({ ...plan, unitTests: units }, dirs);
  expect(selected.unitTests).toEqual(["packages/a/test/Z.test.ts", "packages/a/test/z.test.ts"]);
  expect(selected.prAdmissionUnits).toMatchObject({
    originalCount: 2,
    selectedCount: 2,
    deferredCount: 0,
  });
});
