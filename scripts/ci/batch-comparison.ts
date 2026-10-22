#!/usr/bin/env bun
// Batch-CI side of batch-base-comparison/v1. Candidate runs record comparison
// evidence best-effort and never change their own verdict through it. A
// base-comparison run executes the frozen plan of a failed candidate on the
// exact base tree with the same recipe and records complete coverage.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";

import {
  BASE_PURPOSE,
  COMPARISON_SCHEMA,
  executionPlan,
  validateExecutionPlan,
  type ExecutionPlan,
  type ExecutionStatus,
} from "../merge-batcher/base-comparison";
import { digest } from "../merge-batcher/model";
import {
  configuredFilesPerProcess,
  deterministicUnitTestShards,
  shardProcessPlan,
  UNIT_PROCESS_CATEGORIES,
} from "./run-unit-shard";

/** Mirrors the receipt exit classification; only `fail` is an assertion verdict. */
export function executionStatus(code: number | null | undefined): ExecutionStatus {
  if (code === null || code === undefined || !Number.isSafeInteger(code)) return "not-run";
  if (code === 0) return "pass";
  if (code === 124) return "timeout";
  if (code === 130 || code === 143 || code < 0 || code >= 128) return "killed";
  if (code === 75 || code === 126 || code === 127) return "infrastructure";
  return "fail";
}

/** Entry points of the batch harness; their local import closure is recipe, not code under test. */
export const RECIPE_ENTRIES = [
  "scripts/ci/batch-comparison.ts",
  "scripts/ci/batch-result.ts",
  "scripts/ci/batch-setup.ts",
  "scripts/ci/batch-source.ts",
  "scripts/ci/impact.ts",
  "scripts/ci/profile-command.ts",
  "scripts/ci/run-guards-plan.ts",
  "scripts/ci/run-typecheck-plan.ts",
  "scripts/ci/run-unit-shard.ts",
  "scripts/merge-batcher/main.ts",
] as const;
/** Execution-defining files outside the import closure; absence is recorded as null. */
export const RECIPE_FILES = [
  ".github/workflows/batch-ci.yml",
  ".bun-version",
  "bun.lock",
  "bunfig.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "scripts/ci/batch-comparison.json",
] as const;

/** Exact tracked blobs of a commit: path -> object id. */
export function trackedBlobs(listing: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const match = entry.match(/^\d+ (\w+) ([a-f0-9]{40})\t(.+)$/s);
    if (!match) throw new Error("Unreadable tree listing");
    if (match[1] === "blob") blobs.set(match[3]!, match[2]!);
  }
  return blobs;
}

function resolveLocalImport(from: string, specifier: string, blobs: Map<string, string>) {
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  for (const candidate of [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    `${target}/index.ts`,
  ])
    if (blobs.has(candidate)) return candidate;
  throw new Error(`Unresolvable batch harness import ${specifier} from ${from}`);
}

/**
 * Recipe identity: the transitive local import closure of every harness entry,
 * the workflow, toolchain pins, lockfile and every package manifest. Package
 * imports resolve through the lockfile and manifests, which are bound here.
 */
