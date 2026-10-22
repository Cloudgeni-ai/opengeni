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
  ".changeset/config.json",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  "bun.lock",
  "bunfig.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "scripts/ci/batch-comparison.json",
  "tsconfig.base.json",
] as const;
/**
 * The harness tree. A script the harness executes, and its imports, are recipe
 * only here: product code a guard imports to inspect (for example the API app
 * the public-API check loads) is the code under comparison, never the recipe.
 */
const HARNESS_ROOT = "scripts/";
const SCRIPT_PATH = String.raw`(?:\.\/)?([\w.@-]+(?:\/[\w.@-]+)*\.(?:ts|tsx|js|mjs))`;
/** `["bun", "<script>"]` in a harness source: a subprocess, not an import. */
const ARRAY_SCRIPT = new RegExp(String.raw`["']bun["']\s*,\s*["']${SCRIPT_PATH}["']`, "g");
/** `["bun", "run", "<name>"]` in a harness source. */
const ARRAY_RUN = /["']bun["']\s*,\s*["']run["']\s*,\s*["']([\w:.-]+)["']/g;
/** Shell command text (package scripts, workflow steps): `bun <script>`, `bun run <name>`. */
const SHELL_SCRIPT = new RegExp(String.raw`\bbun\s+(?:--[\w-]+(?:=\S+)?\s+)*${SCRIPT_PATH}`, "g");
const SHELL_RUN = /\bbun\s+run\s+([\w:.-]+)/g;
const SOURCE = /\.(?:ts|tsx|js|mjs)$/;

/**
 * Harness scripts reached by execution rather than import: subprocesses the
 * text runs directly and root package scripts it runs by name, recursively
 * through the commands of those package scripts. Source files are read in
 * array (spawn) form only, so prose that merely names a command binds nothing.
 */
export function executedScripts(
  text: string,
  shell: boolean,
  scripts: Readonly<Record<string, string>>,
  seen: Set<string> = new Set(),
): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(shell ? SHELL_SCRIPT : ARRAY_SCRIPT))
    found.push(posix.normalize(match[1]!));
  for (const match of text.matchAll(shell ? SHELL_RUN : ARRAY_RUN)) {
    const name = match[1]!;
    const command = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
    if (typeof command !== "string" || seen.has(name)) continue;
    seen.add(name);
    found.push(...executedScripts(command, true, scripts, seen));
  }
  return found;
}

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
 * every harness script those files execute (subprocesses and root package
 * scripts, with their own imports and executions inside the harness tree), the
 * workflow, tool configuration, toolchain pins, lockfile and every package
 * manifest. Package imports resolve through the lockfile and manifests, which
 * are bound here. An executed harness script that is not tracked is bound as
 * absent (null), so adding it later changes the recipe.
 */
export function recipePaths(
  blobs: Map<string, string>,
  read: (path: string) => string,
): [string, string | null][] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  // The transpiler rejects a leading shebang; it never carries imports.
  const imports = (path: string) =>
    transpiler
      .scanImports(read(path).replace(/^#!.*/, ""))
      .filter((item) => item.path.startsWith("."))
      .map((item) => item.path);
  // Phase 1: the import closure of the entries, unrestricted as before.
  const closure = new Set<string>();
  const pending: string[] = [...RECIPE_ENTRIES];
  while (pending.length) {
    const path = pending.pop()!;
    if (closure.has(path)) continue;
    if (!blobs.has(path)) throw new Error(`Batch harness entry ${path} is not tracked`);
    closure.add(path);
    if (SOURCE.test(path))
      for (const specifier of imports(path))
        pending.push(resolveLocalImport(path, specifier, blobs));
  }
  // Phase 2: what that closure and the workflow execute, with the executed
  // scripts' own imports and executions, inside the harness tree only.
  const manifest = blobs.has("package.json")
    ? (JSON.parse(read("package.json")) as { scripts?: unknown }).scripts
    : undefined;
  const scripts =
    manifest && typeof manifest === "object" ? (manifest as Record<string, string>) : {};
  const absent = new Set<string>();
  const executed: string[] = [];
  const execute = (from: string, shell: boolean) => {
    for (const path of executedScripts(read(from), shell, scripts))
      if (path.startsWith(HARNESS_ROOT)) executed.push(path);
  };
  for (const path of RECIPE_FILES)
    if (blobs.has(path) && /\.ya?ml$/.test(path)) execute(path, true);
  for (const path of closure) if (SOURCE.test(path)) execute(path, false);
  while (executed.length) {
    const path = executed.pop()!;
    if (closure.has(path) || absent.has(path)) continue;
    if (!blobs.has(path)) {
      absent.add(path);
      continue;
    }
    closure.add(path);
    if (!SOURCE.test(path)) continue;
    for (const specifier of imports(path)) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (target.startsWith(HARNESS_ROOT))
        executed.push(resolveLocalImport(path, specifier, blobs));
    }
    execute(path, false);
  }
  const manifests = [...blobs.keys()].filter(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
  return [...new Set([...closure, ...absent, ...RECIPE_FILES, ...manifests])]
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
