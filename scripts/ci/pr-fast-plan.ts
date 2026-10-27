import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createImpactPlan, type ImpactPlan } from "./impact";
import { createWorkspaceGraph } from "./workspace";

export const PR_UNIT_FILE_CAP = 40;
type Input = Pick<ImpactPlan, "schemaVersion" | "mode" | "changedFiles" | "unitTests" | "reasons"> &
  Partial<Pick<ImpactPlan, "affectedPackages">>;

/**
 * Cross-package inventory tests that failed batches when a PR changed what
 * they enumerate without its own selection reaching them (another package,
 * past the cap, or broad impact). They run on the PR whenever a listed path
 * prefix changes, in addition to the capped direct-package units.
 */
export const PR_INVENTORY_TESTS: readonly { test: string; areas: readonly string[] }[] = [
  {
    test: "apps/api/test/organization-mcp.test.ts",
    areas: ["apps/api/src/", "packages/contracts/src/", "scripts/public-api/surface.gen.json"],
  },
  {
    test: "packages/sdk/test/client-coverage.test.ts",
    areas: ["packages/sdk/src/", "packages/contracts/src/", "scripts/public-api/surface.gen.json"],
  },
  {
    test: "packages/sdk/test/browser-client-surface.test.ts",
    areas: ["packages/sdk/src/", "packages/react/src/", "apps/web/src/"],
  },
  {
    test: "scripts/workflow-execution-graph.test.ts",
    areas: [".github/", "scripts/workflow-execution-graph"],
  },
  {
    test: "scripts/release-schema-contract.test.ts",
    areas: ["packages/db/drizzle/", "scripts/release-schema-contract", "scripts/migration-schema"],
  },
];

/** Workspaces whose change can break the production web bundle Batch builds. */
export const PR_WEB_BUNDLE_PACKAGES = ["opengeni-web", "@opengeni/browser-extension"];

/** Admission sampling only; the original full Batch plan is never changed. */
export function selectPrFastPlan<T extends Input>(
  plan: T,
  packageDirectories: readonly string[],
  exists: (path: string) => boolean = existsSync,
) {
  if (
    plan.schemaVersion !== 1 ||
    !["full", "focused", "docs"].includes(plan.mode) ||
    !Array.isArray(plan.changedFiles) ||
    !Array.isArray(plan.unitTests) ||
    !Array.isArray(plan.reasons) ||
    [...plan.changedFiles, ...plan.unitTests].some((path) => typeof path !== "string")
  )
    throw new Error("Invalid PR impact plan");
  const directories = [...packageDirectories].sort((a, b) => b.length - a.length);
  const owner = (path: string) =>
    directories.find((dir) => path === dir || path.startsWith(`${dir}/`));
  const touched = new Set(
    plan.changedFiles.map(owner).filter((dir): dir is string => Boolean(dir)),
  );
  const inventory = [...new Set(plan.unitTests)];
  const direct = inventory.filter((path) => touched.has(owner(path) ?? ""));
  const changed = new Set(plan.changedFiles);
  direct.sort(
    (a, b) => Number(changed.has(b)) - Number(changed.has(a)) || (a < b ? -1 : a > b ? 1 : 0),
  );
  // impact.ts returns at its first broad fence. Re-plan without release notes
  // so a changeset cannot hide a later workflow/root/schema fence.
  const changesetOnlyFull =
    plan.mode === "full" &&
    plan.reasons.length > 0 &&
    plan.reasons.every(
      (reason) => typeof reason?.path === "string" && reason.path.startsWith(".changeset/"),
    ) &&
    createImpactPlan(plan.changedFiles.filter((path) => !path.startsWith(".changeset/"))).mode ===
      "focused";
  const selectDirect = plan.mode === "focused" || changesetOnlyFull;
  // Inventory tests read other packages' sources, so the impact plan may not
  // list them for a change in their area; they only need to exist.
  const pinned = PR_INVENTORY_TESTS.filter(
    ({ test, areas }) =>
      plan.mode !== "docs" &&
      exists(test) &&
      plan.changedFiles.some((path) => areas.some((area) => path.startsWith(area))),
  ).map(({ test }) => test);
  const unitTests = [
    ...pinned,
    ...(selectDirect
      ? direct.filter((path) => !pinned.includes(path)).slice(0, PR_UNIT_FILE_CAP)
      : []),
  ];
  // Full impact lists every workspace as affected, so it builds the bundle too.
  const webBundle =
    plan.mode !== "docs" &&
    (plan.mode === "full" ||
      !Array.isArray(plan.affectedPackages) ||
      plan.affectedPackages.some((name) => PR_WEB_BUNDLE_PACKAGES.includes(name)));
  return {
    ...plan,
    unitTests,
    prWebBundle: webBundle,
    prAdmissionUnits: {
      policy: "direct-packages-capped-v2",
      reason:
        plan.mode === "full" && !changesetOnlyFull
          ? "broad-impact-deferred-to-batch"
          : plan.mode === "docs"
            ? "docs-no-admission-units"
            : direct.length === 0
              ? "no-direct-package-units"
              : direct.length > PR_UNIT_FILE_CAP
                ? "direct-package-cap"
                : "direct-packages",
      cap: PR_UNIT_FILE_CAP,
      originalCount: inventory.length,
      directCount: direct.length,
      inventoryTests: pinned,
      selectedCount: unitTests.length,
      deferredCount: inventory.filter((path) => !unitTests.includes(path)).length,
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--plan" || args[2] !== "--output")
    throw new Error("usage: pr-fast-plan.ts --plan <impact.json> --output <pr-plan.json>");
  const plan = JSON.parse(readFileSync(args[1]!, "utf8")) as ImpactPlan;
  const selected = selectPrFastPlan(
    plan,
    createWorkspaceGraph().packages.map((pkg) => pkg.dir),
  );
  writeFileSync(args[3]!, JSON.stringify(selected, null, 2));
  console.log(JSON.stringify(selected.prAdmissionUnits));
}
