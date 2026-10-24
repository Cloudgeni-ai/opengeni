import { expect, test } from "bun:test";
import { PR_UNIT_FILE_CAP, selectPrFastPlan } from "./pr-fast-plan";

const plan = {
  schemaVersion: 1 as const,
  mode: "focused" as const,
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
  expect(() => selectPrFastPlan({ ...plan, mode: "invalid" } as never, dirs)).toThrow(
    "Invalid PR impact plan",
  );
});
