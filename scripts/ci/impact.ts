#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

import {
  createWorkspaceGraph,
  discoverTestFiles,
  assertTestTierMapComplete,
  transitiveDependents,
  typecheckProjects,
  workspaceForPath,
  type WorkspaceGraph,
} from "./workspace";
import { changesetIgnoreSet } from "../publishable-workspaces";

export type ImpactReason = { path: string; reason: string };
export type ImpactPlan = {
  schemaVersion: 1;
  mode: "focused" | "full" | "docs";
  base: string | null;
  head: string | null;
  changedFiles: string[];
  affectedPackages: string[];
  typecheckProjects: string[];
  unitTests: string[];
  integrationTests: string[];
  e2eTests: string[];
  buildPackages: string[];
  guards: string[];
  reasons: ImpactReason[];
};

const GLOBAL_FENCES = [
  /^\.bun-version$/,
  /^\.changeset\//,
  /^\.github\//,
  /^\.dockerignore$/,
  /^\.npmrc$/,
  /^bunfig\.toml$/,
  /^bun\.lock$/,
  /^package\.json$/,
  /^tsconfig(?:\.|$)/,
  /^\.ox(?:fmt|lint)/,
  /^docker\//,
  /^deploy\//,
  /^scripts\/ci\//,
  /^scripts\/build-publishable-packages\.ts$/,
  /^scripts\/publish-closure-guard\.ts$/,
  /^scripts\/publishable-workspaces\.ts$/,
  /^scripts\/release-publish\.sh$/,
  /^scripts\/rewrite-(?:entry-points|workspace-deps)\.ts$/,
];
const GENERATED_FENCES = [
  /^agent\/proto\//,
  /^agent\/scripts\/codegen\.sh$/,
  /^packages\/agent-proto\/scripts\/codegen\.sh$/,
  /^packages\/agent-proto\/src\/gen\//,
];
const MIGRATION_FENCES = [/^packages\/db\/drizzle\//, /^packages\/db\/src\/migrate\.ts$/];
const DOC_PATTERN = /^(?:docs\/|[^/]+\.md$)/;

export const TEMPORAL_WORKFLOW_INTEGRATION_TESTS = [
  "test/integration/temporal-workflow-activities.integration.ts",
  "test/integration/temporal-workflow-capacity.integration.ts",
  "test/integration/temporal-workflow-continuity.integration.ts",
  "test/integration/temporal-workflow-dispatch.integration.ts",
  "test/integration/temporal-workflow-interrupt.integration.ts",
  "test/integration/temporal-workflow-worker-death.integration.ts",
] as const;
export const TEMPORAL_WORKFLOW_TEST_HELPER = "test/integration/temporal-workflow.test-support.ts";

const TEMPORAL_WORKFLOW_DEPENDENCIES = [
  "@opengeni/worker-bundle",
  "@opengeni/db",
  "@opengeni/events",
];

const ROOT_TEST_DEPENDENCIES: Record<string, string[]> = {
  "test/integration/api.integration.ts": [
    "@opengeni/api-router",
    "@opengeni/core",
    "@opengeni/db",
    "@opengeni/events",
    "@opengeni/react",
    "@opengeni/runtime",
    "@opengeni/storage",
  ],
  "test/integration/file-upload.integration.ts": [
    "@opengeni/api-router",
    "@opengeni/core",
    "@opengeni/db",
    "@opengeni/storage",
  ],
  "test/integration/db.integration.ts": ["@opengeni/db"],
  "test/integration/nats.integration.ts": ["@opengeni/events"],
  "test/integration/selfhosted-auth-callout.integration.ts": [
    "@opengeni/agent-proto",
    "@opengeni/api-router",
    "@opengeni/events",
  ],
  "test/integration/selfhosted-control-transport.integration.ts": [
    "@opengeni/agent-proto",
    "@opengeni/events",
    "@opengeni/runtime",
    "@opengeni/testing",
  ],
  "test/integration/worker-activity.integration.ts": [
    "@opengeni/api-router",
    "@opengeni/worker-bundle",
    "@opengeni/core",
    "@opengeni/db",
    "@opengeni/events",
    "@opengeni/runtime",
  ],
  "test/integration/worker-restart.integration.ts": [
    "@opengeni/api-router",
    "@opengeni/worker-bundle",
    "@opengeni/db",
    "@opengeni/events",
  ],
  "test/integration/workspace-capture.integration.ts": [
    "@opengeni/api-router",
    "@opengeni/worker-bundle",
    "@opengeni/db",
    "@opengeni/storage",
  ],
  "test/integration/workspace-isolation.integration.ts": [
    "@opengeni/api-router",
    "@opengeni/core",
    "@opengeni/db",
  ],
  "test/e2e/browser.e2e.ts": [
    "opengeni-web",
    "@opengeni/react",
    "@opengeni/sdk",
    "@opengeni/api-router",
  ],
  "test/e2e/session-pins.browser.e2e.ts": [
    "opengeni-web",
    "@opengeni/react",
    "@opengeni/sdk",
    "@opengeni/api-router",
    "@opengeni/contracts",
    "@opengeni/db",
    "@opengeni/testing",
  ],
  "test/e2e/opstream-runner.e2e.ts": ["@opengeni/runtime", "@opengeni/api-router"],
  "test/e2e/channel-a.e2e.ts": ["@opengeni/runtime", "@opengeni/api-router"],
  "test/e2e/rig-setup.e2e.ts": ["@opengeni/runtime", "@opengeni/api-router"],
  "test/e2e/rig-verification.e2e.ts": ["@opengeni/runtime", "@opengeni/api-router"],
  "test/e2e/sandbox.e2e.ts": [
    "@opengeni/runtime",
    "@opengeni/worker-bundle",
    "@opengeni/api-router",
  ],
};

for (const path of TEMPORAL_WORKFLOW_INTEGRATION_TESTS) {
  ROOT_TEST_DEPENDENCIES[path] = [...TEMPORAL_WORKFLOW_DEPENDENCIES];
}

const ROOT_TEST_HELPER_DEPENDENTS: Record<string, readonly string[]> = {
  [TEMPORAL_WORKFLOW_TEST_HELPER]: TEMPORAL_WORKFLOW_INTEGRATION_TESTS,
};

function importedWorkspaceDependencies(graph: WorkspaceGraph, path: string): Set<string> {
  const source = readFileSync(path, "utf8");
  const imports = ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName }) => fileName);
  const workspaceNames = new Set(graph.packages.map((pkg) => pkg.name));
  const dependencies = new Set<string>();
  for (const specifier of imports) {
    if (specifier.startsWith("@opengeni/")) {
      const name = specifier.split("/").slice(0, 2).join("/");
      if (!workspaceNames.has(name)) {
        throw new Error(`${path} imports unknown workspace dependency ${name}`);
      }
      dependencies.add(name);
      continue;
    }
    if (!specifier.startsWith(".")) continue;
    const resolved = normalizeRepositoryPath(
      relative(process.cwd(), resolve(dirname(path), specifier)),
    );
    const pkg = workspaceForPath(graph, resolved);
    if (pkg) dependencies.add(pkg.name);
  }
  return dependencies;
}

