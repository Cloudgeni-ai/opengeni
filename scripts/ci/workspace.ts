import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  ALL_DEP_FIELDS,
  workspacePackages,
  type WorkspacePackage,
} from "../publishable-workspaces";

export type WorkspaceGraph = {
  packages: WorkspacePackage[];
  byDirectory: Map<string, WorkspacePackage>;
  byName: Map<string, WorkspacePackage>;
  dependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
};

export const UNIT_TEST_PATTERN = /(?:^|\/)\S+\.test\.tsx?$/;
export const INTEGRATION_TEST_PATTERN = /(?:^|\/)\S+\.integration\.ts$/;
export const E2E_TEST_PATTERN = /(?:^|\/)\S+\.e2e\.ts$/;
export const INTEGRATION_SHARD_PROFILE = "scripts/ci/integration-shard-profile.json";
const TEST_SOURCE_DIRECTORIES = ["apps", "examples", "packages", "scripts", "test"];

export type ShardWeightResolution = {
  mode: "profile" | "source-bytes";
  weights: ReadonlyMap<string, number> | null;
  reason: string;
  profileSha256: string | null;
};

export const OPT_IN_TESTS: Readonly<Record<string, string>> = {
  "test/integration/workspace-capture.integration.ts":
    "requires an already-running real dev stack and is owned by the live workspace-capture gate",
  "packages/runtime/test/codex-live.e2e.ts":
    "requires explicit live Codex credentials and is owned by the provider-live gate",
  "apps/worker/test/desktop-image.e2e.ts":
    "builds the full desktop image and is owned by the path-filtered weekly desktop-image workflow",
  "test/e2e/opstream-runner.e2e.ts":
    "requires an explicitly built real Rust runner plus nats-server and is owned by the agent op-stream conformance gate",
};

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

export function createWorkspaceGraph(): WorkspaceGraph {
  // The complete graph intentionally includes devDependencies and therefore has
  // legitimate test-helper cycles. Reachability is cycle-safe; only publish
  // builds require a DAG and use topologicallySortedPackages separately.
  const packages = workspacePackages();
  const byDirectory = new Map(packages.map((pkg) => [normalizePath(pkg.dir), pkg]));
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const pkg of packages) {
    dependencies.set(pkg.name, new Set());
    dependents.set(pkg.name, new Set());
  }
  for (const pkg of packages) {
    for (const field of ALL_DEP_FIELDS) {
      const entries = pkg.packageJson[field] as Record<string, string> | undefined;
      for (const dependency of Object.keys(entries ?? {})) {
        if (!byName.has(dependency)) continue;
        dependencies.get(pkg.name)?.add(dependency);
        dependents.get(dependency)?.add(pkg.name);
      }
    }
  }

  return { packages, byDirectory, byName, dependencies, dependents };
}

export function workspaceForPath(
  graph: WorkspaceGraph,
  path: string,
): WorkspacePackage | undefined {
  const normalized = normalizePath(path);
  let best: WorkspacePackage | undefined;
  for (const [directory, pkg] of graph.byDirectory) {
    if (normalized === directory || normalized.startsWith(`${directory}/`)) {
      if (!best || directory.length > best.dir.length) best = pkg;
    }
  }
  return best;
}

export function transitiveDependents(graph: WorkspaceGraph, names: Iterable<string>): Set<string> {
  const result = new Set<string>();
  const pending = [...names].sort();
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || result.has(name)) continue;
    result.add(name);
    for (const dependent of [...(graph.dependents.get(name) ?? [])].sort()) {
      if (!result.has(dependent)) pending.push(dependent);
    }
  }
  return result;
}

export function transitiveDependencies(
  graph: WorkspaceGraph,
  names: Iterable<string>,
): Set<string> {
  const result = new Set<string>();
  const pending = [...names].sort();
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || result.has(name)) continue;
    result.add(name);
    for (const dependency of [...(graph.dependencies.get(name) ?? [])].sort()) {
      if (!result.has(dependency)) pending.push(dependency);
    }
  }
  return result;
}

export function typecheckProjects(graph = createWorkspaceGraph()): string[] {
  const projects = ["scripts/ci"];
  for (const pkg of graph.packages) {
    if (existsSync(join(pkg.dir, "tsconfig.json"))) projects.push(normalizePath(pkg.dir));
  }
  return projects;
}

function walkFiles(root: string, directory: string, files: string[]): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(root, path, files);
    else if (entry.isFile()) files.push(normalizePath(relative(root, path)));
  }
}

export function discoverTestFiles(root = process.cwd()): {
  unit: string[];
  integration: string[];
  e2e: string[];
} {
  const files: string[] = [];
  for (const directory of TEST_SOURCE_DIRECTORIES) {
    walkFiles(root, join(root, directory), files);
  }
  return {
    unit: files.filter((path) => UNIT_TEST_PATTERN.test(path)).sort(),
    integration: files
      .filter((path) => INTEGRATION_TEST_PATTERN.test(path) && !OPT_IN_TESTS[path])
      .sort(),
    e2e: files.filter((path) => E2E_TEST_PATTERN.test(path) && !OPT_IN_TESTS[path]).sort(),
  };
}

