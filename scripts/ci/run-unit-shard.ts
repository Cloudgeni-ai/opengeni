#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ImpactPlan } from "./impact";
import {
  describeTestConcurrencyBudget,
  testConcurrencyBudget,
  type TestConcurrencyBudget,
} from "./resource-budget";
import {
  deterministicFileBatches,
  deterministicShards,
  fileUsesProcessGlobalTestState,
} from "./workspace";

export type UnitTestProcess = {
  files: string[];
  isolated: boolean;
};

export type UnitTestProcessPlan = {
  parallel: UnitTestProcess[];
  explicitConcurrency: UnitTestProcess[];
  wallClockSensitive: UnitTestProcess[];
  sharedPostgresExclusive: UnitTestProcess[];
  clusterRoleSensitive: UnitTestProcess[];
};

export function sanitizedTestEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const requireRealDatabase = environment.OPENGENI_REQUIRE_REAL_DB === "1";
  for (const name of Object.keys(environment)) {
    if (name.startsWith("OPENGENI_")) delete environment[name];
  }
  environment.NODE_ENV = "test";
  environment.OPENGENI_TEST_HERMETIC = "1";
  // CI sets this parent flag for the full unit shard because package-local
  // PostgreSQL/FORCE-RLS tests use the unit filename convention. Preserve only
  // the exact fail-closed boolean; all other ambient OpenGeni state stays
  // scrubbed. Local focused checks remain infrastructure-free unless their
  // caller deliberately requires the real database boundary.
  if (requireRealDatabase) environment.OPENGENI_REQUIRE_REAL_DB = "1";
  return environment;
}

export function sourceUsesExplicitTestConcurrency(source: string): boolean {
  return (
    /\.\s*concurrent\b|\[\s*["']concurrent["']\s*\]/.test(source) ||
    /\{[^}]*\bconcurrent\b[^}]*\}\s*=\s*(?:test|it|describe)\b/.test(source)
  );
}