export function recipePaths(
  blobs: Map<string, string>,
  read: (path: string) => string,
): [string, string | null][] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const closure = new Set<string>();
  const pending: string[] = [...RECIPE_ENTRIES];
  while (pending.length) {
    const path = pending.pop()!;
    if (closure.has(path)) continue;
    if (!blobs.has(path)) throw new Error(`Batch harness entry ${path} is not tracked`);
    closure.add(path);
    if (!/\.(?:ts|tsx|js)$/.test(path)) continue;
    // The transpiler rejects a leading shebang; it never carries imports.
    for (const item of transpiler.scanImports(read(path).replace(/^#!.*/, "")))
      if (item.path.startsWith(".")) pending.push(resolveLocalImport(path, item.path, blobs));
  }
  const manifests = [...blobs.keys()].filter(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
  return [...new Set([...closure, ...RECIPE_FILES, ...manifests])]
    .sort()
    .map((path) => [path, blobs.get(path) ?? null]);
}

export type ExecutionRole = "source" | "unit";
/** Runner and toolchain identity bound by execution role; null means missing evidence. */
export function environmentIdentity(
  role: ExecutionRole,
  env: Readonly<Record<string, string | undefined>>,
  observed: { node: string | null; postgres: string | null },
): Record<string, string | null> {
  const shared = {
    runnerOs: env.RUNNER_OS ?? null,
    runnerArch: env.RUNNER_ARCH ?? null,
    imageOS: env.ImageOS ?? null,
    imageVersion: env.ImageVersion ?? null,
    bun: `${Bun.version}+${Bun.revision}`,
    node: observed.node,
    testMaxConcurrency: env.OPENGENI_TEST_MAX_CONCURRENCY ?? null,
    typecheckConcurrency: env.OPENGENI_TYPECHECK_CONCURRENCY ?? null,
    cargoBuildJobs: env.CARGO_BUILD_JOBS ?? null,
  };
  if (role === "source") return shared;
  return {
    ...shared,
    filesPerProcess: String(configuredFilesPerProcess(env)),
    requireRealDb: env.OPENGENI_REQUIRE_REAL_DB ?? null,
    postgres: observed.postgres,
  };
}

export function nodeVersion(): string | null {
  try {
    const child = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "ignore" });
    const version = child.stdout.toString().trim();
    return child.exitCode === 0 && version ? version : null;
  } catch {
    return null;
  }
}

/** Expected execution units: exactly the processes run-unit-shard will start. */
export function expectedUnits(
  root: string,
  plan: ExecutionPlan,
  shards: number,
  filesPerProcess: number,
): { category: string; files: string[] }[] {
  if (!plan.unitTests.length) return [];
  if (!Number.isSafeInteger(shards) || shards < 1 || shards > 16)
    throw new Error("Invalid unit shard count");
  return deterministicUnitTestShards(root, plan.unitTests, shards).flatMap((selected) => {
    const processes = shardProcessPlan(root, selected, filesPerProcess);
    return UNIT_PROCESS_CATEGORIES.flatMap((category) =>
      processes[category].map((task) => ({ category, files: [...task.files] })),
    );
  });
}

function git(args: string[]): string {
  const child = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return child.stdout.toString();
}
function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function save(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}
/** The checkout must be exactly the run's commit; tree lookups prove presence. */
function headBlobs(): Map<string, string> {
  const head = git(["rev-parse", "HEAD"]).trim();
  if (process.env.GITHUB_SHA && head !== process.env.GITHUB_SHA)
    throw new Error("Checkout is not the exact run commit");
  return trackedBlobs(git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]));
}

if (import.meta.main) {
  const mode = process.argv[2];
  try {
    if (mode === "plan") {
      // Candidate: the executed subset of the impact plan, digested identically.
      save(option("--output"), executionPlan(JSON.parse(readFileSync(option("--impact"), "utf8"))));
    } else if (mode === "freeze") {
      // Base comparison: the frozen candidate plan, never a recomputed impact.
      const batch = JSON.parse(readFileSync(option("--manifest"), "utf8")) as {
        purpose?: string;
        planDigest?: string;
        plan?: unknown;
      };
      if (batch.purpose !== BASE_PURPOSE) throw new Error("freeze requires a base-comparison tip");
      const plan = validateExecutionPlan(batch.plan);
      if (digest(plan) !== batch.planDigest) throw new Error("Frozen plan digest mismatch");
      const blobs = headBlobs();
      const absent = plan.unitTests.filter((path) => !blobs.has(path));
      if (absent.length) {
        console.error(
          `Base is not comparable: ${absent.length} planned unit file(s) are absent from the base tree: ${absent.slice(0, 20).join(", ")}`,
        );
        process.exit(75);
      }
      save(option("--output"), plan);
    } else if (mode === "inventory") {
      const plan = validateExecutionPlan(JSON.parse(readFileSync(option("--plan"), "utf8")));
      const shards = Number(option("--shards"));
      const blobs = headBlobs();
      const filesPerProcess = configuredFilesPerProcess();
      const absent = plan.unitTests.filter((path) => !blobs.has(path));
      save(option("--output"), {
        schemaVersion: 1,
        comparisonSchema: COMPARISON_SCHEMA,
        planDigest: digest(plan),
        shards: plan.unitTests.length ? shards : 0,
        filesPerProcess,
        absent,
        units: absent.length ? [] : expectedUnits(process.cwd(), plan, shards, filesPerProcess),
        recipePaths: recipePaths(blobs, (path) => readFileSync(path, "utf8")),
      });
    } else throw new Error("usage: batch-comparison.ts plan|freeze|inventory [options]");
  } catch (error) {
    console.error(
      "Batch comparison step could not complete:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(75);
  }
}
