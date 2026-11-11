import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import {
  BROWSER_ACCEPTANCE_TESTS,
  createImpactPlan,
  directTestWorkspaces,
  type ImpactPlan,
} from "./impact";
import {
  createWorkspaceGraph,
  e2eShardWeights,
  workspaceForPath,
  type WorkspaceGraph,
} from "./workspace";

export const PR_UNIT_FILE_CAP = 40;
/**
 * PR E2E budgets, in estimated serial seconds from the E2E shard profile.
 * Authored tests (changed, or importing a changed helper or fixture) may use
 * the whole budget; tests that only depend directly on a touched workspace
 * fill at most one shard. Batch still runs the complete impacted set.
 *
 * A shard's measured time has run up to about 1.6 times its profile estimate
 * (slower runners, timings measured on older trees), so the target is half
 * the shard deadline: a PR shard must not time out on estimate error alone.
 */
/** At most this many PR E2E shard jobs; Batch uses up to eight. */
export const PR_E2E_SHARD_CAP = 4;
/** The E2E shard deadline (ci-e2e-shards.yml `--timeout-seconds`). */
export const E2E_SHARD_DEADLINE_SECONDS = 720;
/** Target estimated seconds per PR E2E shard. */
export const PR_E2E_SHARD_TARGET_SECONDS = E2E_SHARD_DEADLINE_SECONDS / 2;
export const PR_E2E_BUDGET_SECONDS = PR_E2E_SHARD_CAP * PR_E2E_SHARD_TARGET_SECONDS;
export const PR_E2E_DIRECT_BUDGET_SECONDS = PR_E2E_SHARD_TARGET_SECONDS;
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
    test: "scripts/check-migration-immutability.test.ts",
    areas: ["packages/db/drizzle/", "scripts/check-migration-immutability"],
  },
  // Judges the real 1283 migration by the real runtime-posture declarations,
  // and the CLI against a temporary git history.
  {
    test: "scripts/check-migration-previous-release.test.ts",
    areas: [
      "packages/db/src/runtime-posture",
      "packages/db/src/migration-sql",
      "scripts/migration-previous-release",
      "scripts/check-migration-previous-release",
      "scripts/migration-deployment-mode",
      "scripts/migration-rls-backfills",
      "scripts/runtime-posture-baseline",
      "packages/db/src/migration-phases",
    ],
  },
  // The expected test inventory: a new root e2e file must be registered.
  {
    test: "scripts/ci/impact.test.ts",
    areas: ["test/", "scripts/ci/impact", "scripts/run-browser-e2e.ts"],
  },
  // Byte locks of the composed system prompt, which most runtime sources feed.
  {
    test: "packages/runtime/test/agent-instructions/legacy-prompt-lock.test.ts",
    areas: ["packages/runtime/src/", "packages/contracts/src/"],
  },
  {
    test: "scripts/catalog-curation.test.ts",
    areas: ["data/catalog/", "scripts/catalog-curation", "scripts/import-integrations-catalog"],
  },
  // These execute or inspect one production source file by its path.
  {
    test: "apps/worker/test/text-verbosity.test.ts",
    areas: ["apps/worker/src/activities/agent-turn/claim.ts"],
  },
  {
    test: "apps/api/test/channel-a-routes.test.ts",
    areas: ["apps/api/src/sandbox/channel-a.ts"],
  },
];

/** Workspaces whose change can break the production web bundle Batch builds. */
export const PR_WEB_BUNDLE_PACKAGES = ["opengeni-web", "@opengeni/browser-extension"];

type LanePlan = Pick<ImpactPlan, "mode" | "changedFiles" | "e2eTests" | "browserAcceptanceLanes">;
type BrowserLane = ImpactPlan["browserAcceptanceLanes"][number];

/** The same lane-to-job expansion as ci.yml's `browser_lane_matrix`. */
export function browserLaneMatrix(
  lanes: readonly BrowserLane[],
): { lane: BrowserLane; engine: "chromium" | "firefox" | "webkit" }[] {
  return lanes.flatMap((lane) =>
    (lane === "accounts"
      ? (["chromium", "firefox", "webkit"] as const)
      : (["chromium"] as const)
    ).map((engine) => ({ lane, engine })),
  );
}

