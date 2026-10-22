import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMPARISON_SCHEMA,
  compareFailures,
  executionPlan,
  SOURCE_STEPS,
} from "../merge-batcher/base-comparison";
import { digest } from "../merge-batcher/model";
import { allowlisted, validateAllowlist } from "../public-api/surface";
import {
  configExtends,
  executedScripts,
  executionStatus,
  expectedUnits,
  harnessConfigs,
  lintPlugins,
  policyInputs,
  RECIPE_ENTRIES,
  recipePaths,
  trackedBlobs,
} from "./batch-comparison";
import { buildComparisonEvidence, classifyBatchExit } from "./batch-result";
import {
  deterministicUnitTestShards,
  shardProcessPlan,
  UNIT_PROCESS_CATEGORIES,
} from "./run-unit-shard";
import { HARNESS_TYPECHECK_PROJECTS, typecheckConfig, typecheckProjects } from "./workspace";

const git = (...args: string[]) => {
  const child = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return child.stdout.toString();
};
const head = () => trackedBlobs(git("ls-tree", "-r", "-z", "--full-tree", "HEAD"));
const blobId = (text: string) =>
  new Bun.CryptoHasher("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
/**
 * Compares a candidate whose source `step` failed with a base on which it
 * passed, each with complete evidence under its own recipe.
 */
const sourceStepComparison = (
  step: (typeof SOURCE_STEPS)[number],
  baseRecipe: [string, string | null][],
  candidateRecipe: [string, string | null][],
) => {
  const plan = executionPlan({
    schemaVersion: 1,
    unitTests: [],
    typecheckProjects: step === "typecheck" ? ["scripts/operator"] : [],
    guards: step === "guards" ? ["public-api"] : [],
    exampleBuildProjects: [],
    buildPackages: [],
  });
  const identity = {
    batchId: "a".repeat(64),
    headSha: "b".repeat(40),
    runId: "1",
    runAttempt: 1,
  };
  const evidence = (purpose: string, failed: number, recipe: [string, string | null][]) =>
    buildComparisonEvidence({
      identity,
      unitShards: 0,
      verifiedJobs: ["plan", "source"],
      sidecars: [
        {
          schemaVersion: 1,
          comparisonSchema: COMPARISON_SCHEMA,
          ...identity,
          job: "source",
          environment: { runnerOs: "Linux" },
          steps: SOURCE_STEPS.map((name) => ({ step: name, exitCode: name === step ? failed : 0 })),
        },
      ],
      batch: { purpose, baseSha: "c".repeat(40), planDigest: digest(plan) },
      plan,
      inventory: {
        schemaVersion: 1,
        comparisonSchema: COMPARISON_SCHEMA,
        planDigest: digest(plan),
        shards: 0,
        absent: [],
        units: [],
        recipePaths: recipe,
      },
    })!;
  const base = evidence("base-comparison", 0, baseRecipe);
  const candidate = evidence("candidate", step === "typecheck" ? 2 : 1, candidateRecipe);
  expect(base.coverage.complete && candidate.coverage.complete).toBe(true);
  return compareFailures({ outcome: "code_failure", evidence: candidate }, { evidence: base });
};

describe("execution statuses", () => {
  test("only an ordinary assertion exit is a failure verdict", () => {
    expect(executionStatus(0)).toBe("pass");
    expect(executionStatus(1)).toBe("fail");
    expect(executionStatus(70)).toBe("fail");
    expect(executionStatus(124)).toBe("timeout");
    for (const code of [130, 137, 143, -1]) expect(executionStatus(code)).toBe("killed");
    for (const code of [75, 126, 127]) expect(executionStatus(code)).toBe("infrastructure");
    expect(executionStatus(null)).toBe("not-run");
    // Consistent with the verdict-bearing receipt classification.
    for (const code of [0, 1, 2, 70, 75, 124, 126, 127, 130, 137, 143, 200])
      expect(executionStatus(code) === "fail").toBe(
        classifyBatchExit(code).outcome === "code_failure",
      );
  });
});

describe("recipe identity", () => {
  test("binds the harness import closure, workflow, toolchain, lockfile and manifests", () => {
    const blobs = head();
    const paths = recipePaths(blobs, (path) => readFileSync(path, "utf8"));
    const names = paths.map(([path]) => path);
    expect(names).toEqual([...names].sort());
    for (const required of [
      ...RECIPE_ENTRIES,
      ".github/workflows/batch-ci.yml",
      ".bun-version",
      "bun.lock",
      "package.json",
      "scripts/ci/workspace.ts",
      "scripts/ci/resource-budget.ts",
      "scripts/merge-batcher/base-comparison.ts",
      "packages/testing/src/shared-pg.ts",
    ])
      expect(names).toContain(required);
    expect(
      names.some((path) => path.startsWith("packages/") && path.endsWith("/package.json")),
    ).toBe(true);
    for (const [path, oid] of paths)
      expect(oid ?? blobs.get(path) ?? null).toBe(blobs.get(path) ?? null);
    // Tests and product code are what is being compared, never recipe.
    expect(names.some((path) => path.endsWith(".test.ts"))).toBe(false);
  });

  test("any change to a harness file changes the recipe; an unresolvable import fails closed", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    const before = digest(recipePaths(blobs, read));
    const changed = new Map(blobs).set("scripts/ci/resource-budget.ts", "0".repeat(40));
    expect(digest(recipePaths(changed, read))).not.toBe(before);
    const lock = new Map(blobs).set("bun.lock", "0".repeat(40));
    expect(digest(recipePaths(lock, read))).not.toBe(before);
    expect(() =>
      recipePaths(blobs, (path) =>
        path === "scripts/ci/batch-source.ts" ? 'import "./missing-harness";' : read(path),
      ),
    ).toThrow("Unresolvable batch harness import");
    const missing = new Map(blobs);
    missing.delete("scripts/ci/batch-setup.ts");
    expect(() => recipePaths(missing, read)).toThrow("not tracked");
  });

  test("harness scripts run as subprocesses or package scripts are recipe", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    const before = recipePaths(blobs, read);
    const names = before.map(([path]) => path);
    for (const path of [
      // Spawned by the source and guard runners, never imported by them.
      "scripts/typecheck.ts",
      "scripts/generate-site-browser-runtime.ts",
      "scripts/check-migration-online-safety.ts",
      "scripts/check-workspace-billing-static.ts",
      // Imported by an executed script.
      "scripts/migration-online-safety.ts",
      // Tool configuration the source steps read.
      ".oxlintrc.json",
      ".oxfmtrc.json",
      ".changeset/config.json",
      "tsconfig.base.json",
    ]) {
      expect(names).toContain(path);
      const changed = new Map(blobs).set(path, "0".repeat(40));
      expect(digest(recipePaths(changed, read))).not.toBe(digest(before));
    }
    // Product code a guard loads to inspect (the public-API check imports the
    // API app) is what is compared, never recipe; only the harness's own test
    // database helper is imported from outside scripts/.
    expect(names.filter((path) => !path.startsWith("scripts/") && /\.tsx?$/.test(path))).toEqual([
      "packages/testing/src/shared-pg.ts",
    ]);
    expect(blobs.has("apps/api/src/app.ts")).toBe(true);
    const product = new Map(blobs).set("apps/api/src/app.ts", "0".repeat(40));
    expect(digest(recipePaths(product, read))).toBe(digest(before));
  });

  test("execution edges: spawned, run by name, nested, untracked and outside the harness", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    const extra: Record<string, string> = {
      // A new harness script spawned by the source runner, importing a helper
      // that itself spawns a package script by name.
      "scripts/ci/batch-source.ts": `${read("scripts/ci/batch-source.ts")}\nconst x = ["bun", "scripts/new-harness.ts"];\nconst y = ["bun", "apps/api/src/spawned-product.ts"];\n`,
      "scripts/new-harness.ts": 'import "./new-helper";\n',
      "scripts/new-helper.ts": 'const run = ["bun", "run", "new-script"];\n',
      "package.json": JSON.stringify({
        ...JSON.parse(read("package.json")),
        scripts: {
          ...JSON.parse(read("package.json")).scripts,
          "new-script": "bun run new-nested && bun --silent scripts/new-leaf.ts",
          "new-nested": "bun scripts/new-nested.ts",
        },
      }),
      "scripts/new-leaf.ts": "",
      "scripts/new-nested.ts": "",
      // A workflow step that runs a harness script no entry imports or spawns.
      ".github/workflows/batch-ci.yml": `${read(".github/workflows/batch-ci.yml")}\n# run: bun scripts/new-step.ts\n`,
      "scripts/new-step.ts": "",
    };
    const overlay = (path: string) => extra[path] ?? read(path);
    const tracked = new Map(blobs);
    for (const path of [
      "scripts/new-harness.ts",
      "scripts/new-helper.ts",
      "scripts/new-leaf.ts",
      "scripts/new-nested.ts",
      "scripts/new-step.ts",
    ])
      tracked.set(path, "1".repeat(40));
    const bound = new Map(recipePaths(tracked, overlay));
    for (const path of [
      "scripts/new-harness.ts",
      "scripts/new-helper.ts",
      "scripts/new-leaf.ts",
      "scripts/new-nested.ts",
      "scripts/new-step.ts",
    ])
      expect(bound.get(path)).toBe("1".repeat(40));
    // Product code is never recipe, even when a harness spawns it.
    expect(bound.has("apps/api/src/spawned-product.ts")).toBe(false);
    // An executed script that is not tracked is bound as absent, so adding it
    // later changes the recipe instead of slipping in unbound.
    const untracked = new Map(tracked);
    untracked.delete("scripts/new-leaf.ts");
    const absent = recipePaths(untracked, overlay);
    expect(new Map(absent).get("scripts/new-leaf.ts")).toBeNull();
    expect(digest(absent)).not.toBe(digest(recipePaths(tracked, overlay)));
  });

  test("executed scripts are read from spawn arrays in sources and commands in shell text", () => {
    const scripts = {
      check: "bun run inner && bun scripts/outer.ts",
      inner: "bun --smol ./scripts/inner.ts --flag",
      loop: "bun run loop",
    };
    expect(executedScripts('spawn(["bun", "scripts/a.ts", "--x"]);', false, scripts)).toEqual([
      "scripts/a.ts",
    ]);
    expect(executedScripts("Bun.spawn(['bun', 'run', 'check'])", false, scripts)).toEqual([
      "scripts/outer.ts",
      "scripts/inner.ts",
    ]);
    // Prose in a source names a command without running it.
    expect(executedScripts("// run `bun scripts/a.ts` or bun run check", false, scripts)).toEqual(
      [],
    );
    expect(executedScripts("run: bun scripts/a.ts && bun run check", true, scripts)).toEqual([
      "scripts/a.ts",
      "scripts/outer.ts",
      "scripts/inner.ts",
    ]);
    // Recursion terminates; unknown names bind nothing.
    expect(executedScripts("bun run loop && bun run missing", true, scripts)).toEqual([]);
  });

  test("harness policy inputs read directly are recipe; product data and snapshots are not", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    const before = recipePaths(blobs, read);
    const bound = new Map(before);
    // Read by the public-API guard and the shard planner, never imported.
    for (const path of [
      "scripts/public-api/breaking-changes.json",
      "scripts/ci/e2e-shard-profile.json",
    ]) {
      expect(bound.get(path)).toBe(blobs.get(path)!);
      const changed = new Map(blobs).set(path, "0".repeat(40));
      expect(digest(recipePaths(changed, read))).not.toBe(digest(before));
    }
    // A named harness input that is absent is bound as absent.
    expect(bound.has("scripts/ci/integration-shard-profile.json")).toBe(true);
    expect(bound.get("scripts/ci/integration-shard-profile.json")).toBe(
      blobs.get("scripts/ci/integration-shard-profile.json") ?? null,
    );
    // What guards inspect is compared: the generated API snapshot, catalog
    // data, docs and migrations stay out of the recipe.
    for (const path of [
      "scripts/public-api/surface.gen.json",
      "data/catalog/curated.json",
      "docs/deployment.md",
      "README.md",
      "packages/db/drizzle/0017_sandbox_leases.sql",
    ]) {
      expect(blobs.has(path)).toBe(true);
      expect(bound.has(path)).toBe(false);
      const changed = new Map(blobs).set(path, "0".repeat(40));
      expect(digest(recipePaths(changed, read))).toBe(digest(before));
    }
  });

  test("a guard policy change is a recipe change, so the comparison holds", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    const path = "scripts/public-api/breaking-changes.json";
    const allowlist = validateAllowlist(JSON.parse(read(path)));
    const entry = allowlist[0]!;
    const finding = { id: entry.ids[0]!, breaking: true, message: "reviewed breaking change" };
    const narrowed = allowlist.filter((row) => !row.ids.includes(finding.id));
    // The same finding passes the base policy and fails the candidate policy.
    const baseMajor = entry.removedInMajor - 1;
    expect(allowlisted(finding as never, allowlist, baseMajor)).not.toBeNull();
    expect(allowlisted(finding as never, narrowed, baseMajor)).toBeNull();
    const text = `${JSON.stringify(narrowed, null, 2)}\n`;
    const baseRecipe = recipePaths(blobs, read);
    const candidateRecipe = recipePaths(new Map(blobs).set(path, blobId(text)), (file) =>
      file === path ? text : read(file),
    );
    expect(digest(candidateRecipe)).not.toBe(digest(baseRecipe));
    expect(sourceStepComparison("guards", baseRecipe, candidateRecipe)).toMatchObject({
      verdict: "not-comparable",
    });
  });

  test("a harness typecheck config change is a recipe change, so the comparison holds", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    // A missing type root fails the operator project (TS2688) while every file
    // it compiles is unchanged: the failure belongs to the config, not the code.
    const path = typecheckConfig("scripts/operator");
    const config = Bun.JSONC.parse(read(path)) as { compilerOptions: Record<string, unknown> };
    config.compilerOptions.types = ["opengeni-missing-type-root"];
    const text = `${JSON.stringify(config, null, 2)}\n`;
    const baseRecipe = recipePaths(blobs, read);
    const candidateRecipe = recipePaths(new Map(blobs).set(path, blobId(text)), (file) =>
      file === path ? text : read(file),
    );
    expect(new Map(candidateRecipe).get(path)).toBe(blobId(text));
    expect(digest(candidateRecipe)).not.toBe(digest(baseRecipe));
    expect(sourceStepComparison("typecheck", baseRecipe, candidateRecipe)).toMatchObject({
      verdict: "not-comparable",
    });
    // The same failure with an identical recipe is attributed to the candidate.
    expect(sourceStepComparison("typecheck", baseRecipe, baseRecipe)).toMatchObject({
      verdict: "new-failure-demonstrated",
    });
  });

  test("configs found by composed path are recipe; product package configs are not", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    const before = recipePaths(blobs, read);
    const bound = new Map(before);
    const changes = (changed: Map<string, string>, reader = read) =>
      digest(recipePaths(changed, reader)) !== digest(before);
    // Every harness project the typecheck step can discover is compiled with
    // the config it composes, and each discovered one exists on this tree.
    const harnessProjects = typecheckProjects().filter((project) => project.startsWith("scripts/"));
    expect(harnessProjects).toEqual([...HARNESS_TYPECHECK_PROJECTS]);
    // The runtime configs of the batch controller and of the executed test
    // database helper outside scripts/, found by walking up.
    for (const path of [
      ...HARNESS_TYPECHECK_PROJECTS.map(typecheckConfig),
      "scripts/merge-batcher/tsconfig.json",
      "packages/testing/tsconfig.json",
      "tsconfig.base.json",
    ]) {
      expect(bound.get(path)).toBe(blobs.get(path)!);
      expect(changes(new Map(blobs).set(path, "0".repeat(40)))).toBe(true);
    }
    // Configs consulted on the way up that do not exist are bound as absent, so
    // adding one (which would take over those sources) changes the recipe.
    for (const path of ["scripts/tsconfig.json", "scripts/jsconfig.json", "tsconfig.json"]) {
      expect(blobs.has(path)).toBe(false);
      expect(bound.has(path)).toBe(true);
      expect(bound.get(path)).toBeNull();
      expect(
        changes(new Map(blobs).set(path, "1".repeat(40)), (file) =>
          file === path ? "{}" : read(file),
        ),
      ).toBe(true);
    }
    // Product package configs are compiled as code under comparison.
    for (const path of ["packages/sdk/tsconfig.json", "apps/api/tsconfig.json"]) {
      expect(blobs.has(path)).toBe(true);
      expect(bound.has(path)).toBe(false);
      expect(changes(new Map(blobs).set(path, "0".repeat(40)))).toBe(false);
    }
    // A harness config's extends chain is followed, with `.json` implied and an
    // untracked link bound as absent.
    const operator = typecheckConfig("scripts/operator");
    const extra: Record<string, string> = {
      [operator]: '{ "extends": "./shared" /* chained */ }',
      "scripts/operator/shared.json": '{ "extends": ["../release/tsconfig.json", "../missing"] }',
    };
    const overlay = (path: string) => extra[path] ?? read(path);
    const chained = new Map(blobs).set("scripts/operator/shared.json", "1".repeat(40));
    const linked = new Map(recipePaths(chained, overlay));
    expect(linked.get("scripts/operator/shared.json")).toBe("1".repeat(40));
    expect(linked.has("scripts/missing.json")).toBe(true);
    expect(linked.get("scripts/missing.json")).toBeNull();
    expect(
      digest(
        recipePaths(new Map(chained).set("scripts/operator/shared.json", "2".repeat(40)), overlay),
      ),
    ).not.toBe(digest(recipePaths(chained, overlay)));
  });

  test("an executed product helper's runtime config is recipe; other product configs are not", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    const before = recipePaths(blobs, read);
    // Bun resolves the helper's imports through its package config: a `paths`
    // entry redirects an import while the helper's bytes are unchanged.
    const path = "packages/testing/tsconfig.json";
    const config = Bun.JSONC.parse(read(path)) as { compilerOptions: Record<string, unknown> };
    config.compilerOptions.paths = { postgres: ["../../scripts/ci/resource-budget.ts"] };
    const text = `${JSON.stringify(config, null, 2)}\n`;
    const after = recipePaths(new Map(blobs).set(path, blobId(text)), (file) =>
      file === path ? text : read(file),
    );
    expect(new Map(before).get(path)).toBe(blobs.get(path)!);
    expect(new Map(after).get(path)).toBe(blobId(text));
    expect(digest(after)).not.toBe(digest(before));
    // Configs of packages the harness does not execute stay compared.
    for (const product of ["packages/db/tsconfig.json", "apps/web/tsconfig.json"]) {
      expect(blobs.has(product)).toBe(true);
      expect(new Map(before).has(product)).toBe(false);
    }
  });

  test("lint and format policy found by name anywhere is recipe", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    const before = recipePaths(blobs, read);
    const bound = new Map(before);
    const changes = (changed: Map<string, string>, reader = read) =>
      digest(recipePaths(changed, reader)) !== digest(before);
    // Every tracked ignore file, root and nested: oxlint and oxfmt skip a
    // tracked file it lists.
    const ignores = [...blobs.keys()].filter((path) => /(^|\/)\.gitignore$/.test(path));
    expect(ignores).toContain(".gitignore");
    expect(ignores).toContain("apps/web/.gitignore");
    for (const path of ignores) {
      expect(bound.get(path)).toBe(blobs.get(path)!);
      expect(changes(new Map(blobs).set(path, "0".repeat(40)))).toBe(true);
    }
    // Adding a policy file the pinned tools honour, in any directory, adds a path.
    for (const path of [
      "apps/web/src/.gitignore",
      ".eslintignore",
      "packages/sdk/.eslintignore",
      ".prettierignore",
      ".editorconfig",
      ".oxlintrc.jsonc",
      "apps/web/.oxlintrc.json",
      "packages/sdk/.oxfmtrc.json",
      "oxfmt.config.ts",
      "oxlint.config.mjs",
    ]) {
      expect(blobs.has(path)).toBe(false);
      const added = recipePaths(new Map(blobs).set(path, "1".repeat(40)), (file) =>
        file === path ? "{}" : read(file),
      );
      expect(new Map(added).get(path)).toBe("1".repeat(40));
      expect(digest(added)).not.toBe(digest(before));
    }
    // Files the pinned tools do not consult stay compared.
    for (const path of [".gitattributes", "agent/.gitattributes"]) {
      expect(blobs.has(path)).toBe(true);
      expect(bound.has(path)).toBe(false);
    }
    for (const path of [".oxlintignore", ".oxfmtignore", ".ignore", ".prettierrc"])
      expect(changes(new Map(blobs).set(path, "1".repeat(40)))).toBe(false);
    // An oxlint config's extends chain and local plugins are followed; plugins
    // are executed code with their own harness imports, and an untracked one is absent.
    const extra: Record<string, string> = {
      ".oxlintrc.json": JSON.stringify({
        ...(Bun.JSONC.parse(read(".oxlintrc.json")) as object),
        extends: ["./scripts/lint/base.json"],
        jsPlugins: ["./scripts/lint/plugin.ts", { specifier: "./scripts/lint/obj.ts" }, "pkg"],
      }),
      "scripts/lint/base.json": "{}",
      "scripts/lint/plugin.ts": 'import "./helper";\n',
      "scripts/lint/helper.ts": "",
    };
    const overlay = (path: string) => extra[path] ?? read(path);
    const tracked = new Map(blobs);
    for (const path of [
      "scripts/lint/base.json",
      "scripts/lint/plugin.ts",
      "scripts/lint/helper.ts",
    ])
      tracked.set(path, "2".repeat(40));
    const linked = new Map(recipePaths(tracked, overlay));
    for (const path of [
      "scripts/lint/base.json",
      "scripts/lint/plugin.ts",
      "scripts/lint/helper.ts",
    ])
      expect(linked.get(path)).toBe("2".repeat(40));
    expect(linked.has("scripts/lint/obj.ts")).toBe(true);
    expect(linked.get("scripts/lint/obj.ts")).toBeNull();
    expect(lintPlugins(".oxlintrc.json", "{ not json")).toEqual([]);
    expect(lintPlugins("a/.oxlintrc.json", '{"jsPlugins":"./x.js"}')).toEqual([]);
  });

  test("an ignore policy change is a recipe change, so the comparison holds", () => {
    const blobs = head();
    const read = (path: string) => readFileSync(path, "utf8");
    // Unlisting a tracked file from a nested ignore file makes lint and format
    // check it (exit 0 -> 1 and 2 with the pinned tools) with every file it
    // checks unchanged.
    const path = "apps/web/.gitignore";
    const text = read(path).replace(/\n[^\n]*\n?$/, "\n");
    expect(text).not.toBe(read(path));
    const baseRecipe = recipePaths(blobs, read);
    const candidateRecipe = recipePaths(new Map(blobs).set(path, blobId(text)), (file) =>
      file === path ? text : read(file),
    );
    expect(digest(candidateRecipe)).not.toBe(digest(baseRecipe));
    expect(sourceStepComparison("guards", baseRecipe, candidateRecipe)).toMatchObject({
      verdict: "not-comparable",
    });
  });

  test("composed configs: typecheck roots, nearest runtime config walking up, extends", () => {
    const oid = "1".repeat(40);
    const blobs = new Map(
      ["scripts/a/tsconfig.json", "scripts/j/jsconfig.json", "packages/t/tsconfig.json"].map(
        (path) => [path, oid],
      ),
    );
    // Every given (bound, executed) source walks, including a product helper
    // the harness imports; nothing else is consulted.
    const configs = harnessConfigs(
      ["scripts/a/b/x.ts", "scripts/a/y.ts", "scripts/j/z.ts", "packages/t/src/helper.ts"],
      blobs,
    );
    expect(configs.sort()).toEqual(
      [
        ...HARNESS_TYPECHECK_PROJECTS.map(typecheckConfig),
        "scripts/a/b/tsconfig.json",
        "scripts/a/b/jsconfig.json",
        "scripts/a/tsconfig.json",
        "scripts/j/tsconfig.json",
        "scripts/j/jsconfig.json",
        "packages/t/src/tsconfig.json",
        "packages/t/src/jsconfig.json",
        "packages/t/tsconfig.json",
      ].sort(),
    );
    // A root-level harness source walks to the repository root.
    expect(
      harnessConfigs(["scripts/x.ts"], new Map()).filter((path) => !path.includes("/")),
    ).toEqual(["tsconfig.json", "jsconfig.json"]);
    const tracked = new Map([["scripts/a/base", oid]]);
    expect(configExtends("scripts/a/tsconfig.json", '{"extends":"./base"}', tracked)).toEqual([
      "scripts/a/base",
    ]);
    expect(
      configExtends(
        "scripts/a/tsconfig.json",
        '{\n  // comment\n  "extends": ["../../tsconfig.base.json", "./other", "@tsconfig/bun"],\n}',
        tracked,
      ),
    ).toEqual(["tsconfig.base.json", "scripts/a/other.json"]);
    expect(configExtends("scripts/a/tsconfig.json", "{ not json", tracked)).toEqual([]);
    expect(configExtends("scripts/a/tsconfig.json", "null", tracked)).toEqual([]);
  });

  test("policy inputs: named, relative or beside, in code only, inside the harness", () => {
    const oid = "1".repeat(40);
    const blobs = new Map(
      [
        "scripts/x/policy.json",
        "scripts/x/beside.json",
        "scripts/y/up.jq",
        "scripts/x/api.gen.json",
        "docs/rules.md",
      ].map((path) => [path, oid]),
    );
    const source = [
      '/** Reads "scripts/x/commented.json" only in prose. */',
      'const a = readFileSync("scripts/x/policy.json");',
      'const b = readFileSync(join(import.meta.dir, "beside.json"));',
      'const c = new URL("../y/up.jq", import.meta.url);',
      'const d = "scripts/x/api.gen.json";',
      'const e = "docs/rules.md";',
      'const f = "scripts/x/missing.json";',
      'const g = "not-beside.json";',
      'const h = "scripts/x/other.ts";',
      "// readFileSync('scripts/x/line-comment.json')",
    ].join("\n");
    const inputs = policyInputs("scripts/x/check.ts", source, blobs);
    expect(inputs.tracked.sort()).toEqual([
      "scripts/x/beside.json",
      "scripts/x/policy.json",
      "scripts/y/up.jq",
    ]);
    expect(inputs.absent).toEqual(["scripts/x/missing.json"]);
  });

  test("tree listings keep only blobs and reject unreadable entries", () => {
    const sha = "a".repeat(40);
    expect(trackedBlobs(`100644 blob ${sha}\tx y.ts\u0000160000 commit ${sha}\tsub\0`)).toEqual(
      new Map([["x y.ts", sha]]),
    );
    expect(() => trackedBlobs("garbage\0")).toThrow("Unreadable");
  });
});

