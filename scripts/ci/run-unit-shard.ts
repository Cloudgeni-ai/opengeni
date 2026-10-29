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
  discoverTestFiles,
  fileUsesProcessGlobalTestState,
} from "./workspace";
import { explicitBunTestPath } from "./run-test-shard";

export type UnitTestProcess = {
  files: string[];
  isolated: boolean;
};

export type UnitTestProcessPlan = {
  parallel: UnitTestProcess[];
  explicitConcurrency: UnitTestProcess[];
  cpuSaturating: UnitTestProcess[];
  wallClockSensitive: UnitTestProcess[];
  sharedPostgresExclusive: UnitTestProcess[];
  clusterRoleSensitive: UnitTestProcess[];
};

export function explicitUnitTestPaths(files: readonly string[]): string[] {
  return files.map(explicitBunTestPath);
}

export function sanitizedTestEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const requireRealDatabase = environment.OPENGENI_REQUIRE_REAL_DB === "1";
  const nativePostgresUrl = environment.OPENGENI_TEST_PG_URL;
  for (const name of Object.keys(environment)) {
    if (name.startsWith("OPENGENI_")) delete environment[name];
  }
  environment.NODE_ENV = "test";
  environment.OPENGENI_TEST_HERMETIC = "1";
  // CI sets this parent flag for the full unit shard because package-local
  // PostgreSQL/FORCE-RLS tests use the unit filename convention. Preserve only
  // the exact fail-closed boolean and its explicitly selected native PostgreSQL
  // fixture; all other ambient Opengeni state stays scrubbed. Local focused
  // checks remain infrastructure-free unless their caller deliberately requires
  // the real database boundary.
  if (requireRealDatabase) {
    environment.OPENGENI_REQUIRE_REAL_DB = "1";
    if (nativePostgresUrl?.trim()) environment.OPENGENI_TEST_PG_URL = nativePostgresUrl;
  }
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
    // Timing that the source pattern below cannot see, such as a sampling
    // profiler whose sampler thread starves when other test processes share
    // the CPUs, declares itself explicitly.
    /opengeni:test-wall-clock-sensitive/u.test(source) ||
    (/\b(?:Bun\.nanoseconds|performance\.now|Date\.now)\s*\(/.test(source) &&
      /\.toBeLessThan(?:OrEqual)?\s*\(/.test(source))
  );
}

export function sourceRequiresExclusiveSharedPostgres(source: string): boolean {
  return /opengeni:test-shared-postgres-exclusive/u.test(source);
}

