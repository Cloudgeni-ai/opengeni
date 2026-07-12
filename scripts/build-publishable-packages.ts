#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  publishableWorkspacePackages,
  repoRoot,
  topologicallySortedPackages,
  workspacePackages,
} from "./publishable-workspaces";
import {
  packageBuildFingerprint,
  packageSourceFingerprint,
  prunePackageBuildCache,
  restorePackageBuild,
  savePackageBuild,
} from "./ci/content-cache";
import { createWorkspaceGraph, transitiveDependencies } from "./ci/workspace";

const packages = topologicallySortedPackages(publishableWorkspacePackages());
const graph = createWorkspaceGraph();
const workspaceSourceFingerprints = new Map(
  workspacePackages().map((pkg) => [pkg.name, packageSourceFingerprint(repoRoot, pkg)]),
);
const args = process.argv.slice(2);
let cacheEnabled = true;
let cacheRoot =
  process.env.OPENGENI_BUILD_CACHE_DIR ?? join(repoRoot, ".cache/opengeni/build-packages");
const requested = new Set<string>();
const reportPath = process.env.OPENGENI_BUILD_CACHE_REPORT
  ? resolve(process.env.OPENGENI_BUILD_CACHE_REPORT)
  : null;
const buildEnvironment = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "CI",
    "NODE_ENV",
    "BUN_ENV",
    "SOURCE_DATE_EPOCH",
    "TZ",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "FORCE_COLOR",
  ].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name] as string]],
  ),
);
// The API declaration emitter is the largest single cold-build process. A 1 GiB
// heap fails deterministically; 1.5 GiB succeeds with byte-identical output and
// provides a hard ceiling instead of allowing host-sized Node heap growth.
buildEnvironment.NODE_OPTIONS = "--max-old-space-size=1536";
const toolchain = {
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  ...buildEnvironment,
};
const cacheReport = {
  schemaVersion: 1,
  enabled: cacheEnabled,
  selectedPackages: [] as string[],
  hits: [] as string[],
  misses: [] as Array<{ packageName: string; reason: string }>,
  built: [] as string[],
  failed: null as null | { packageName: string; exitCode: number },
};

function writeReport(): void {
  if (!reportPath) return;
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(cacheReport, null, 2)}\n`);
}
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--no-cache") cacheEnabled = false;
  else if (arg === "--cache-dir" && args[index + 1]) cacheRoot = resolve(args[++index] as string);
  else if (arg === "--package" && args[index + 1]) requested.add(args[++index] as string);
  else {
    throw new Error(
      "usage: build-publishable-packages.ts [--no-cache] [--cache-dir <path>] [--package <name>]...",
    );
  }
}
const known = new Set(packages.map((pkg) => pkg.name));
for (const name of requested) {
  if (!known.has(name)) throw new Error(`unknown publishable package: ${name}`);
}
const selected = requested.size > 0 ? packages.filter((pkg) => requested.has(pkg.name)) : packages;
cacheReport.enabled = cacheEnabled;
cacheReport.selectedPackages = selected.map((pkg) => pkg.name);

for (const pkg of selected) {
  if (!pkg.packageJson.scripts?.build) {
    throw new Error(`${pkg.name} is publishable but has no build script.`);
  }
}

for (const pkg of packages) {
  const dependencyFingerprints = new Map<string, string>();
  const dependencies = transitiveDependencies(graph, [pkg.name]);
  dependencies.delete(pkg.name);
  for (const dependency of [...dependencies].sort()) {
    const sourceFingerprint = workspaceSourceFingerprints.get(dependency);
    if (!sourceFingerprint) {
      throw new Error(`${pkg.name} depends on unknown workspace ${dependency}`);
    }
    dependencyFingerprints.set(dependency, sourceFingerprint);
  }
  const fingerprint = packageBuildFingerprint({
    root: repoRoot,
    pkg,
    dependencyFingerprints,
    toolchain,
  });
  if (!selected.some((candidate) => candidate.name === pkg.name)) continue;
  if (cacheEnabled) {
    const restored = restorePackageBuild({
      root: repoRoot,
      pkg,
      cacheRoot,
      fingerprint,
    });
    if (restored.hit) {
      cacheReport.hits.push(pkg.name);
      process.stdout.write(`[build:packages] HIT ${pkg.name} ${fingerprint.slice(0, 12)}\n`);
      continue;
    }
    cacheReport.misses.push({ packageName: pkg.name, reason: restored.reason });
    process.stdout.write(
      `[build:packages] MISS ${pkg.name} ${fingerprint.slice(0, 12)} (${restored.reason})\n`,
    );
  }
  process.stdout.write(`[build:packages] ${pkg.name} (${pkg.dir})\n`);
  const result = spawnSync("bun", ["run", "build"], {
    cwd: join(repoRoot, pkg.dir),
    env: buildEnvironment,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    cacheReport.failed = { packageName: pkg.name, exitCode: result.status ?? 1 };
    writeReport();
    process.exit(result.status ?? 1);
  }
  cacheReport.built.push(pkg.name);
  if (cacheEnabled) savePackageBuild({ root: repoRoot, pkg, cacheRoot, fingerprint });
}

writeReport();

if (cacheEnabled) {
  const pruned = prunePackageBuildCache({ cacheRoot, keepPerPackage: 2 });
  process.stdout.write(
    `[build:packages] cache-prune kept=${pruned.keptEntries} removed=${pruned.removedEntries}\n`,
  );
}
