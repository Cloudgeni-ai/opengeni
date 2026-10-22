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
  executedScripts,
  executionStatus,
  expectedUnits,
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

const git = (...args: string[]) => {
  const child = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return child.stdout.toString();
};
const head = () => trackedBlobs(git("ls-tree", "-r", "-z", "--full-tree", "HEAD"));

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
    const oid = new Bun.CryptoHasher("sha1")
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest("hex");
    const baseRecipe = recipePaths(blobs, read);
    const candidateRecipe = recipePaths(new Map(blobs).set(path, oid), (file) =>
      file === path ? text : read(file),
    );
    expect(digest(candidateRecipe)).not.toBe(digest(baseRecipe));
    const plan = executionPlan({
      schemaVersion: 1,
      unitTests: [],
      typecheckProjects: [],
      guards: ["public-api"],
      exampleBuildProjects: [],
      buildPackages: [],
    });
    const identity = {
      batchId: "a".repeat(64),
      headSha: "b".repeat(40),
      runId: "1",
      runAttempt: 1,
    };
    const evidence = (purpose: string, guards: number, recipe: [string, string | null][]) =>
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
            steps: SOURCE_STEPS.map((step) => ({ step, exitCode: step === "guards" ? guards : 0 })),
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
    const candidate = evidence("candidate", 1, candidateRecipe);
    expect(base.coverage.complete && candidate.coverage.complete).toBe(true);
    expect(
      compareFailures({ outcome: "code_failure", evidence: candidate }, { evidence: base }),
    ).toMatchObject({ verdict: "not-comparable" });
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
