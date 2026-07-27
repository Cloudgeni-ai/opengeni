#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  renameSync,
  unlinkSync,
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

const BUILD_CACHE_VERSION = 2;
const buildCacheRoot = join(repoRoot, ".opengeni", "build-cache", "packages");
const workspacePackagesByName = workspacePackageByName();
const INPUT_EXCLUDED_DIRECTORY_NAMES = new Set(["dist", "node_modules", ".opengeni"]);
const LOCK_INITIALIZATION_GRACE_MS = 250;
const LOCK_DRAIN_TIMEOUT_MS = 2_000;
const LOCK_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

type BuildOutput =
  | { path: string; kind: "file"; mode: number; size: number; sha256: string }
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "symlink"; mode: number; target: string }
  | { path: string; kind: "other"; mode: number; size: number };
type BuildInput =
  | { path: string; kind: "file"; mode: number; size: number; sha256: string }
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "symlink"; mode: number; target: string };
type BuildCacheRecord = {
  version: number;
  inputSha256: string;
  outputs: BuildOutput[];
};

type LockOwner = {
  token: string;
  pid: number;
  buildPid: number | null;
  processGroupId: number | null;
  state: "waiting" | "building" | "publishing";
  createdAt: number;
};

type LockReclaimer = {
  token: string;
  pid: number;
  ownerToken: string | null;
  createdAt: number;
};