function rootTestDependencies(graph: WorkspaceGraph, path: string): string[] | null {
  const declared = ROOT_TEST_DEPENDENCIES[path];
  if (!declared) return null;
  return [...new Set([...declared, ...importedWorkspaceDependencies(graph, path)])].sort();
}

function normalizeRepositoryPath(path: string): string {
  return path.split(sep).join("/");
}

export function assertRootTestDependencyMapComplete(graph = createWorkspaceGraph()): void {
  for (const path of Object.keys(ROOT_TEST_DEPENDENCIES)) {
    if (!existsSync(path))
      throw new Error(`root test dependency mapping references missing file: ${path}`);
    rootTestDependencies(graph, path);
  }
}

function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function fullPlan(
  graph: WorkspaceGraph,
  changedFiles: string[],
  reasons: ImpactReason[],
  base: string | null,
  head: string | null,
): ImpactPlan {
  const tests = discoverTestFiles();
  const ignoredBuildPackages = changesetIgnoreSet();
  return {
    schemaVersion: 1,
    mode: "full",
    base,
    head,
    changedFiles,
    affectedPackages: graph.packages.map((pkg) => pkg.name).sort(),
    typecheckProjects: typecheckProjects(graph),
    unitTests: tests.unit,
    integrationTests: tests.integration,
    e2eTests: tests.e2e,
    buildPackages: graph.packages
      .filter((pkg) => pkg.name.startsWith("@opengeni/") && pkg.packageJson.private !== true)
      .filter((pkg) => !ignoredBuildPackages.has(pkg.name))
      .map((pkg) => pkg.name)
      .sort(),
    guards: ["lint", "format", "workspace-billing", "docs-refs", "publish-closure"],
    reasons,
  };
}