/** The same shard list shape as ci.yml's `e2e_matrix`. */
export function shardMatrix(total: number) {
  return Array.from({ length: total }, (_, index) => ({ index, number: index + 1, total }));
}

const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

/**
 * Repository files outside every workspace (shared E2E helpers and fixtures)
 * that a test reaches through relative imports, followed transitively.
 */
export function repositoryHelperImports(
  test: string,
  graph: WorkspaceGraph,
  read: (path: string) => string | null = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null; // Missing, or a directory.
    }
  },
): string[] {
  const seen = new Set<string>();
  const pending = [test];
  while (pending.length > 0) {
    const from = pending.pop()!;
    const source = read(from);
    if (source === null) continue;
    const loader = from.endsWith(".tsx") ? "tsx" : from.endsWith(".js") ? "js" : "ts";
    let specifiers: string[];
    try {
      specifiers = new Bun.Transpiler({ loader }).scanImports(source).map(({ path }) => path);
    } catch {
      continue; // Not a parseable module (for example JSON); nothing to follow.
    }
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const base = normalize(join(dirname(from), specifier));
      const resolved = SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`).find(
        (candidate) => read(candidate) !== null,
      );
      if (!resolved || seen.has(resolved) || workspaceForPath(graph, resolved)) continue;
      seen.add(resolved);
      pending.push(resolved);
    }
  }
  return [...seen].sort();
}

export type PrBrowserE2eContext = {
  /** Workspaces that own a changed file. */
  touchedWorkspaces: ReadonlySet<string>;
  /** A test's own or declared/imported workspaces; null when unmapped. */
  testWorkspaces: (test: string) => readonly string[] | null;
  /** Repository files outside workspaces (helpers, fixtures) a test imports. */
  testHelpers: (test: string) => readonly string[];
  /** Estimated serial seconds of one E2E file. */
  seconds: (test: string) => number;
  laneTests: Readonly<Record<BrowserLane, readonly string[]>>;
};

/**
 * Files that define how a lane runs (its reusable job, its PR caller and its
 * runners). Changing one runs that lane on the PR even when no test changed,
 * so a broken lane definition fails the PR rather than a batch.
 */
export const PR_LANE_DEFINITIONS = {
  e2e: [
    ".github/workflows/ci-e2e-shards.yml",
    ".github/workflows/pr-ci.yml",
    ".github/actions/playwright-browsers/",
    "scripts/ci/run-test-shard.ts",
    "scripts/run-browser-e2e.ts",
  ],
  browser: [
    ".github/workflows/ci-browser-acceptance.yml",
    ".github/workflows/pr-ci.yml",
    ".github/actions/playwright-browsers/",
    "scripts/run-browser-e2e.ts",
  ],
} as const;

/**
 * The E2E files and browser acceptance lanes PR CI runs, so a PR's own
 * deterministic browser failure is found before it can fail a batch of PRs.
 * Batch still runs the complete impacted set; this only runs part of it first.
 *
 * Batch impact is transitive, so most product changes select nearly every
 * browser test, too many to run on every PR push. The PR runs, from the
 * impacted set:
 * - authored tests: a changed test, or one importing a changed helper or
 *   fixture, in E2E and in the browser acceptance lanes;
 * - a sample of the E2E tests that depend directly on a touched workspace,
 *   cheapest first, within one shard's budget;
 * - when a lane's own definition changes (PR_LANE_DEFINITIONS), that lane:
 *   every impacted browser lane, or the cheapest one-shard E2E sample.
 * A CI or toolchain fence does not hide either. Whatever does not fit is
 * listed as deferred to Batch.
 */
export function selectPrBrowserE2e(plan: LanePlan, context: PrBrowserE2eContext) {
  const changed = new Set(plan.changedFiles);
  const defines = (paths: readonly string[]) =>
    plan.changedFiles.some((file) =>
      paths.some((path) => file === path || (path.endsWith("/") && file.startsWith(path))),
    );
  const e2eDefinition = defines(PR_LANE_DEFINITIONS.e2e);
  const browserDefinition = defines(PR_LANE_DEFINITIONS.browser);
  const authored = (test: string) =>
    changed.has(test) || context.testHelpers(test).some((path) => changed.has(path));
  const direct = (test: string) =>
    e2eDefinition ||
    (context.testWorkspaces(test) ?? []).some((name) => context.touchedWorkspaces.has(name));
  const impacted = [...new Set(plan.e2eTests)];
  const cost = new Map(impacted.map((path) => [path, Math.max(0, context.seconds(path))]));
  const cheapest = (a: string, b: string) =>
    cost.get(a)! - cost.get(b)! || (a < b ? -1 : a > b ? 1 : 0);
  const authoredTests = impacted.filter(authored).sort(cheapest);
  const directTests = impacted.filter((path) => !authored(path) && direct(path)).sort(cheapest);
  const e2eTests: string[] = [];
  let estimatedSeconds = 0;
  const fill = (tests: readonly string[], budget: number) => {
    for (const path of tests) {
      if (estimatedSeconds + cost.get(path)! > budget) continue;
      e2eTests.push(path);
      estimatedSeconds += cost.get(path)!;
    }
  };
  fill(authoredTests, PR_E2E_BUDGET_SECONDS);
  fill(
    directTests,
    Math.min(PR_E2E_BUDGET_SECONDS, estimatedSeconds + PR_E2E_DIRECT_BUDGET_SECONDS),
  );
  e2eTests.sort();
  const selected = new Set(e2eTests);
  const deferred = (tests: readonly string[]) => tests.filter((path) => !selected.has(path)).sort();
  const e2eShards =
    e2eTests.length === 0
      ? 0
      : Math.min(
          PR_E2E_SHARD_CAP,
          e2eTests.length,
          Math.max(1, Math.ceil(estimatedSeconds / PR_E2E_SHARD_TARGET_SECONDS)),
        );
  const browserAcceptanceLanes = plan.browserAcceptanceLanes.filter(
    (lane) => browserDefinition || (context.laneTests[lane] ?? []).some(authored),
  );
  return {
    e2eTests,
    e2eShards,
    browserAcceptanceLanes,
    summary: {
      policy: "authored-plus-direct-sample-v1",
      laneDefinitionsChanged: { e2e: e2eDefinition, browser: browserDefinition },
      e2eImpactedCount: impacted.length,
      e2eAuthored: authoredTests.length,
      e2eDirect: directTests.length,
      e2eSelectedCount: e2eTests.length,
      e2eEstimatedSeconds: Math.round(estimatedSeconds),
      e2eShards,
      e2eDeferredAuthored: deferred(authoredTests),
      e2eDeferredDirectCount: deferred(directTests).length,
      browserImpactedLanes: plan.browserAcceptanceLanes,
      browserAcceptanceLanes,
      browserJobCount: browserLaneMatrix(browserAcceptanceLanes).length,
    },
  };
}

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
  const graph = createWorkspaceGraph();
  const selected = selectPrFastPlan(
    plan,
    graph.packages.map((pkg) => pkg.dir),
  );
  // Without a usable profile every file is assumed to take a minute.
  const { weights } = e2eShardWeights();
  const touchedWorkspaces = new Set(
    plan.changedFiles.flatMap((path) => workspaceForPath(graph, path)?.name ?? []),
  );
  const lanes = selectPrBrowserE2e(plan, {
    touchedWorkspaces,
    testWorkspaces: (test) => directTestWorkspaces(test, graph),
    testHelpers: (test) => repositoryHelperImports(test, graph),
    seconds: (path) => (weights?.get(path) ?? 60_000) / 1000,
    laneTests: BROWSER_ACCEPTANCE_TESTS,
  });
  writeFileSync(
    args[3]!,
    JSON.stringify(
      {
        ...selected,
        // run-test-shard.ts reads e2eTests: the PR's selection, not Batch's.
        e2eTests: lanes.e2eTests,
        browserAcceptanceLanes: lanes.browserAcceptanceLanes,
        prBrowserE2e: lanes.summary,
        prE2eMatrix: shardMatrix(lanes.e2eShards),
        prBrowserLaneMatrix: browserLaneMatrix(lanes.browserAcceptanceLanes),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(selected.prAdmissionUnits));
  console.log(JSON.stringify(lanes.summary));
}
