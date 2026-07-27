#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { join, relative } from "node:path";
import {
  ALL_DEP_FIELDS,
  publishableWorkspacePackages,
  repoRoot,
  workspaceDependencyNames,
  workspacePackageByName,
  topologicallySortedPackages,
  type WorkspacePackage,
} from "./publishable-workspaces";

const packages = topologicallySortedPackages(publishableWorkspacePackages());

const BUILD_CACHE_VERSION = 1;
const buildCacheRoot = join(repoRoot, ".opengeni", "build-cache", "packages");
const workspacePackagesByName = workspacePackageByName();

type BuildOutput =
  | { path: string; kind: "file"; mode: number; size: number; sha256: string }
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "symlink"; mode: number; target: string }
  | { path: string; kind: "other"; mode: number; size: number };
type BuildCacheRecord = {
  version: number;
  inputSha256: string;
  outputs: BuildOutput[];
};

function packageCachePath(pkg: WorkspacePackage): string {
  const filename = pkg.name.replace(/[^a-zA-Z0-9._-]+/gu, "_");
  return join(buildCacheRoot, `${filename}.json`);
}

function packageLockPath(pkg: WorkspacePackage): string {
  return `${packageCachePath(pkg)}.lock`;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ownerProcessIsDead(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(join(lockPath, "owner"), "utf8"), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function acquirePackageLock(pkg: WorkspacePackage): () => void {
  mkdirSync(buildCacheRoot, { recursive: true });
  const lockPath = packageLockPath(pkg);
  const deadline = Date.now() + 5 * 60 * 1000;

  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (ownerProcessIsDead(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for package build lock: ${lockPath}`, { cause: error });
      }
      sleepSync(25);
    }
  }
}

function workspaceDependencyClosure(pkg: WorkspacePackage): WorkspacePackage[] {
  const selected = new Map<string, WorkspacePackage>();
  const visit = (name: string): void => {
    if (selected.has(name)) {
      return;
    }
    const dependency = workspacePackagesByName.get(name);
    if (!dependency) {
      return;
    }
    selected.set(name, dependency);
    for (const dependencyName of workspaceDependencyNames(dependency, ALL_DEP_FIELDS)) {
      visit(dependencyName);
    }
  };

  visit(pkg.name);
  return [...selected.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".opengeni") {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(directory);
  return files;
}

function buildEnvironmentFingerprint(): string {
  const relevant = Object.keys(process.env)
    .filter(
      (key) =>
        key === "CI" ||
        key === "NODE_ENV" ||
        key === "BROWSERSLIST_ENV" ||
        key.startsWith("OPENGENI_"),
    )
    .sort()
    .map((key) => `${key}=${process.env[key] ?? ""}`);
  return relevant.join("\n");
}

function packageInputSha256(pkg: WorkspacePackage): string {
  const hash = createHash("sha256");
  hash.update(`cache-version:${BUILD_CACHE_VERSION}\n`);
  hash.update(`platform:${platform()}\narch:${arch()}\n`);
  hash.update(`bun:${process.versions.bun ?? process.version}\n`);
  hash.update(`env:\n${buildEnvironmentFingerprint()}\n`);

  const rootInputs = [
    "bun.lock",
    "package.json",
    "tsconfig.base.json",
    "scripts/build-publishable-packages.ts",
    "scripts/publishable-workspaces.ts",
  ];
  const inputs = new Set(rootInputs.map((path) => join(repoRoot, path)));
  // Some package build commands delegate to helpers outside their package
  // directory (for example, the worker workflow bundle). Include the whole
  // helper tree so a helper edit can never serve an old package artifact.
  for (const path of filesUnder(join(repoRoot, "scripts"))) {
    inputs.add(path);
  }
  for (const dependency of workspaceDependencyClosure(pkg)) {
    for (const path of filesUnder(join(repoRoot, dependency.dir))) {
      inputs.add(path);
    }
  }

  for (const path of [...inputs].sort()) {
    hash.update(relative(repoRoot, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function outputEntriesUnder(directory: string): BuildOutput[] {
  const outputs: BuildOutput[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const stats = lstatSync(path);
      const mode = stats.mode & 0o7777;
      const relativePath = relative(repoRoot, path);

      if (stats.isDirectory()) {
        outputs.push({ path: relativePath, kind: "directory", mode });
        visit(path);
      } else if (stats.isFile()) {
        outputs.push({
          path: relativePath,
          kind: "file",
          mode,
          size: stats.size,
          sha256: sha256File(path),
        });
      } else if (stats.isSymbolicLink()) {
        outputs.push({ path: relativePath, kind: "symlink", mode, target: readlinkSync(path) });
      } else {
        outputs.push({ path: relativePath, kind: "other", mode, size: stats.size });
      }
    }
  };
  visit(directory);
  return outputs.sort((a, b) => a.path.localeCompare(b.path));
}

function buildOutputs(pkg: WorkspacePackage): BuildOutput[] | null {
  const dist = join(repoRoot, pkg.dir, "dist");
  if (!existsSync(dist) || !lstatSync(dist).isDirectory()) {
    return null;
  }
  return outputEntriesUnder(dist);
}

function hasValidCachedBuild(pkg: WorkspacePackage, inputSha256: string): boolean {
  let record: BuildCacheRecord;
  try {
    record = JSON.parse(readFileSync(packageCachePath(pkg), "utf8")) as BuildCacheRecord;
  } catch {
    return false;
  }
  if (
    record.version !== BUILD_CACHE_VERSION ||
    record.inputSha256 !== inputSha256 ||
    !record.outputs.length
  ) {
    return false;
  }
  const currentOutputs = buildOutputs(pkg);
  if (!currentOutputs || currentOutputs.length !== record.outputs.length) {
    return false;
  }
  return record.outputs.every((output, index) => {
    const current = currentOutputs[index];
    return JSON.stringify(current) === JSON.stringify(output);
  });
}

function recordSuccessfulBuild(pkg: WorkspacePackage, inputSha256: string): void {
  const outputs = buildOutputs(pkg);
  if (!outputs?.length) {
    process.stdout.write(`[build:packages] no cache record for ${pkg.name} (no dist output)\n`);
    return;
  }
  mkdirSync(buildCacheRoot, { recursive: true });
  const cachePath = packageCachePath(pkg);
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: BUILD_CACHE_VERSION, inputSha256, outputs }, null, 2)}\n`,
  );
  renameSync(temporaryPath, cachePath);
}

for (const pkg of packages) {
  if (!pkg.packageJson.scripts?.build) {
    throw new Error(`${pkg.name} is publishable but has no build script.`);
  }
}

for (const pkg of packages) {
  const releasePackageLock = acquirePackageLock(pkg);
  try {
    // A competing builder may have changed the shared dist tree or cache record
    // while this process was waiting. Derive the key only after ownership is
    // established, then keep the lock through validation, build, and publish.
    const inputSha256 = packageInputSha256(pkg);
    if (hasValidCachedBuild(pkg, inputSha256)) {
      process.stdout.write(`[build:packages] cached ${pkg.name} (${pkg.dir})\n`);
      continue;
    }

    process.stdout.write(`[build:packages] ${pkg.name} (${pkg.dir})\n`);
    const result = spawnSync("bun", ["run", "build"], {
      cwd: join(repoRoot, pkg.dir),
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
    recordSuccessfulBuild(pkg, inputSha256);
  } finally {
    releasePackageLock();
  }
}