describe("expected inventory", () => {
  test("is exactly the processes run-unit-shard starts for every shard", () => {
    const unitTests = [...head().keys()]
      .filter((path) => path.startsWith("scripts/ci/") && path.endsWith(".test.ts"))
      .slice(0, 12);
    const plan = executionPlan({
      schemaVersion: 1,
      unitTests,
      typecheckProjects: [],
      guards: [],
      exampleBuildProjects: [],
      buildPackages: [],
    });
    const root = process.cwd();
    const expected = expectedUnits(root, plan, 3, 1);
    const actual = deterministicUnitTestShards(root, plan.unitTests, 3).flatMap((selected) => {
      const processes = shardProcessPlan(root, selected, 1);
      return UNIT_PROCESS_CATEGORIES.flatMap((category) =>
        processes[category].map((task) => ({ category, files: task.files })),
      );
    });
    expect(expected).toEqual(actual);
    expect(expected.flatMap((unit) => unit.files).sort()).toEqual(plan.unitTests);
    expect(expectedUnits(root, { ...plan, unitTests: [] }, 0, 1)).toEqual([]);
    expect(() => expectedUnits(root, plan, 17, 1)).toThrow("shard count");
  });
});

describe("CLI", () => {
  const run = (args: string[]) =>
    Bun.spawnSync([process.execPath, "scripts/ci/batch-comparison.ts", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GITHUB_SHA: git("rev-parse", "HEAD").trim() },
    });
  const plan = {
    schemaVersion: 1 as const,
    unitTests: ["scripts/ci/batch-result.test.ts"],
    typecheckProjects: [],
    guards: [],
    exampleBuildProjects: [],
    buildPackages: [],
  };

  test("freeze runs only a verified frozen base plan whose files all exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "batch-comparison-cli-"));
    try {
      const manifest = join(directory, "batch.json");
      const output = join(directory, "plan.json");
      const write = (value: unknown) => writeFileSync(manifest, JSON.stringify(value));
      write({ purpose: "base-comparison", planDigest: digest(plan), plan });
      expect(run(["freeze", "--manifest", manifest, "--output", output]).exitCode).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(plan);
      // Absent planned file: the whole base is non-comparable infrastructure.
      const absent = { ...plan, unitTests: ["scripts/ci/batch-result.test.ts", "zz-new.test.ts"] };
      write({ purpose: "base-comparison", planDigest: digest(absent), plan: absent });
      const result = run(["freeze", "--manifest", manifest, "--output", join(directory, "x.json")]);
      expect(result.exitCode).toBe(75);
      expect(result.stderr.toString()).toContain("zz-new.test.ts");
      write({ purpose: "base-comparison", planDigest: "0".repeat(64), plan });
      expect(run(["freeze", "--manifest", manifest, "--output", output]).exitCode).toBe(75);
      write({ purpose: "candidate", planDigest: digest(plan), plan });
      expect(run(["freeze", "--manifest", manifest, "--output", output]).exitCode).toBe(75);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("inventory records plan digest, expected units and recipe of the exact checkout", () => {
    const directory = mkdtempSync(join(tmpdir(), "batch-comparison-inventory-"));
    try {
      writeFileSync(join(directory, "plan.json"), JSON.stringify(plan));
      const output = join(directory, "inventory.json");
      const result = run([
        "inventory",
        "--plan",
        join(directory, "plan.json"),
        "--shards",
        "1",
        "--output",
        output,
      ]);
      expect(result.exitCode).toBe(0);
      const inventory = JSON.parse(readFileSync(output, "utf8"));
      expect(inventory).toMatchObject({
        schemaVersion: 1,
        comparisonSchema: "batch-base-comparison/v1",
        planDigest: digest(plan),
        shards: 1,
        absent: [],
        units: [{ category: "parallel", files: ["scripts/ci/batch-result.test.ts"] }],
      });
      expect(inventory.recipePaths.length).toBeGreaterThan(10);
      const wrongCheckout = Bun.spawnSync(
        [
          process.execPath,
          "scripts/ci/batch-comparison.ts",
          "inventory",
          "--plan",
          join(directory, "plan.json"),
          "--shards",
          "1",
          "--output",
          output,
        ],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, GITHUB_SHA: "0".repeat(40) } },
      );
      expect(wrongCheckout.exitCode).toBe(75);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