export function assertTestTierMapComplete(root = process.cwd()): void {
  const files: string[] = [];
  for (const directory of TEST_SOURCE_DIRECTORIES) {
    walkFiles(root, join(root, directory), files);
  }
  for (const path of Object.keys(OPT_IN_TESTS)) {
    if (!files.includes(path)) throw new Error(`stale opt-in test mapping: ${path}`);
  }
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const integrationCommand = packageJson.scripts?.["test:integration"] ?? "";
  const e2eCommand = packageJson.scripts?.["test:e2e"] ?? "";
  const browserRunnerSelected = e2eCommand.includes("bun scripts/run-browser-e2e.ts");
  const fullCommands = `${integrationCommand} ${e2eCommand}`;
  for (const path of files.filter(
    (candidate) => INTEGRATION_TEST_PATTERN.test(candidate) || E2E_TEST_PATTERN.test(candidate),
  )) {
    const ownedByBrowserRunner =
      browserRunnerSelected &&
      (path === "test/e2e/browser.e2e.ts" || path.endsWith(".browser.e2e.ts"));
    if (!OPT_IN_TESTS[path] && !ownedByBrowserRunner && !fullCommands.includes(path)) {
      throw new Error(`unmapped integration/e2e test (add to full gate or OPT_IN_TESTS): ${path}`);
    }
  }
}

export function deterministicShards(
  root: string,
  files: readonly string[],
  count: number,
  weights?: ReadonlyMap<string, number>,
): string[][] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("shard count must be >= 1");
  const shards = Array.from({ length: count }, () => ({ weight: 0, files: [] as string[] }));
  const weighted = [...new Set(files)].map((path) => ({
    path,
    weight:
      weights?.get(path) ?? (existsSync(join(root, path)) ? statSync(join(root, path)).size : 0),
  }));
  weighted.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
  for (const item of weighted) {
    const target = shards.reduce((best, shard, index) => {
      const bestShard = shards[best];
      if (!bestShard) return index;
      return shard.weight < bestShard.weight ? index : best;
    }, 0);
    const shard = shards[target];
    if (!shard) throw new Error(`missing deterministic shard ${target}`);
    shard.files.push(item.path);
    shard.weight += item.weight;
  }
  return shards.map((shard) => shard.files.sort());
}

export function integrationShardWeights(
  root = process.cwd(),
  profilePath = join(root, INTEGRATION_SHARD_PROFILE),
): ShardWeightResolution {
  try {
    const bytes = readFileSync(profilePath);
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      schemaVersion?: unknown;
      tier?: unknown;
      units?: unknown;
      environment?: {
        platform?: unknown;
        architecture?: unknown;
        bunVersion?: unknown;
        bunVersionFileSha256?: unknown;
        serviceImagesPath?: unknown;
        serviceImagesSha256?: unknown;
      };
      entries?: Record<string, { sha256?: unknown; planningWeight?: unknown }>;
    };
    if (
      parsed.schemaVersion !== 1 ||
      parsed.tier !== "integration" ||
      parsed.units !== "milliseconds"
    ) {
      throw new Error("unsupported schema, tier, or units");
    }
    const environment = parsed.environment;
    if (
      !environment ||
      environment.platform !== process.platform ||
      environment.architecture !== process.arch ||
      environment.bunVersion !== Bun.version ||
      typeof environment.bunVersionFileSha256 !== "string" ||
      typeof environment.serviceImagesPath !== "string" ||
      typeof environment.serviceImagesSha256 !== "string"
    ) {
      throw new Error("profile environment or toolchain does not match this runner");
    }
    const hashFile = (path: string): string =>
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex");
    if (hashFile(".bun-version") !== environment.bunVersionFileSha256) {
      throw new Error("profile Bun version file fence is stale");
    }
    if (hashFile(environment.serviceImagesPath) !== environment.serviceImagesSha256) {
      throw new Error("profile service-image fence is stale");
    }
    if (!parsed.entries || Array.isArray(parsed.entries))
      throw new Error("entries must be an object");
    const discovered = discoverTestFiles(root).integration;
    const paths = Object.keys(parsed.entries).sort();
    if (JSON.stringify(paths) !== JSON.stringify(discovered)) {
      throw new Error("profile file set does not exactly match discovered integration tests");
    }
    const weights = new Map<string, number>();
    for (const path of paths) {
      const entry = parsed.entries[path];
      if (!entry || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw new Error(`invalid content hash for ${path}`);
      }
      if (!Number.isSafeInteger(entry.planningWeight) || Number(entry.planningWeight) < 1) {
        throw new Error(`invalid planning weight for ${path}`);
      }
      const actual = createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex");
      if (actual !== entry.sha256) throw new Error(`stale content hash for ${path}`);
      weights.set(path, Number(entry.planningWeight));
    }
    return {
      mode: "profile",
      weights,
      reason: "content-fenced integration planning profile",
      profileSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return {
      mode: "source-bytes",
      weights: null,
      reason: error instanceof Error ? error.message : String(error),
      profileSha256: null,
    };
  }
}

export function deterministicFileBatches(files: readonly string[], batchSize: number): string[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("unit batch size must be a positive integer");
  }
  const batches: string[][] = [];
  for (let index = 0; index < files.length; index += batchSize) {
    batches.push(files.slice(index, index + batchSize));
  }
  return batches;
}

export function fileUsesProcessGlobalTestState(root: string, path: string): boolean {
  if (path.endsWith(".tsx") || path.startsWith("apps/web/")) return true;
  if (!existsSync(join(root, path))) return true;
  const source = readFileSync(join(root, path), "utf8");
  return /\bmock\.module\s*\(|GlobalRegistrator\.(?:register|unregister)\s*\(|\bdelete\s+process\.env(?:\s*\[|\.)|process\.env(?:\s*\[[^\]]+\]|\.[A-Za-z_$][\w$]*)\s*=|Object\.assign\s*\(\s*process\.env\b/.test(
    source,
  );
}