// A file whose test drives a multi-core build or tool (for example a native
// `cargo test`) uses every CPU on the runner by itself. Ordinary sibling files
// each assume one CPU slot of the shared budget, so running beside it starves
// them past their own timeouts. Such a file declares itself and runs alone.
export function sourceSaturatesCpu(source: string): boolean {
  return /opengeni:test-saturates-cpu/u.test(source);
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
    // This fixture creates a cluster-wide owner role and drops it on release.
    // A concurrent migration can still hold the role in a catalog snapshot.
    /\bacquireOwnerMigratedTestDatabase\s*\(/.test(source) ||
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
  const cpuSaturating = new Set(
    [...sources]
      .filter(([path, source]) => !explicitConcurrency.has(path) && sourceSaturatesCpu(source))
      .map(([path]) => path),
  );
  const wallClockSensitive = new Set(
    [...sources]
      .filter(
        ([path, source]) =>
          !explicitConcurrency.has(path) &&
          !cpuSaturating.has(path) &&
          sourceUsesWallClockPerformanceAssertion(source),
      )
      .map(([path]) => path),
  );
  const sharedPostgresExclusive = new Set(
    [...sources]
      .filter(
        ([path, source]) =>
          !explicitConcurrency.has(path) &&
          !cpuSaturating.has(path) &&
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
          !cpuSaturating.has(path) &&
          !wallClockSensitive.has(path) &&
          !sharedPostgresExclusive.has(path) &&
          sourceMutatesSharedPostgresRole(source),
      )
      .map(([path]) => path),
  );
  const usesExplicitConcurrency = (path: string): boolean => explicitConcurrency.has(path);
  const saturatesCpu = (path: string): boolean => cpuSaturating.has(path);
  const usesWallClock = (path: string): boolean => wallClockSensitive.has(path);
  const requiresExclusiveSharedPostgres = (path: string): boolean =>
    sharedPostgresExclusive.has(path);
  const mutatesClusterRole = (path: string): boolean => clusterRoleSensitive.has(path);
  const parallelBatch = batch.filter(
    (path) =>
      !usesExplicitConcurrency(path) &&
      !saturatesCpu(path) &&
      !usesWallClock(path) &&
      !requiresExclusiveSharedPostgres(path) &&
      !mutatesClusterRole(path),
  );
  const concurrentBatch = batch.filter(usesExplicitConcurrency);
  const cpuSaturatingBatch = batch.filter(saturatesCpu);
  const wallClockBatch = batch.filter(usesWallClock);
  const sharedPostgresBatch = batch.filter(requiresExclusiveSharedPostgres);
  const clusterRoleBatch = batch.filter(mutatesClusterRole);
  const parallelIsolated = isolated.filter(
    (path) =>
      !usesExplicitConcurrency(path) &&
      !saturatesCpu(path) &&
      !usesWallClock(path) &&
      !requiresExclusiveSharedPostgres(path) &&
      !mutatesClusterRole(path),
  );
  const concurrentIsolated = isolated.filter(usesExplicitConcurrency);
  const cpuSaturatingIsolated = isolated.filter(saturatesCpu);
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
    // A file that drives a multi-core build already uses the whole runner, so
    // it runs alone after the parallel pool instead of starving its siblings.
    cpuSaturating: [
      ...cpuSaturatingBatch.map((path) => ({ files: [path], isolated: false })),
      ...cpuSaturatingIsolated.map((path) => ({ files: [path], isolated: true })),
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
  options: { keepGoing?: boolean } = {},
): Promise<number> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("unit process concurrency must be a positive integer");
  }
  const keepGoing = options.keepGoing === true;
  let next = 0;
  let failure = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    // Fail-fast (the default, and what CI uses) stops admitting new work after
    // the first failure. Keep-going admits every task and reports the first
    // failing status once all of them have settled.
    while (next < tasks.length) {
      if (failure !== 0 && !keepGoing) return;
      const index = next;
      next += 1;
      const task = tasks[index]!;
      const status = await execute(task, index);
      if (status !== 0 && failure === 0) failure = status;
    }
  });
  await Promise.all(workers);
  return failure;
}

export type UnitTestPhase = {
  name: string;
  processes: readonly UnitTestProcess[];
  concurrency: number;
  execute: (task: UnitTestProcess) => Promise<number>;
};

export type UnitTestRunResult = {
  status: number;
  plannedFiles: number;
  ranFiles: number;
  failedFiles: string[];
};

/**
 * Runs the unit phases in order and accounts for every planned file. Without
 * keepGoing the first failing phase ends the run, exactly as before; with it
 * every phase and file runs and the first failing status is returned.
 */
export async function runUnitTestPhases(
  phases: readonly UnitTestPhase[],
  options: { keepGoing?: boolean } = {},
): Promise<UnitTestRunResult> {
  const keepGoing = options.keepGoing === true;
  const plannedFiles = phases.reduce(
    (total, phase) => total + phase.processes.reduce((count, task) => count + task.files.length, 0),
    0,
  );
  let ranFiles = 0;
  const failedFiles: string[] = [];
  let status = 0;
  for (const phase of phases) {
    const phaseStatus = await runBoundedTestProcesses(
      phase.processes,
      phase.concurrency,
      async (task) => {
        const exitCode = await phase.execute(task);
        ranFiles += task.files.length;
        if (exitCode !== 0) failedFiles.push(...task.files);
        return exitCode;
      },
      { keepGoing },
    );
    if (phaseStatus !== 0 && status === 0) status = phaseStatus;
    if (status !== 0 && !keepGoing) break;
  }
  return { status, plannedFiles, ranFiles, failedFiles: failedFiles.sort() };
}

export function describeUnitTestRun(
  result: UnitTestRunResult,
  options: { keepGoing: boolean; shard: string },
): string {
  const { status, plannedFiles, ranFiles, failedFiles } = result;
  const skipped = plannedFiles - ranFiles;
  if (status === 0 && skipped === 0) {
    return `[unit-shard] shard ${options.shard} passed (${plannedFiles} files)\n`;
  }
  const lines = [
    "",
    "[unit-shard] ================================================================",
    `[unit-shard] FAILED: ${failedFiles.length} failing file(s); ran ${ranFiles} of ${plannedFiles} planned files.`,
    ...failedFiles.map((path) => `[unit-shard]   failed: ${path}`),
  ];
  if (skipped > 0) {
    lines.push(
      `[unit-shard] INCOMPLETE RUN: ${skipped} of ${plannedFiles} planned files were SKIPPED because the run stops at the first failure.`,
      "[unit-shard] This is NOT full coverage. Run every file with: bun run test:unit:all (or append --keep-going).",
    );
  } else if (options.keepGoing) {
    lines.push("[unit-shard] Keep-going run: every planned file ran.");
  }
  lines.push("[unit-shard] ================================================================", "");
  return lines.join("\n");
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
    ...explicitUnitTestPaths(files),
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
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.stderr.write(`[unit-shard] failed: exitCode=${exitCode} files=${files.join(", ")}\n`);
  }
  return exitCode;
}