export function sourceUsesWallClockPerformanceAssertion(source: string): boolean {
  return (
    /\b(?:Bun\.nanoseconds|performance\.now|Date\.now)\s*\(/.test(source) &&
    /\.toBeLessThan(?:OrEqual)?\s*\(/.test(source)
  );
}

export function sourceRequiresExclusiveSharedPostgres(source: string): boolean {
  return /opengeni:test-shared-postgres-exclusive/u.test(source);
}

function sourceProvisionsRolesOnSharedDatabase(source: string): boolean {
  for (const match of source.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*=\s*await\s+acquireSharedTestDatabase\s*\(/g,
  )) {
    const sharedDatabase = match[1]!;
    if (
      new RegExp(`\\bprovisionRoles\\s*\\(\\s*${sharedDatabase}(?:\\s*!\\s*)?\\.adminUrl\\b`).test(
        source,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function sourceMutatesSharedPostgresRole(source: string): boolean {
  return (
    /\b(?:create|alter|drop)\s+role\b/i.test(source) ||
    (/\bacquireBlankTestDatabase\b/.test(source) && /\bprovisionRoles\s*\(/.test(source)) ||
    sourceProvisionsRolesOnSharedDatabase(source)
  );
}

export function planUnitTestProcesses(
  root: string,
  batch: readonly string[],
  isolated: readonly string[],
  batchSize: number,
): UnitTestProcessPlan {
  const sources = new Map(
    [...batch, ...isolated].map((path) => [path, readFileSync(join(root, path), "utf8")] as const),
  );
  const explicitConcurrency = new Set(
    [...sources]
      .filter(([, source]) => sourceUsesExplicitTestConcurrency(source))
      .map(([path]) => path),
  );
  const wallClockSensitive = new Set(
    [...sources]
      .filter(
        ([path, source]) =>
          !explicitConcurrency.has(path) && sourceUsesWallClockPerformanceAssertion(source),
      )
      .map(([path]) => path),
  );
  const sharedPostgresExclusive = new Set(
    [...sources]
      .filter(
        ([path, source]) =>
          !explicitConcurrency.has(path) &&
          !wallClockSensitive.has(path) &&
          sourceRequiresExclusiveSharedPostgres(source),
      )
      .map(([path]) => path),
  );
  const clusterRoleSensitive = new Set(
    [...sources]
      .filter(
        ([path, source]) =>
          !explicitConcurrency.has(path) &&
          !wallClockSensitive.has(path) &&
          !sharedPostgresExclusive.has(path) &&
          sourceMutatesSharedPostgresRole(source),
      )
      .map(([path]) => path),
  );
  const usesExplicitConcurrency = (path: string): boolean => explicitConcurrency.has(path);
  const usesWallClock = (path: string): boolean => wallClockSensitive.has(path);
  const requiresExclusiveSharedPostgres = (path: string): boolean =>
    sharedPostgresExclusive.has(path);
  const mutatesClusterRole = (path: string): boolean => clusterRoleSensitive.has(path);
  const parallelBatch = batch.filter(
    (path) =>
      !usesExplicitConcurrency(path) &&
      !usesWallClock(path) &&
      !requiresExclusiveSharedPostgres(path) &&
      !mutatesClusterRole(path),
  );
  const concurrentBatch = batch.filter(usesExplicitConcurrency);
  const wallClockBatch = batch.filter(usesWallClock);
  const sharedPostgresBatch = batch.filter(requiresExclusiveSharedPostgres);
  const clusterRoleBatch = batch.filter(mutatesClusterRole);
  const parallelIsolated = isolated.filter(
    (path) =>
      !usesExplicitConcurrency(path) &&
      !usesWallClock(path) &&
      !requiresExclusiveSharedPostgres(path) &&
      !mutatesClusterRole(path),
  );
  const concurrentIsolated = isolated.filter(usesExplicitConcurrency);
  const wallClockIsolated = isolated.filter(usesWallClock);
  const sharedPostgresIsolated = isolated.filter(requiresExclusiveSharedPostgres);
  const clusterRoleIsolated = isolated.filter(mutatesClusterRole);
  return {
    parallel: [
      ...deterministicFileBatches(parallelBatch, batchSize).map((files) => ({
        files,
        isolated: false,
      })),
      ...parallelIsolated.map((path) => ({ files: [path], isolated: true })),
    ],
    // Explicitly concurrent tests retain the complete inner Bun concurrency
    // budget and therefore run one process at a time. Ordinary files have no
    // authored concurrent tests, so separate processes may safely share that
    // same total budget with inner concurrency fixed to one.
    explicitConcurrency: [
      ...concurrentBatch.map((path) => ({ files: [path], isolated: false })),
      ...concurrentIsolated.map((path) => ({ files: [path], isolated: true })),
    ],
    // Wall-clock assertions measure the tested operation, not unrelated CPU
    // contention from sibling files. Keep their existing limits unchanged and
    // run those files alone with ordinary serial Bun semantics.
    wallClockSensitive: [
      ...wallClockBatch.map((path) => ({ files: [path], isolated: false })),
      ...wallClockIsolated.map((path) => ({ files: [path], isolated: true })),
    ],
    // A small number of large FORCE-RLS/pgvector suites hold several pools and
    // perform long authority transitions against the shared PostgreSQL fixture.
    // Their explicit marker keeps them off the parallel acquisition path and
    // runs them only after every ordinary sibling process has settled.
    sharedPostgresExclusive: [
      ...sharedPostgresBatch.map((path) => ({ files: [path], isolated: false })),
      ...sharedPostgresIsolated.map((path) => ({ files: [path], isolated: true })),
    ],
    // PostgreSQL roles are cluster-global even when every test file owns a
    // distinct database. Run role-password/DDL mutation tests last and alone,
    // after every shared app-role connection has closed. Each blank-database
    // acquisition then resets the canonical role before its own mutation.
    clusterRoleSensitive: [
      ...clusterRoleBatch.map((path) => ({ files: [path], isolated: false })),
      ...clusterRoleIsolated.map((path) => ({ files: [path], isolated: true })),
    ],
  };
}

export async function runBoundedTestProcesses<T>(
  tasks: readonly T[],
  concurrency: number,
  execute: (task: T, index: number) => Promise<number>,
): Promise<number> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("unit process concurrency must be a positive integer");
  }
  let next = 0;
  let failure = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (failure === 0) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      const task = tasks[index]!;
      const status = await execute(task, index);
      if (status !== 0 && failure === 0) failure = status;
    }
  });
  await Promise.all(workers);
  return failure;
}

async function run(
  task: UnitTestProcess,
  budget: TestConcurrencyBudget,
  processConcurrency: number,
  innerConcurrency: number,
): Promise<number> {
  const { files, isolated } = task;
  if (files.length === 0) return 0;
  // One file worker per runner prevents Bun's CPU-count default from launching
  // the whole repository at once. A fresh global per file contains mock.module,
  // Happy DOM, fake timers, and process-global teardown. Tests within one file
  // remain bounded as well; individual tests are still serial unless authored
  // with test.concurrent.
  const concurrencyArgument =
    innerConcurrency === budget.concurrency
      ? `--max-concurrency=${budget.concurrency}`
      : `--max-concurrency=${innerConcurrency}`;
  const args = [
    "bun",
    "--no-env-file",
    "test",
    "--no-orphans",
    "--timeout=30000",
    concurrencyArgument,
    ...files,
  ];
  process.stdout.write(
    `[unit-shard] ${isolated ? "isolated" : "batch"}: ${describeTestConcurrencyBudget(budget)} processPool=${processConcurrency} innerConcurrency=${innerConcurrency} files=${files.join(", ")}\n`,
  );
  const child = Bun.spawn(args, {
    cwd: process.cwd(),
    env: sanitizedTestEnvironment(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const planIndex = args.indexOf("--plan");
  const shardIndex = args.indexOf("--shard");
  const countIndex = args.indexOf("--shards");
  if (planIndex < 0 || shardIndex < 0 || countIndex < 0) {
    throw new Error("usage: run-unit-shard.ts --plan <json> --shard <index> --shards <count>");
  }
  const planPath = args[planIndex + 1];
  const index = Number(args[shardIndex + 1]);
  const count = Number(args[countIndex + 1]);
  if (
    !planPath ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index < 0 ||
    index >= count
  ) {
    throw new Error("invalid unit shard arguments");
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as ImpactPlan;
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.unitTests)) {
    throw new Error("unsupported or malformed impact plan");
  }
  const selected = deterministicShards(process.cwd(), plan.unitTests, count)[index] ?? [];
  const batch = selected.filter((path) => !fileUsesProcessGlobalTestState(process.cwd(), path));
  const isolated = selected.filter((path) => fileUsesProcessGlobalTestState(process.cwd(), path));
  // One file per Bun process is the measured safe default: larger batches keep
  // process-global test state and heap pages alive across files and raise the
  // full-suite cgroup peak substantially. Measured larger runners may opt into
  // a higher, still deterministic batch size explicitly.
  const configuredBatchSize = Number(process.env.OPENGENI_TEST_FILES_PER_PROCESS ?? "1");
  const budget = testConcurrencyBudget();
  const processes = planUnitTestProcesses(process.cwd(), batch, isolated, configuredBatchSize);
  process.stdout.write(
    `[unit-shard] process plan: ${describeTestConcurrencyBudget(budget)} parallel=${processes.parallel.length} explicitConcurrency=${processes.explicitConcurrency.length} wallClockSensitive=${processes.wallClockSensitive.length} sharedPostgresExclusive=${processes.sharedPostgresExclusive.length} clusterRoleSensitive=${processes.clusterRoleSensitive.length}\n`,
  );
  const parallelStatus = await runBoundedTestProcesses(
    processes.parallel,
    budget.concurrency,
    (task) => run(task, budget, budget.concurrency, 1),
  );
  if (parallelStatus !== 0) process.exit(parallelStatus);
  const explicitStatus = await runBoundedTestProcesses(processes.explicitConcurrency, 1, (task) =>
    run(task, budget, 1, budget.concurrency),
  );
  if (explicitStatus !== 0) process.exit(explicitStatus);
  const wallClockStatus = await runBoundedTestProcesses(processes.wallClockSensitive, 1, (task) =>
    run(task, budget, 1, 1),
  );
  if (wallClockStatus !== 0) process.exit(wallClockStatus);
  const sharedPostgresStatus = await runBoundedTestProcesses(
    processes.sharedPostgresExclusive,
    1,
    (task) => run(task, budget, 1, 1),
  );
  if (sharedPostgresStatus !== 0) process.exit(sharedPostgresStatus);
  const clusterRoleStatus = await runBoundedTestProcesses(
    processes.clusterRoleSensitive,
    1,
    (task) => run(task, budget, 1, 1),
  );
  if (clusterRoleStatus !== 0) process.exit(clusterRoleStatus);
  process.stdout.write(
    `[unit-shard] shard ${index + 1}/${count} passed (${selected.length} files)\n`,
  );
}

if (import.meta.main) await main();