type PackageLock = {
  token: string;
  update: (update: Partial<Omit<LockOwner, "token" | "pid" | "createdAt">>) => void;
  release: () => void;
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

function lockOwnerPath(lockPath: string): string {
  return join(lockPath, "owner");
}

function lockReclaimerPath(lockPath: string): string {
  return join(lockPath, "reclaim");
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readLockOwner(lockPath: string): LockOwner | null {
  return readJsonFile<LockOwner>(lockOwnerPath(lockPath));
}

function readLockReclaimer(lockPath: string): LockReclaimer | null {
  return readJsonFile<LockReclaimer>(lockReclaimerPath(lockPath));
}

function processIsAlive(pid: number | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processGroupIsAlive(processGroupId: number | null): boolean {
  if (!processGroupId || !Number.isInteger(processGroupId) || processGroupId <= 1) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function terminateBuildProcessTree(owner: LockOwner): void {
  const processGroupId = owner.processGroupId;
  const buildPid = owner.buildPid;
  if (!processGroupId && !buildPid) {
    return;
  }

  if (process.platform === "win32") {
    if (buildPid) {
      spawnSync("taskkill", ["/PID", String(buildPid), "/T", "/F"], {
        stdio: "ignore",
        timeout: LOCK_DRAIN_TIMEOUT_MS,
      });
    }
    if (processIsAlive(buildPid)) {
      throw new Error(`Package build process tree did not drain: ${buildPid}`);
    }
    return;
  }

  if (processGroupId === process.pid) {
    throw new Error("Refusing to terminate the package builder process group");
  }

  if (processGroupId) {
    try {
      process.kill(-processGroupId, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }

    const termDeadline = Date.now() + LOCK_DRAIN_TIMEOUT_MS / 2;
    while (processGroupIsAlive(processGroupId) && Date.now() < termDeadline) {
      sleepSync(25);
    }
    if (processGroupIsAlive(processGroupId)) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
    const killDeadline = Date.now() + LOCK_DRAIN_TIMEOUT_MS / 2;
    while (processGroupIsAlive(processGroupId) && Date.now() < killDeadline) {
      sleepSync(25);
    }
    if (processGroupIsAlive(processGroupId)) {
      throw new Error(`Package build process group did not drain: ${processGroupId}`);
    }
  }

  if (processIsAlive(buildPid)) {
    try {
      process.kill(buildPid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
    const termDeadline = Date.now() + LOCK_DRAIN_TIMEOUT_MS / 2;
    while (processIsAlive(buildPid) && Date.now() < termDeadline) {
      sleepSync(25);
    }
    if (processIsAlive(buildPid)) {
      try {
        process.kill(buildPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
    const killDeadline = Date.now() + LOCK_DRAIN_TIMEOUT_MS / 2;
    while (processIsAlive(buildPid) && Date.now() < killDeadline) {
      sleepSync(25);
    }
    if (processIsAlive(buildPid)) {
      throw new Error(`Package build process did not drain: ${buildPid}`);
    }
  }
}

function writeLockOwner(lockPath: string, owner: LockOwner): void {
  const ownerPath = lockOwnerPath(lockPath);
  const temporaryPath = join(lockPath, `.owner-${owner.token}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(owner)}\n`);
  renameSync(temporaryPath, ownerPath);
}

function writeLockReclaimer(lockPath: string, reclaimer: LockReclaimer): void {
  const reclaimerPath = lockReclaimerPath(lockPath);
  const temporaryPath = join(lockPath, `.reclaim-${reclaimer.token}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(reclaimer)}\n`);
  try {
    // A hard link publishes the complete marker without replacing an existing
    // marker. The marker path is therefore the compare-and-claim gate for all
    // stale-lock contenders, rather than a partially written file.
    linkSync(temporaryPath, reclaimerPath);
  } finally {
    unlinkSync(temporaryPath);
  }
}

function staleLockCanBeReclaimed(lockPath: string, owner: LockOwner | null): boolean {
  if (owner) {
    return !processIsAlive(owner.pid);
  }
  try {
    return Date.now() - lstatSync(lockPath).mtimeMs >= LOCK_INITIALIZATION_GRACE_MS;
  } catch {
    return false;
  }
}

function tryReclaimStaleLock(lockPath: string): boolean {
  const owner = readLockOwner(lockPath);
  if (!staleLockCanBeReclaimed(lockPath, owner)) {
    return false;
  }

  const existingReclaimer = readLockReclaimer(lockPath);
  if (existingReclaimer) {
    if (processIsAlive(existingReclaimer.pid)) {
      return false;
    }
    rmSync(lockReclaimerPath(lockPath), { recursive: true, force: true });
  } else if (existsSync(lockReclaimerPath(lockPath))) {
    // A process can die after creating an old-style directory marker or
    // before publishing a malformed marker. Do not let that partial state
    // convert a dead owner into a five-minute wait.
    try {
      if (
        Date.now() - lstatSync(lockReclaimerPath(lockPath)).mtimeMs <
        LOCK_INITIALIZATION_GRACE_MS
      ) {
        return false;
      }
      rmSync(lockReclaimerPath(lockPath), { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  const reclaimer: LockReclaimer = {
    token: randomUUID(),
    pid: process.pid,
    ownerToken: owner?.token ?? null,
    createdAt: Date.now(),
  };
  try {
    writeLockReclaimer(lockPath, reclaimer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }

  try {
    const currentOwner = readLockOwner(lockPath);
    if ((currentOwner?.token ?? null) !== reclaimer.ownerToken) {
      return false;
    }
    if (currentOwner) {
      terminateBuildProcessTree(currentOwner);
    }
    const finalOwner = readLockOwner(lockPath);
    if ((finalOwner?.token ?? null) !== reclaimer.ownerToken) {
      return false;
    }
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    if (existsSync(lockPath)) {
      rmSync(lockReclaimerPath(lockPath), { recursive: true, force: true });
    }
  }
}

function releasePackageLock(lockPath: string, token: string): void {
  const owner = readLockOwner(lockPath);
  if (owner?.token !== token) {
    return;
  }
  const releasePath = `${lockPath}.release-${token}`;
  try {
    renameSync(lockPath, releasePath);
    const releasedOwner = readLockOwner(releasePath);
    if (releasedOwner?.token === token) {
      rmSync(releasePath, { recursive: true, force: true });
    } else {
      // A stale reclaimer or an already-admitted successor may have changed
      // the path between the first token check and the rename. Never remove
      // that other owner; restore this lock only when the active path is
      // still absent, otherwise leave the successor untouched.
      try {
        renameSync(releasePath, lockPath);
      } catch (restoreError) {
        const code = (restoreError as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOENT") {
          throw restoreError;
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function acquirePackageLock(pkg: WorkspacePackage): PackageLock {
  mkdirSync(buildCacheRoot, { recursive: true });
  const lockPath = packageLockPath(pkg);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockPath);
      const token = randomUUID();
      try {
        writeLockOwner(lockPath, {
          token,
          pid: process.pid,
          buildPid: null,
          processGroupId: null,
          state: "waiting",
          createdAt: Date.now(),
        });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return {
        token,
        update: (update) => {
          const owner = readLockOwner(lockPath);
          if (owner?.token !== token) {
            throw new Error(`Package build lock ownership changed: ${lockPath}`);
          }
          writeLockOwner(lockPath, { ...owner, ...update });
        },
        release: () => releasePackageLock(lockPath, token),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (tryReclaimStaleLock(lockPath)) {
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

function inputEntry(path: string): BuildInput {
  const stats = lstatSync(path);
  const relativePath = relative(repoRoot, path);
  const mode = stats.mode & 0o7777;
  if (stats.isDirectory()) {
    return { path: relativePath, kind: "directory", mode };
  }
  if (stats.isFile()) {
    return {
      path: relativePath,
      kind: "file",
      mode,
      size: stats.size,
      sha256: sha256File(path),
    };
  }
  if (stats.isSymbolicLink()) {
    return { path: relativePath, kind: "symlink", mode, target: readlinkSync(path) };
  }
  throw new Error(`Unsupported build input type at ${relativePath}`);
}

function inputEntriesUnder(directory: string): BuildInput[] {
  let rootEntry: BuildInput;
  try {
    rootEntry = inputEntry(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  if (rootEntry.kind !== "directory") {
    return [rootEntry];
  }

  if (!existsSync(directory)) {
    return [];
  }

  const entries: BuildInput[] = [rootEntry];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const stats = lstatSync(path);
      if (stats.isDirectory() && INPUT_EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      entries.push(inputEntry(path));
      if (stats.isDirectory()) {
        visit(path);
      }
    }
  };
  visit(directory);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
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
  const inputs = new Map<string, BuildInput>();
  const addInput = (path: string): void => {
    for (const entry of inputEntriesUnder(path)) {
      inputs.set(entry.path, entry);
    }
  };
  for (const path of rootInputs) {
    addInput(join(repoRoot, path));
  }
  // Some package build commands delegate to helpers outside their package
  // directory (for example, the worker workflow bundle). Include the whole
  // helper tree so a helper edit can never serve an old package artifact.
  addInput(join(repoRoot, "scripts"));
  for (const dependency of workspaceDependencyClosure(pkg)) {
    addInput(join(repoRoot, dependency.dir));
  }

  for (const entry of [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(JSON.stringify(entry));
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

async function runPackageBuild(pkg: WorkspacePackage, lock: PackageLock): Promise<number> {
  const child = spawn(process.execPath, ["run", "build"], {
    cwd: join(repoRoot, pkg.dir),
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  if (!child.pid) {
    throw new Error(`Could not start package build for ${pkg.name}`);
  }
  lock.update({
    state: "building",
    buildPid: child.pid,
    processGroupId: process.platform === "win32" ? null : child.pid,
  });
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
}

async function main(): Promise<void> {
  for (const pkg of packages) {
    const lock = acquirePackageLock(pkg);
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
      const result = await runPackageBuild(pkg, lock);
      lock.update({ state: "publishing", buildPid: null, processGroupId: null });
      if (result !== 0) {
        process.exitCode = result;
        break;
      }
      recordSuccessfulBuild(pkg, inputSha256);
    } finally {
      lock.release();
    }
  }
}

await main();
