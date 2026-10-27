import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { PR_INVENTORY_TESTS, PR_UNIT_FILE_CAP, selectPrFastPlan } from "./pr-fast-plan";
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
    // Only the inventory test for the changed workflow, never the capped units.
    expect(selectPrFastPlan(broad, ["packages/runtime"]).unitTests).toEqual(
      fence.startsWith(".github/") ? ["scripts/workflow-execution-graph.test.ts"] : [],
    );
  }
});

test("inventory tests run whenever their area changes, beyond the cap and broad deferral", () => {
  for (const { test: path } of PR_INVENTORY_TESTS) expect(existsSync(path)).toBe(true);
  const tests = Array.from(
    { length: 80 },
    (_, i) => `apps/api/test/${String(i).padStart(3, "0")}.test.ts`,
  );
  const inventory = [...tests, ...PR_INVENTORY_TESTS.map(({ test: path }) => path)];
  const routes = selectPrFastPlan(
    { ...plan, changedFiles: ["apps/api/src/app.ts"], unitTests: inventory },
    ["apps/api", "packages/sdk", "scripts"],
  );
  expect(routes.unitTests[0]).toBe("apps/api/test/organization-mcp.test.ts");
  expect(routes.unitTests).toHaveLength(PR_UNIT_FILE_CAP + 1);
  expect(routes.prAdmissionUnits.inventoryTests).toEqual([
    "apps/api/test/organization-mcp.test.ts",
  ]);
  const surface = selectPrFastPlan(
    {
      ...plan,
      mode: "full",
      changedFiles: ["scripts/public-api/surface.gen.json"],
      unitTests: inventory,
    },
    dirs,
  );
  expect(surface.unitTests).toEqual([
    "apps/api/test/organization-mcp.test.ts",
    "packages/sdk/test/client-coverage.test.ts",
  ]);
  const migration = selectPrFastPlan(
    {
      ...plan,
      mode: "full",
      changedFiles: ["packages/db/drizzle/0999_x.sql"],
      unitTests: inventory,
    },
    dirs,
  );
  expect(migration.unitTests).toEqual(["scripts/release-schema-contract.test.ts"]);
  // Inventory tests need not be in the impact plan's list, only exist; docs
  // plans never run units.
  const web = selectPrFastPlan(
    { ...plan, changedFiles: ["apps/web/src/main.tsx"], unitTests: tests },
    dirs,
  );
  expect(web.unitTests).toEqual(["packages/sdk/test/browser-client-surface.test.ts"]);
  expect(web.prAdmissionUnits.deferredCount).toBe(tests.length);
  expect(
    selectPrFastPlan({ ...plan, changedFiles: ["apps/web/src/main.tsx"] }, dirs, () => false)
      .unitTests,
  ).toEqual([]);
  expect(
    selectPrFastPlan({ ...plan, mode: "docs", changedFiles: [".github/README.md"] }, dirs)
      .unitTests,
  ).toEqual([]);
});

test("the production web bundle runs when the web app or its build inputs are affected", () => {
  const web = (input: { mode?: "focused" | "full" | "docs"; affectedPackages?: string[] }) =>
    selectPrFastPlan({ ...plan, ...input }, dirs).prWebBundle;
  expect(web({ affectedPackages: ["@opengeni/react", "opengeni-web"] })).toBe(true);
  expect(web({ affectedPackages: ["@opengeni/browser-extension"] })).toBe(true);
  expect(web({ affectedPackages: ["@opengeni/compute"] })).toBe(false);
  expect(web({ mode: "full", affectedPackages: [] })).toBe(true);
  expect(web({})).toBe(true);
  expect(web({ mode: "docs", affectedPackages: ["opengeni-web"] })).toBe(false);
  // The real graph: packages/react and packages/sdk reach the web app.
  for (const path of ["packages/react/src/index.ts", "packages/sdk/src/index.ts"]) {
    expect(selectPrFastPlan(createImpactPlan([path]), dirs).prWebBundle).toBe(true);
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
