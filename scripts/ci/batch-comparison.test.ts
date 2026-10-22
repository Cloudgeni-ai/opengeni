import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executionPlan } from "../merge-batcher/base-comparison";
import { digest } from "../merge-batcher/model";
import {
  executionStatus,
  expectedUnits,
  RECIPE_ENTRIES,
  recipePaths,
  trackedBlobs,
} from "./batch-comparison";
import { classifyBatchExit } from "./batch-result";
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