export function deterministicUnitTestShards(
  root: string,
  files: readonly string[],
  count: number,
): string[][] {
  const batch: string[] = [];
  const isolated: string[] = [];
  for (const path of new Set(files)) {
    (fileUsesProcessGlobalTestState(root, path) ? isolated : batch).push(path);
  }
  // Balance each execution category independently: changing ordinary file
  // weights must not repack the serialized PostgreSQL or wall-clock queues.
  const processes = planUnitTestProcesses(root, batch, isolated, 1);
  const categories = Object.values(processes).map((category) =>
    deterministicShards(
      root,
      category.flatMap((process) => process.files),
      count,
    ),
  );
  return Array.from({ length: count }, (_, index) =>
    categories.flatMap((shards) => shards[index]!).sort(),
  );
}

export function resolveUnitTestSelection(
  root: string,
  args: readonly string[],
): { selected: string[]; index: number; count: number; keepGoing: boolean } {
  // --keep-going is an opt-in local mode; it never changes which files run.
  const keepGoing = args.includes("--keep-going");
  args = args.filter((argument) => argument !== "--keep-going");
  if (args.includes("--all")) {
    if (args.length !== 1) throw new Error("--all cannot be combined with shard arguments");
    return { selected: discoverTestFiles(root).unit, index: 0, count: 1, keepGoing };
  }
  const planIndex = args.indexOf("--plan");
  const shardIndex = args.indexOf("--shard");
  const countIndex = args.indexOf("--shards");
  if (planIndex < 0 || shardIndex < 0 || countIndex < 0) {
    throw new Error(
      "usage: run-unit-shard.ts [--keep-going] --all | --plan <json> --shard <index> --shards <count>",
    );
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
  const selected = deterministicUnitTestShards(root, plan.unitTests, count)[index] ?? [];
  return { selected, index, count, keepGoing };
}

async function main(): Promise<void> {
  const { selected, index, count, keepGoing } = resolveUnitTestSelection(
    process.cwd(),
    process.argv.slice(2),
  );
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
    `[unit-shard] process plan: ${describeTestConcurrencyBudget(budget)} parallel=${processes.parallel.length} explicitConcurrency=${processes.explicitConcurrency.length} cpuSaturating=${processes.cpuSaturating.length} wallClockSensitive=${processes.wallClockSensitive.length} sharedPostgresExclusive=${processes.sharedPostgresExclusive.length} clusterRoleSensitive=${processes.clusterRoleSensitive.length} mode=${keepGoing ? "keep-going" : "fail-fast"}\n`,
  );
  const serial = (task: UnitTestProcess): Promise<number> => run(task, budget, 1, 1);
  const result = await runUnitTestPhases(
    [
      {
        name: "parallel",
        processes: processes.parallel,
        concurrency: budget.concurrency,
        execute: (task) => run(task, budget, budget.concurrency, 1),
      },
      {
        name: "explicitConcurrency",
        processes: processes.explicitConcurrency,
        concurrency: 1,
        execute: (task) => run(task, budget, 1, budget.concurrency),
      },
      {
        name: "cpuSaturating",
        processes: processes.cpuSaturating,
        concurrency: 1,
        execute: serial,
      },
      {
        name: "wallClockSensitive",
        processes: processes.wallClockSensitive,
        concurrency: 1,
        execute: serial,
      },
      {
        name: "sharedPostgresExclusive",
        processes: processes.sharedPostgresExclusive,
        concurrency: 1,
        execute: serial,
      },
      {
        name: "clusterRoleSensitive",
        processes: processes.clusterRoleSensitive,
        concurrency: 1,
        execute: serial,
      },
    ],
    { keepGoing },
  );
  const summary = describeUnitTestRun(result, { keepGoing, shard: `${index + 1}/${count}` });
  if (result.status !== 0) {
    process.stderr.write(summary);
    process.exit(result.status);
  }
  process.stdout.write(summary);
}

if (import.meta.main) await main();
