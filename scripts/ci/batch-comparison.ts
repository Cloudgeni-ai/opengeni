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
import { HARNESS_TYPECHECK_PROJECTS, typecheckConfig } from "./workspace";

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
/** A quoted path literal naming a non-source file (`.json`, `.jq`, `.sh`, ...). */
const DATA_LITERAL = /["'`]((?:\.{1,2}\/)*[\w@-][\w.@-]*(?:\/[\w.@-]+)*\.[A-Za-z0-9]+)["'`]/g;
/** Generated snapshots are derived from product code and checked for freshness. */
const GENERATED = /(?:^|\/)[^/]*\.gen\.[^/]+$/;
const SOURCE = /\.(?:ts|tsx|js|mjs)$/;
/** The configs Bun's runtime consults for a source, nearest directory first. */
const RUNTIME_CONFIGS = ["tsconfig.json", "jsconfig.json"] as const;
const CONFIG = /(?:^|\/)[tj]sconfig[^/]*\.json$/;
/**
 * Lint and format policy the pinned oxlint and oxfmt discover by file name in
 * any directory of the checkout: ignore files (`.gitignore` at every depth,
 * `.eslintignore` for oxlint, `.prettierignore` for oxfmt), `.editorconfig`,
 * and nested or alternative lint and format configs. A tracked file listed in
 * one of them is skipped, so it decides the `lint` and `format` verdicts as
 * much as the root configs do. Matched by name over the whole tree, a file of
 * one of these names added anywhere is a new recipe path.
 */
const TOOL_POLICY =
  /(?:^|\/)(?:\.gitignore|\.eslintignore|\.prettierignore|\.editorconfig|\.oxlintrc\.jsonc?|\.oxfmtrc\.jsonc?|(?:oxlint|oxfmt)\.config\.[cm]?[jt]s)$/;

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

let policyTranspiler: Bun.Transpiler | undefined;
/**
 * Harness-owned policy inputs a harness source reads directly: non-source files
 * inside the harness tree that its code (not its comments) names by repository
 * path, by a relative path, or by a bare file name beside itself (as in a
 * `join(import.meta.dir, ...)` read). These decide verdicts as much as the code
 * does, for example the public-API breaking-change allowlist. Product inputs a
 * guard inspects (docs, migrations, catalog data, everything outside `scripts/`)
 * and generated snapshots (`*.gen.*`, derived from product code) are code under
 * comparison, never recipe. A repository-path input that is not tracked is
 * returned as absent, so adding it later changes the recipe.
 */
export function policyInputs(
  from: string,
  text: string,
  blobs: ReadonlyMap<string, string>,
): { tracked: string[]; absent: string[] } {
  const tracked = new Set<string>();
  const absent = new Set<string>();
  const beside = (literal: string) => posix.normalize(posix.join(posix.dirname(from), literal));
  // Comments name files without reading them; the transpiler drops them.
  const code = (policyTranspiler ??= new Bun.Transpiler({ loader: "ts" })).transformSync(
    text.replace(/^#!.*/, ""),
  );
  for (const match of code.matchAll(DATA_LITERAL)) {
    const literal = match[1]!;
    if (SOURCE.test(literal)) continue;
    const relative = literal.startsWith("./") || literal.startsWith("../");
    const named = relative ? null : posix.normalize(literal);
    const target = named && blobs.has(named) ? named : beside(literal);
    if (!target.startsWith(HARNESS_ROOT) || GENERATED.test(target)) continue;
    if (blobs.has(target)) tracked.add(target);
    else if (named?.startsWith(HARNESS_ROOT) && !GENERATED.test(named)) absent.add(named);
  }
  return { tracked: [...tracked], absent: [...absent] };
}

/**
 * Harness configuration a tool finds by composing a path rather than reading a
 * named one: the project config `scripts/typecheck.ts` compiles for every
 * harness typecheck root (`typecheckConfig`; a root without one is no project,
 * so its absence is bound too), and, for every given source, each config Bun's
 * runtime consults walking up to the nearest `tsconfig.json` or `jsconfig.json`,
 * whose paths, jsx and module settings decide how the source runs. The caller
 * passes the bound (executed) sources only, so a product helper the harness
 * imports binds its package config while the configs of product code under
 * comparison stay unbound.
 */
export function harnessConfigs(
  sources: Iterable<string>,
  blobs: ReadonlyMap<string, string>,
): string[] {
  const configs = new Set<string>(HARNESS_TYPECHECK_PROJECTS.map(typecheckConfig));
  for (const source of sources) {
    let directory = posix.dirname(source);
    nearest: for (;;) {
      for (const name of RUNTIME_CONFIGS) {
        const path = directory === "." ? name : `${directory}/${name}`;
        configs.add(path);
        if (blobs.has(path)) break nearest;
      }
      if (directory === ".") break;
      directory = posix.dirname(directory);
    }
  }
  return [...configs];
}

/**
 * The relative `extends` targets of a TypeScript, oxlint or oxfmt config, in
 * string or array form, resolved as the compiler does (`.json` is implied).
 * Package targets resolve through the bound lockfile and manifests. An
 * unreadable config has none: it is bound itself, and the tool reports it.
 */
export function configExtends(
  path: string,
  text: string,
  blobs: ReadonlyMap<string, string>,
): string[] {
  let config: unknown;
  try {
    config = Bun.JSONC.parse(text);
  } catch {
    return [];
  }
  const value = (config as { extends?: unknown } | null)?.extends;
  return (Array.isArray(value) ? value : [value])
    .filter(
      (item): item is string =>
        typeof item === "string" && (item.startsWith("./") || item.startsWith("../")),
    )
    .map((item) => {
      const target = posix.normalize(posix.join(posix.dirname(path), item));
      return blobs.has(target) || target.endsWith(".json") ? target : `${target}.json`;
    });
}

/**
 * The local JavaScript plugins an oxlint config loads (`jsPlugins`, as a path
 * or `{ specifier }`), resolved beside the config. They run as part of `lint`,
 * so they are executed harness code; package plugins resolve through the lockfile.
 */
export function lintPlugins(path: string, text: string): string[] {
  let config: unknown;
  try {
    config = Bun.JSONC.parse(text);
  } catch {
    return [];
  }
  const value = (config as { jsPlugins?: unknown } | null)?.jsPlugins;
  return (Array.isArray(value) ? value : [])
    .map((item: unknown) =>
      typeof item === "string" ? item : (item as { specifier?: unknown } | null)?.specifier,
    )
    .filter(
      (item): item is string =>
        typeof item === "string" && (item.startsWith("./") || item.startsWith("../")),
    )
    .map((item) => posix.normalize(posix.join(posix.dirname(path), item)));
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

const IMPORT_SUFFIXES = [".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"] as const;

function resolveLocalImport(from: string, specifier: string, blobs: Map<string, string>) {
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  for (const candidate of [target, ...IMPORT_SUFFIXES.map((suffix) => `${target}${suffix}`)])
    if (blobs.has(candidate)) return candidate;
  throw new Error(`Unresolvable batch harness import ${specifier} from ${from}`);
}

/**
 * How the recipe walk follows a file: harness entries and lint policy code
 * follow every local import; executed harness scripts follow imports inside
 * the harness tree; configs follow `extends` (lint configs also `jsPlugins`);
 * the workflow names executed scripts; data has no edges.
 */
type RecipeKind = "entry" | "script" | "tool" | "workflow" | "tsconfig" | "lint" | "data";
/** Code the walk parses for imports. */
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** A dynamic `import()` or `require()` whose argument is not a plain string literal. */
const COMPUTED_LOAD = /\b(?:import|require)\s*\(\s*(?!(["'])[^"'`$]*\1\s*[,)])/;
/** A quoted relative path in code. */
const RELATIVE_LITERAL = /["'`](\.{1,2}\/[^"'`$\s]*)["'`]/g;

function fileKind(path: string, from: "tool" | null = null): RecipeKind {
  if (/\.ya?ml$/.test(path)) return "workflow";
  if (CONFIG.test(path)) return "tsconfig";
  if (/(?:^|\/)\.(?:oxlintrc|oxfmtrc)\.jsonc?$/.test(path)) return "lint";
  if (/(?:^|\/)(?:oxlint|oxfmt)\.config\.[cm]?[jt]s$/.test(path)) return "tool";
  if (from === "tool") return CODE.test(path) ? "tool" : /\.jsonc?$/.test(path) ? "lint" : "data";
  return "data";
}

/** A relative path named in lint policy code, resolved like an import; null when it names no file. */
function resolveRelative(from: string, literal: string, blobs: ReadonlyMap<string, string>) {
  const target = posix.normalize(posix.join(posix.dirname(from), literal));
  for (const candidate of [target, ...IMPORT_SUFFIXES.map((suffix) => `${target}${suffix}`)])
    if (blobs.has(candidate)) return candidate;
  return /\.[A-Za-z0-9]+$/.test(target) && !target.endsWith("/") ? target : null;
}

/**
 * Recipe identity: everything the batch steps execute or consult that is not
 * the code under comparison, found as a closed worklist over typed edges until
 * no edge remains:
 * - harness entries and the code they import (local imports, unrestricted);
 * - harness scripts that code or the workflow executes (subprocesses and root
 *   package scripts) with their imports and executions inside the harness tree;
 * - harness-owned policy inputs those sources read (`policyInputs`);
 * - configuration tools find by composed path for every bound source
 *   (`harnessConfigs`), and every config's `extends` chain;
 * - lint and format policy the tools find by name anywhere (`TOOL_POLICY`): the
 *   configs' `extends` and `jsPlugins`, config modules and plugins as lint
 *   policy code with all their local imports and the relative paths their code
 *   names, wherever they lead;
 * - the workflow, tool configuration, toolchain pins, lockfile and every
 *   package manifest (package imports resolve through these).
 * An edge to an untracked file binds it as absent (null), so adding it later
 * changes the recipe. A form the walk cannot follow fails closed: an
 * unresolvable local import, unparseable lint policy code, or a dynamic
 * `import()`/`require()` of a computed path in lint policy code leaves the
 * recipe unknown, so the run is not comparable.
 */
export function recipePaths(
  blobs: Map<string, string>,
  read: (path: string) => string,
): [string, string | null][] {
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  const transpiler = (path: string) => (/\.[jt]sx$/.test(path) ? transpilers.tsx : transpilers.ts);
  // The transpiler rejects a leading shebang; it never carries imports.
  const text = (path: string) => read(path).replace(/^#!.*/, "");
  const imports = (path: string) =>
    transpiler(path)
      .scanImports(text(path))
      .filter((item) => item.path.startsWith("."))
      .map((item) => item.path);
  const manifest = blobs.has("package.json")
    ? (JSON.parse(read("package.json")) as { scripts?: unknown }).scripts
    : undefined;
  const scripts =
    manifest && typeof manifest === "object" ? (manifest as Record<string, string>) : {};
  const bound = new Set<string>();
  const absent = new Set<string>();
  const visited = new Set<string>();
  const pending: [string, RecipeKind][] = [
    ...RECIPE_ENTRIES.map((path): [string, RecipeKind] => [path, "entry"]),
    ...RECIPE_FILES.map((path): [string, RecipeKind] => [path, fileKind(path)]),
    ...[...blobs.keys()]
      .filter((path) => TOOL_POLICY.test(path))
      .map((path): [string, RecipeKind] => [path, fileKind(path)]),
  ];
  const code = (path: string, kind: RecipeKind) => {
    for (const script of executedScripts(read(path), false, scripts))
      if (script.startsWith(HARNESS_ROOT)) pending.push([script, "script"]);
    const inputs = policyInputs(path, read(path), blobs);
    for (const input of [...inputs.tracked, ...inputs.absent])
      pending.push([input, fileKind(input)]);
    for (const config of harnessConfigs([path], blobs)) pending.push([config, "tsconfig"]);
    if (kind !== "tool") return;
    // Lint policy code: every relative path its code names is followed too
    // (a config module's `jsPlugins`, a plugin's data); a load the walk cannot
    // follow is not silently assumed away.
    const compiled = transpiler(path).transformSync(text(path));
    if (COMPUTED_LOAD.test(compiled))
      throw new Error(`Unsupported computed module load in lint policy code ${path}`);
    for (const match of compiled.matchAll(RELATIVE_LITERAL)) {
      const target = resolveRelative(path, match[1]!, blobs);
      if (target) pending.push([target, fileKind(target, "tool")]);
    }
  };
  while (pending.length) {
    const [path, kind] = pending.pop()!;
    const key = `${kind}\0${path}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (!blobs.has(path)) {
      if (kind === "entry") throw new Error(`Batch harness entry ${path} is not tracked`);
      absent.add(path);
      continue;
    }
    bound.add(path);
    switch (kind) {
      case "entry":
      case "tool":
        if (!CODE.test(path)) break;
        for (const specifier of imports(path))
          pending.push([resolveLocalImport(path, specifier, blobs), kind]);
        code(path, kind);
        break;
      case "script":
        if (!CODE.test(path)) break;
        for (const specifier of imports(path)) {
          const target = posix.normalize(posix.join(posix.dirname(path), specifier));
          if (target.startsWith(HARNESS_ROOT))
            pending.push([resolveLocalImport(path, specifier, blobs), "script"]);
        }
        code(path, kind);
        break;
      case "workflow":
        for (const script of executedScripts(read(path), true, scripts))
          if (script.startsWith(HARNESS_ROOT)) pending.push([script, "script"]);
        break;
      case "tsconfig":
        for (const target of configExtends(path, read(path), blobs))
          pending.push([target, "tsconfig"]);
        break;
      case "lint":
        for (const target of configExtends(path, read(path), blobs)) pending.push([target, "lint"]);
        for (const plugin of lintPlugins(path, read(path))) pending.push([plugin, "tool"]);
        break;
      case "data":
        break;
    }
  }
  const manifests = [...blobs.keys()].filter(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
  return [...new Set([...bound, ...absent, ...RECIPE_FILES, ...manifests])]
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