export function createImpactPlan(
  changedInput: readonly string[],
  options: { forceFull?: boolean; base?: string | null; head?: string | null } = {},
): ImpactPlan {
  assertTestTierMapComplete();
  const graph = createWorkspaceGraph();
  assertRootTestDependencyMapComplete(graph);
  const base = options.base ?? null;
  const head = options.head ?? null;
  const changedFiles = [...new Set(changedInput.map((path) => path.trim()).filter(Boolean))].sort();
  const reasons: ImpactReason[] = [];
  if (options.forceFull) {
    reasons.push({ path: "*", reason: "full mode requested (main/scheduled safety net)" });
    return fullPlan(graph, changedFiles, reasons, base, head);
  }
  if (changedFiles.length === 0) {
    reasons.push({ path: "*", reason: "no trustworthy changed-file set; failing closed" });
    return fullPlan(graph, changedFiles, reasons, base, head);
  }

  for (const path of changedFiles) {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      reasons.push({ path, reason: "invalid or non-repository path; failing closed" });
      return fullPlan(graph, changedFiles, reasons, base, head);
    }
    if (matchesAny(path, GLOBAL_FENCES)) {
      reasons.push({ path, reason: "global toolchain/build/CI fence" });
      return fullPlan(graph, changedFiles, reasons, base, head);
    }
    if (matchesAny(path, GENERATED_FENCES)) {
      reasons.push({ path, reason: "generated source/codegen fence" });
      return fullPlan(graph, changedFiles, reasons, base, head);
    }
    if (matchesAny(path, MIGRATION_FENCES)) {
      reasons.push({ path, reason: "migration/schema ordering fence" });
      return fullPlan(graph, changedFiles, reasons, base, head);
    }
  }

  if (changedFiles.every((path) => DOC_PATTERN.test(path))) {
    return {
      schemaVersion: 1,
      mode: "docs",
      base,
      head,
      changedFiles,
      affectedPackages: [],
      typecheckProjects: [],
      unitTests: [],
      integrationTests: [],
      e2eTests: [],
      buildPackages: [],
      guards: ["format", "docs-refs"],
      reasons: changedFiles.map((path) => ({ path, reason: "documentation-only change" })),
    };
  }

  const direct = new Set<string>();
  const changedTests = new Set<string>();
  let scriptsOperator = false;
  for (const path of changedFiles) {
    const pkg = workspaceForPath(graph, path);
    if (pkg) {
      direct.add(pkg.name);
      reasons.push({ path, reason: `workspace ${pkg.name}` });
      if (/\.test\.tsx?$/.test(path) && existsSync(join(process.cwd(), path)))
        changedTests.add(path);
      continue;
    }
    if (path.startsWith("scripts/operator/")) {
      scriptsOperator = true;
      reasons.push({ path, reason: "operator script project" });
      if (/\.test\.tsx?$/.test(path) && existsSync(join(process.cwd(), path)))
        changedTests.add(path);
      continue;
    }
    if (path === "test/source-hygiene.test.ts") {
      changedTests.add(path);
      reasons.push({ path, reason: "root source-hygiene test" });
      continue;
    }
    const helperDependents = ROOT_TEST_HELPER_DEPENDENTS[path];
    if (helperDependents) {
      for (const dependent of helperDependents) {
        const dependencies = rootTestDependencies(graph, dependent);
        if (!dependencies) {
          reasons.push({
            path,
            reason: `root test helper mapping is stale for ${dependent}; failing closed`,
          });
          return fullPlan(graph, changedFiles, reasons, base, head);
        }
        changedTests.add(dependent);
        for (const name of dependencies) direct.add(name);
      }
      reasons.push({
        path,
        reason: `explicit root integration helper dependency rule (${helperDependents.length} tests)`,
      });
      continue;
    }
    const dependencies = rootTestDependencies(graph, path);
    if (dependencies) {
      changedTests.add(path);
      for (const name of dependencies) direct.add(name);
      reasons.push({ path, reason: "explicit root integration/e2e dependency rule" });
      continue;
    }
    reasons.push({ path, reason: "unmapped repository path; failing closed" });
    return fullPlan(graph, changedFiles, reasons, base, head);
  }

  const affected = transitiveDependents(graph, direct);
  const tests = discoverTestFiles();
  const unit = new Set(changedTests);
  for (const path of tests.unit) {
    const pkg = workspaceForPath(graph, path);
    if (pkg && affected.has(pkg.name)) unit.add(path);
  }
  if (changedFiles.some((path) => !/\.test\.tsx?$/.test(path))) {
    unit.add("test/source-hygiene.test.ts");
  }

  function rootTests(paths: readonly string[]): string[] {
    return paths.filter((path) => {
      if (changedTests.has(path)) return true;
      const pkg = workspaceForPath(graph, path);
      if (pkg) return affected.has(pkg.name);
      const dependencies = rootTestDependencies(graph, path);
      if (!dependencies) return true; // Missing rule is conservative, never a skip.
      return dependencies.some((name) => affected.has(name));
    });
  }

  const projects = graph.packages
    .filter((pkg) => affected.has(pkg.name) && existsSync(join(pkg.dir, "tsconfig.json")))
    .map((pkg) => pkg.dir);
  if (scriptsOperator) projects.unshift("scripts/operator");
  const buildPackages = graph.packages
    .filter((pkg) => !changesetIgnoreSet().has(pkg.name))
    .filter(
      (pkg) =>
        affected.has(pkg.name) &&
        pkg.name.startsWith("@opengeni/") &&
        pkg.packageJson.private !== true,
    )
    .map((pkg) => pkg.name)
    .sort();
  if (buildPackages.some((name) => name === "@opengeni/sdk" || name === "@opengeni/react")) {
    for (const linked of ["@opengeni/sdk", "@opengeni/react"]) {
      if (!buildPackages.includes(linked)) buildPackages.push(linked);
    }
    buildPackages.sort();
  }
  const guards = ["lint", "format", "workspace-billing", "docs-refs"];
  if (buildPackages.length > 0) guards.push("publish-closure");

  return {
    schemaVersion: 1,
    mode: "focused",
    base,
    head,
    changedFiles,
    affectedPackages: [...affected].sort(),
    typecheckProjects: projects,
    unitTests: [...unit].filter((path) => existsSync(join(process.cwd(), path))).sort(),
    integrationTests: rootTests(tests.integration),
    e2eTests: rootTests(tests.e2e),
    buildPackages,
    guards,
    reasons,
  };
}

