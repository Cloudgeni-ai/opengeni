import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  PR_E2E_BUDGET_SECONDS,
  PR_E2E_DIRECT_BUDGET_SECONDS,
  PR_E2E_SHARD_CAP,
  PR_INVENTORY_TESTS,
  PR_LANE_DEFINITIONS,
  PR_UNIT_FILE_CAP,
  browserLaneMatrix,
  repositoryHelperImports,
  selectPrBrowserE2e,
  selectPrFastPlan,
  shardMatrix,
  type PrBrowserE2eContext,
} from "./pr-fast-plan";
import { BROWSER_ACCEPTANCE_TESTS, createImpactPlan } from "./impact";
import { createWorkspaceGraph } from "./workspace";

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
  const promptLock = "packages/runtime/test/agent-instructions/legacy-prompt-lock.test.ts";
  const product = createImpactPlan(paths);
  // A changeset note no longer fences; the product change selects its own plan.
  expect(product.mode).toBe("focused");
  // The capped runtime units plus the pinned prompt lock.
  const units = selectPrFastPlan(product, ["packages/runtime"]).unitTests;
  expect(units).toHaveLength(PR_UNIT_FILE_CAP + 1);
  expect(units[0]).toBe(promptLock);
  for (const fence of ["package.json", ".github/workflows/pr-ci.yml"]) {
    const broad = createImpactPlan([...paths, fence]);
    expect(selectPrFastPlan(broad, ["packages/runtime"]).prAdmissionUnits.reason).toBe(
      "broad-impact-deferred-to-batch",
    );
    // Only the inventory tests for the changed areas, never the capped units.
    expect(selectPrFastPlan(broad, ["packages/runtime"]).unitTests).toEqual(
      fence.startsWith(".github/")
        ? ["scripts/workflow-execution-graph.test.ts", promptLock]
        : [promptLock],
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
  expect(migration.unitTests).toEqual(["scripts/check-migration-immutability.test.ts"]);
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

const lanePlan = {
  mode: "focused" as const,
  changedFiles: ["apps/web/src/app.tsx"],
  e2eTests: ["test/e2e/a.browser.e2e.ts", "test/e2e/b.browser.e2e.ts", "test/e2e/c.e2e.ts"],
  browserAcceptanceLanes: ["accounts", "interaction", "knowledge"] as (
    | "accounts"
    | "interaction"
    | "knowledge"
  )[],
};
const laneContext = (overrides: Partial<PrBrowserE2eContext> = {}): PrBrowserE2eContext => ({
  touchedWorkspaces: new Set(["opengeni-web"]),
  testWorkspaces: (path) =>
    path.includes("browser") ? ["opengeni-web", "@opengeni/testing"] : ["@opengeni/runtime"],
  testHelpers: (path) => (path.includes("/b.") ? ["test/e2e/fixtures/shared.ts"] : []),
  seconds: () => 30,
  laneTests: {
    accounts: ["test/e2e/accounts.e2e.ts"],
    interaction: ["test/e2e/queue.browser.e2e.ts"],
    knowledge: ["test/e2e/pins.browser.e2e.ts"],
    onboarding: [],
    workbench: [],
  },
  ...overrides,
});

test("PR E2E runs authored and directly affected impacted tests, never unimpacted ones", () => {
  const selected = selectPrBrowserE2e(lanePlan, laneContext());
  expect(selected.e2eTests).toEqual(["test/e2e/a.browser.e2e.ts", "test/e2e/b.browser.e2e.ts"]);
  expect(selected.e2eShards).toBe(1);
  expect(selected.summary).toMatchObject({ e2eImpactedCount: 3, e2eAuthored: 0, e2eDirect: 2 });
  // Docs plans list no E2E tests or lanes, so nothing runs.
  const docs = selectPrBrowserE2e(
    { ...lanePlan, mode: "docs", e2eTests: [], browserAcceptanceLanes: [] },
    laneContext(),
  );
  expect(docs).toMatchObject({ e2eTests: [], e2eShards: 0, browserAcceptanceLanes: [] });
  // A test outside the impact plan is never added, even when authored.
  const outside = selectPrBrowserE2e(
    { ...lanePlan, changedFiles: ["test/e2e/z.browser.e2e.ts"] },
    laneContext({ touchedWorkspaces: new Set() }),
  );
  expect(outside.e2eTests).toEqual([]);
});

test("a changed fixture selects its importers and their lanes, even behind a CI fence", () => {
  const context = laneContext({
    touchedWorkspaces: new Set(),
    testHelpers: (path) =>
      ["test/e2e/b.browser.e2e.ts", "test/e2e/pins.browser.e2e.ts"].includes(path)
        ? ["test/e2e/fixtures/shared.ts"]
        : [],
  });
  const selected = selectPrBrowserE2e(
    {
      ...lanePlan,
      mode: "full",
      changedFiles: [".github/workflows/ci.yml", "test/e2e/fixtures/shared.ts"],
    },
    context,
  );
  expect(selected.e2eTests).toEqual(["test/e2e/b.browser.e2e.ts"]);
  expect(selected.browserAcceptanceLanes).toEqual(["knowledge"]);
  expect(selected.summary.browserJobCount).toBe(1);
  // Only authored tests select browser lanes; a touched workspace alone does not.
  expect(selectPrBrowserE2e(lanePlan, laneContext()).browserAcceptanceLanes).toEqual([]);
  // A lane Batch did not select is never run on the PR.
  expect(
    selectPrBrowserE2e(
      {
        ...lanePlan,
        browserAcceptanceLanes: ["accounts"],
        changedFiles: ["test/e2e/pins.browser.e2e.ts"],
      },
      context,
    ).browserAcceptanceLanes,
  ).toEqual([]);
});

test("authored tests take the budget first; the direct sample fills one shard, cheapest first", () => {
  const direct = Array.from(
    { length: 30 },
    (_, i) => `test/e2e/d${String(i).padStart(2, "0")}.browser.e2e.ts`,
  );
  const authored = ["test/e2e/heavy-a.browser.e2e.ts", "test/e2e/heavy-b.browser.e2e.ts"];
  const seconds = (path: string) =>
    path.includes("heavy") ? 600 : 20 + Number(/d(\d+)/.exec(path)?.[1] ?? 0);
  const directPlan = {
    ...lanePlan,
    changedFiles: ["apps/web/src/app.tsx", ...authored],
    e2eTests: [...direct, ...authored],
  };
  const selected = selectPrBrowserE2e(directPlan, laneContext({ seconds }));
  for (const path of authored) expect(selected.e2eTests).toContain(path);
  const sample = selected.e2eTests.filter((path) => !authored.includes(path));
  expect(sample).toEqual(direct.slice(0, sample.length));
  const sampleSeconds = sample.reduce((sum, path) => sum + seconds(path), 0);
  expect(sampleSeconds).toBeLessThanOrEqual(PR_E2E_DIRECT_BUDGET_SECONDS);
  expect(sampleSeconds + seconds(direct[sample.length]!)).toBeGreaterThan(
    PR_E2E_DIRECT_BUDGET_SECONDS,
  );
  expect(selected.summary.e2eDeferredDirectCount).toBe(direct.length - sample.length);
  expect(selected.e2eShards).toBe(
    Math.min(PR_E2E_SHARD_CAP, Math.ceil(selected.summary.e2eEstimatedSeconds / 480)),
  );
  // Authored tests beyond the whole budget are deferred and named.
  const many = Array.from({ length: 5 }, (_, i) => `test/e2e/heavy-${i}.browser.e2e.ts`);
  const capped = selectPrBrowserE2e(
    { ...directPlan, changedFiles: many, e2eTests: many },
    laneContext({ seconds, touchedWorkspaces: new Set() }),
  );
  expect(capped.e2eTests).toHaveLength(Math.floor(PR_E2E_BUDGET_SECONDS / 600));
  expect(capped.summary.e2eDeferredAuthored).toHaveLength(5 - capped.e2eTests.length);
  expect(capped.e2eShards).toBeLessThanOrEqual(PR_E2E_SHARD_CAP);
  // The selection does not depend on input order.
  expect(
    selectPrBrowserE2e(
      { ...directPlan, e2eTests: [...directPlan.e2eTests].reverse() },
      laneContext({ seconds }),
    ).e2eTests,
  ).toEqual(selected.e2eTests);
});

test("changing a lane's definition runs that lane on the PR", () => {
  const context = laneContext({ touchedWorkspaces: new Set() });
  const none = selectPrBrowserE2e({ ...lanePlan, changedFiles: ["docs/x.md"] }, context);
  expect(none).toMatchObject({ e2eTests: [], browserAcceptanceLanes: [] });
  const browser = selectPrBrowserE2e(
    { ...lanePlan, mode: "full", changedFiles: [".github/workflows/ci-browser-acceptance.yml"] },
    context,
  );
  expect(browser.browserAcceptanceLanes).toEqual(lanePlan.browserAcceptanceLanes);
  expect(browser.e2eTests).toEqual([]);
  const e2e = selectPrBrowserE2e(
    { ...lanePlan, mode: "full", changedFiles: ["scripts/ci/run-test-shard.ts"] },
    context,
  );
  expect(e2e.browserAcceptanceLanes).toEqual([]);
  expect(e2e.e2eTests).toEqual(lanePlan.e2eTests);
  const both = selectPrBrowserE2e(
    { ...lanePlan, mode: "full", changedFiles: [".github/actions/playwright-browsers/action.yml"] },
    context,
  );
  expect(both.summary.laneDefinitionsChanged).toEqual({ e2e: true, browser: true });
  for (const paths of Object.values(PR_LANE_DEFINITIONS))
    for (const path of paths) expect(existsSync(path)).toBe(true);
});

test("PR matrices match ci.yml's lane expansion and shard list", () => {
  expect(browserLaneMatrix(["accounts", "workbench"])).toEqual([
    { lane: "accounts", engine: "chromium" },
    { lane: "accounts", engine: "firefox" },
    { lane: "accounts", engine: "webkit" },
    { lane: "workbench", engine: "chromium" },
  ]);
  expect(shardMatrix(2)).toEqual([
    { index: 0, number: 1, total: 2 },
    { index: 1, number: 2, total: 2 },
  ]);
  const ci = require("node:fs").readFileSync(".github/workflows/ci.yml", "utf8") as string;
  expect(ci).toContain(
    `map(if . == "accounts" then [{lane:.,engine:"chromium"},{lane:.,engine:"firefox"},{lane:.,engine:"webkit"}] else [{lane:.,engine:"chromium"}] end)`,
  );
  expect(ci).toContain("'[range(0; $total) | {index: ., number: (. + 1), total: $total}]'");
});

test("helper imports follow relative repository files outside workspaces", () => {
  const graph = createWorkspaceGraph();
  const files: Record<string, string> = {
    "test/e2e/x.browser.e2e.ts": `import { a } from "./fixtures/a"; import "@opengeni/sdk"; import "../../apps/web/src/main";`,
    "test/e2e/fixtures/a.ts": `export { b } from "./b.ts"; export const a = 1;`,
    "test/e2e/fixtures/b.ts": `import "./a"; export const b = 2;`,
    "apps/web/src/main.ts": `import "../../../test/e2e/fixtures/c";`,
  };
  expect(
    repositoryHelperImports("test/e2e/x.browser.e2e.ts", graph, (path) => files[path] ?? null),
  ).toEqual(["test/e2e/fixtures/a.ts", "test/e2e/fixtures/b.ts"]);
  // Every curated browser acceptance test resolves in the real repository.
  for (const testPath of Object.values(BROWSER_ACCEPTANCE_TESTS).flat()) {
    expect(existsSync(testPath)).toBe(true);
    for (const helper of repositoryHelperImports(testPath, graph))
      expect(existsSync(helper)).toBe(true);
  }
});