export function parseGitNameStatus(output: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changed = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status || !/^[ACDMRTUXB][0-9]*$/.test(status)) {
      throw new Error(`unrecognized git name-status record: ${status ?? "<missing>"}`);
    }
    const oldPath = fields[index++];
    if (!oldPath) throw new Error(`missing path for git status ${status}`);
    changed.add(oldPath);
    if (status.startsWith("R") || status.startsWith("C")) {
      const newPath = fields[index++];
      if (!newPath) throw new Error(`missing destination for git status ${status}`);
      changed.add(newPath);
    }
  }
  return [...changed].sort();
}

export function gitChangedFiles(base: string, head: string): string[] {
  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies",
      "--diff-filter=ACDMRTUXB",
      `${base}...${head}`,
    ],
    { encoding: "utf8" },
  );
  return parseGitNameStatus(output);
}

function usage(): never {
  throw new Error(
    "usage: bun scripts/ci/impact.ts [--base <sha> --head <sha> | --files <path> | --full] [--output <json>]",
  );
}

export function main(args = process.argv.slice(2)): void {
  let base: string | null = null;
  let head: string | null = null;
  let filesPath: string | null = null;
  let outputPath: string | null = null;
  let forceFull = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base") base = args[++index] ?? usage();
    else if (arg === "--head") head = args[++index] ?? usage();
    else if (arg === "--files") filesPath = args[++index] ?? usage();
    else if (arg === "--output") outputPath = args[++index] ?? usage();
    else if (arg === "--full") forceFull = true;
    else usage();
  }
  let changed: string[] = [];
  if (filesPath) changed = readFileSync(filesPath, "utf8").split("\n").filter(Boolean);
  else if (base && head) changed = gitChangedFiles(base, head);
  else if (!forceFull) usage();
  const plan = createImpactPlan(changed, { forceFull, base, head });
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json);
  }
  process.stdout.write(json);
}

if (import.meta.main) main();
