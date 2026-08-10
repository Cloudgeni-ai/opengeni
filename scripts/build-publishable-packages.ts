#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  watch,
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
  type Dirent,
  type FSWatcher,
  type Stats,
} from "node:fs";
import { arch, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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

const BUILD_CACHE_VERSION = 3;
const buildCacheRoot = join(repoRoot, ".opengeni", "build-cache", "packages");
const workspacePackagesByName = workspacePackageByName();
const INPUT_EXCLUDED_DIRECTORY_NAMES = new Set(["dist", "node_modules", ".opengeni"]);
const INPUT_EXCLUDED_FILE_PATTERNS = [/^tsup\.config\.bundled_[^.]+\.mjs$/u];
const LOCK_INITIALIZATION_GRACE_MS = 250;
const LOCK_DRAIN_TIMEOUT_MS = 2_000;
const LOCK_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const BUILD_SOURCE_POLL_MS = 25;
const MAX_SOURCE_MUTATION_RETRIES = 3;
const BUILD_SUPERVISOR_ARG = "--build-supervisor";

type BuildOutput =
  | { path: string; kind: "file"; mode: number; size: number; sha256: string }
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "symlink"; mode: number; target: string }
  | { path: string; kind: "other"; mode: number; size: number };
type BuildInput =
  | { path: string; kind: "file"; mode: number; size: number; sha256: string }
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "symlink"; mode: number; target: string };
type BuildInputGeneration =
  | {
      path: string;
      kind: "file";
      mode: number;
      size: string;
      device: string;
      inode: string;
      modifiedAtNs: string;
      changedAtNs: string;
    }
  | { path: string; kind: "directory"; mode: number; device: string; inode: string }
  | {
      path: string;
      kind: "symlink";
      mode: number;
      target: string;
      device: string;
      inode: string;
      modifiedAtNs: string;
      changedAtNs: string;
    };
type BuildCacheRecord = {
  version: number;
  inputSha256: string;
  outputs: BuildOutput[];
};

type LockOwner = {
  token: string;
  pid: number;
  requesterPid: number;
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
  path: string;
  token: string;
  startBuild: () => void;
  waitForBuild: () => Promise<number>;
  markPublishing: () => void;
  release: () => void;
};

type InputMutationMonitor = {
  changed: () => boolean;
  finish: () => Promise<{
    changed: boolean;
    inputSha256: string;
    reasons: string[];
  }>;
};

function packageCachePath(pkg: WorkspacePackage): string {
  const filename = pkg.name.replace(/[^a-zA-Z0-9._-]+/gu, "_");
  return join(buildCacheRoot, `${filename}.json`);
}

function packageLockPath(pkg: WorkspacePackage): string {
  return `${packageCachePath(pkg)}.lock`;
}

function packageLockClaimPath(lockPath: string): string {
  return `${lockPath}.claim.sqlite`;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isExcludedInputFile(path: string): boolean {
  const name = basename(path);
  return INPUT_EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function isExcludedInputDirectory(path: string): boolean {
  const name = basename(path);
  if (INPUT_EXCLUDED_DIRECTORY_NAMES.has(name)) return true;
  // `target` can be a legitimate domain/source directory. Exclude it only in
  // its standard Cargo meaning: immediately beside the owning Cargo.toml.
  return name === "target" && existsSync(join(dirname(path), "Cargo.toml"));
}

function isWithinExcludedInputDirectory(path: string): boolean {
  let candidate = path;
  while (isPathWithin(repoRoot, candidate)) {
    if (isExcludedInputDirectory(candidate)) return true;
    if (candidate === repoRoot) break;
    candidate = dirname(candidate);
  }
  return false;
}

function isSqliteBusy(error: unknown): boolean {
  return (error as { code?: string }).code === "SQLITE_BUSY";
}

function withPackageLockGenerationClaim<T>(lockPath: string, operation: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    const claim = new Database(packageLockClaimPath(lockPath), { create: true, strict: true });
    try {
      claim.run("PRAGMA busy_timeout = 0");
      claim.run("BEGIN EXCLUSIVE");
    } catch (error) {
      claim.close();
      if (!isSqliteBusy(error) || Date.now() >= deadline) {
        throw error;
      }
      sleepSync(25);
      continue;
    }

    try {
      // SQLite owns the compare-atomic generation claim. Its transaction lock
      // is released by the OS when this process dies, so stale recovery never
      // needs to check-then-remove the claim itself. Every shared lock-path
      // publication, takeover, and release revalidates the owner token while
      // holding this claim; a B successor or C contender therefore cannot
      // interpose between the comparison and path mutation.
      const result = operation();
      claim.run("COMMIT");
      return result;
    } catch (error) {
      try {
        claim.run("ROLLBACK");
      } catch {
        // Preserve the operation/commit failure; close() still releases the
        // crash-safe claim if SQLite has already rolled the transaction back.
      }
      throw error;
    } finally {
      claim.close();
    }
  }
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

function pauseForFailureInjection(environmentName: string): void {
  const pausePath = process.env[environmentName];
  if (!pausePath) {
    return;
  }
  const readyPath = `${pausePath}.ready`;
  const releasePath = `${pausePath}.release`;
  writeFileSync(readyPath, `${process.pid}\n`);
  while (!existsSync(releasePath)) {
    sleepSync(10);
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

function lockQuarantinePath(lockPath: string, token: string, kind: string): string {
  return `${lockPath}.${kind}-${token}-${randomUUID()}`;
}

function removeReclaimerIfOwned(lockPath: string, token: string): void {
  const reclaimerPath = lockReclaimerPath(lockPath);
  const current = readLockReclaimer(lockPath);
  if (current?.token !== token) {
    return;
  }

  const quarantinePath = lockQuarantinePath(lockPath, token, "reclaim-quarantine");
  try {
    renameSync(reclaimerPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const quarantined = readJsonFile<LockReclaimer>(quarantinePath);
  if (quarantined?.token === token) {
    rmSync(quarantinePath, { recursive: true, force: true });
  }
}

function quarantineLegacyReclaimer(lockPath: string): void {
  const reclaimerPath = lockReclaimerPath(lockPath);
  const quarantinePath = lockQuarantinePath(lockPath, "legacy", "reclaim-quarantine");
  try {
    renameSync(reclaimerPath, quarantinePath);
    rmSync(quarantinePath, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

function staleLockCanBeReclaimed(lockPath: string, owner: LockOwner | null): boolean {
  if (owner) {
    if (owner.requesterPid) {
      return !processIsAlive(owner.requesterPid);
    }
    return !processIsAlive(owner.pid);
  }
  try {
    return Date.now() - lstatSync(lockPath).mtimeMs >= LOCK_INITIALIZATION_GRACE_MS;
  } catch {
    return false;
  }
}

function tryReclaimStaleLockUnderClaim(lockPath: string): boolean {
  const owner = readLockOwner(lockPath);
  if (!staleLockCanBeReclaimed(lockPath, owner)) {
    pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_AFTER_RECLAIM_REVALIDATION");
    return false;
  }

  const existingReclaimer = readLockReclaimer(lockPath);
  if (existingReclaimer) {
    if (processIsAlive(existingReclaimer.pid)) {
      return false;
    }
    removeReclaimerIfOwned(lockPath, existingReclaimer.token);
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
      quarantineLegacyReclaimer(lockPath);
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
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
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

    // The SQLite transaction is the compare-atomic generation claim. Every
    // publisher and releaser needs the same claim, so the exact owner token
    // validated above remains authoritative through this rename. There is no
    // move-then-post-check/restore gap in which B can be displaced and C can
    // publish at the shared path.
    const quarantinePath = lockQuarantinePath(
      lockPath,
      reclaimer.ownerToken ?? "ownerless",
      "lock",
    );
    pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_BEFORE_RECLAIM_QUARANTINE");
    try {
      renameSync(lockPath, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    rmSync(quarantinePath, { recursive: true, force: true });
    return true;
  } finally {
    removeReclaimerIfOwned(lockPath, reclaimer.token);
  }
}

function tryReclaimStaleLock(lockPath: string): boolean {
  const observedOwner = readLockOwner(lockPath);
  if (!staleLockCanBeReclaimed(lockPath, observedOwner)) {
    pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_AFTER_LIVE_LOCK_OBSERVATION");
    return false;
  }
  pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_AFTER_STALE_OBSERVATION");
  return withPackageLockGenerationClaim(lockPath, () => tryReclaimStaleLockUnderClaim(lockPath));
}

function releasePackageLockUnderClaim(lockPath: string, token: string): void {
  const owner = readLockOwner(lockPath);
  if (owner?.token !== token) {
    return;
  }
  pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_BEFORE_RELEASE_QUARANTINE");
  const releasePath = lockQuarantinePath(lockPath, token, "release");
  try {
    renameSync(lockPath, releasePath);
    rmSync(releasePath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function releasePackageLock(lockPath: string, token: string): void {
  withPackageLockGenerationClaim(lockPath, () => releasePackageLockUnderClaim(lockPath, token));
}

function scriptPathForSupervisor(): string {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Package build supervisor cannot determine its script path");
  }
  return scriptPath;
}

function stopUnpublishedSupervisor(supervisor: ReturnType<typeof spawn>): void {
  if (!supervisor.pid) {
    return;
  }
  try {
    supervisor.kill("SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function candidateLockPath(lockPath: string, token: string): string {
  return `${lockPath}.candidate-${token}`;
}

function removeCandidateLock(lockPath: string, token: string): void {
  rmSync(candidateLockPath(lockPath, token), { recursive: true, force: true });
}

function publishPackageLock(lockPath: string, pkg: WorkspacePackage): PackageLock | null {
  if (existsSync(lockPath)) {
    return null;
  }
  const token = randomUUID();
  const candidatePath = candidateLockPath(lockPath, token);
  let supervisor: ReturnType<typeof spawn> | null = null;

  try {
    mkdirSync(candidatePath);
    pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_AFTER_CANDIDATE");
    supervisor = spawn(
      process.execPath,
      [
        scriptPathForSupervisor(),
        BUILD_SUPERVISOR_ARG,
        lockPath,
        token,
        pkg.dir,
        String(process.pid),
      ],
      {
        cwd: repoRoot,
        detached: process.platform !== "win32",
        stdio: "inherit",
      },
    );
    if (!supervisor.pid) {
      throw new Error(`Could not start package build supervisor for ${pkg.name}`);
    }
    pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_AFTER_SUPERVISOR_SPAWN");
    const supervisorResult = new Promise<number>((resolve, reject) => {
      let settled = false;
      supervisor?.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      supervisor?.once("close", (status) => {
        if (!settled) {
          settled = true;
          resolve(status ?? 1);
        }
      });
    });

    writeLockOwner(candidatePath, {
      token,
      pid: supervisor.pid,
      requesterPid: process.pid,
      buildPid: null,
      processGroupId: process.platform === "win32" ? null : supervisor.pid,
      state: "waiting",
      createdAt: Date.now(),
    });
    const published = withPackageLockGenerationClaim(lockPath, () => {
      if (existsSync(lockPath)) {
        return false;
      }
      renameSync(candidatePath, lockPath);
      return true;
    });
    if (!published) {
      stopUnpublishedSupervisor(supervisor);
      removeCandidateLock(lockPath, token);
      return null;
    }

    return {
      path: lockPath,
      token,
      startBuild: () => {
        const owner = readLockOwner(lockPath);
        if (owner?.token !== token) {
          throw new Error(`Package build lock ownership changed: ${lockPath}`);
        }
        writeFileSync(join(lockPath, `start-${token}`), `${token}\n`);
      },
      waitForBuild: () => supervisorResult,
      markPublishing: () => {
        pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_BEFORE_REQUESTER_PUBLISH");
        const owner = readLockOwner(lockPath);
        if (owner?.token !== token) {
          throw new Error(`Package build lock ownership changed: ${lockPath}`);
        }
        writeLockOwner(lockPath, {
          ...owner,
          pid: process.pid,
          requesterPid: process.pid,
          buildPid: null,
          processGroupId: null,
          state: "publishing",
        });
      },
      release: () => releasePackageLock(lockPath, token),
    };
  } catch (error) {
    if (supervisor) {
      stopUnpublishedSupervisor(supervisor);
    }
    if (existsSync(candidatePath)) {
      rmSync(candidatePath, { recursive: true, force: true });
    }
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return null;
    }
    throw error;
  }
}

function acquirePackageLock(pkg: WorkspacePackage): PackageLock {
  mkdirSync(buildCacheRoot, { recursive: true });
  const lockPath = packageLockPath(pkg);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    const lock = publishPackageLock(lockPath, pkg);
    if (lock) {
      return lock;
    }
    if (tryReclaimStaleLock(lockPath)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for package build lock: ${lockPath}`);
    }
    sleepSync(25);
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

function packageInputRoots(pkg: WorkspacePackage): string[] {
  return [
    "bun.lock",
    "package.json",
    "tsconfig.base.json",
    "scripts/build-publishable-packages.ts",
    "scripts/publishable-workspaces.ts",
    "scripts",
    ...workspaceDependencyClosure(pkg).map((dependency) => dependency.dir),
  ].map((path) => join(repoRoot, path));
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

function inputChildStats(entry: Dirent, path: string): Stats | null {
  const isExcludedDirectory = entry.isDirectory() && isExcludedInputDirectory(path);
  if (isExcludedDirectory) {
    pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_BEFORE_EXCLUDED_ENTRY_STAT");
  }
  try {
    return lstatSync(path);
  } catch (error) {
    // A build legitimately removes/recreates an excluded directory such as
    // dist after readdir() has returned its Dirent. Treat only that exact
    // stale-directory ENOENT as excluded-output churn. A missing ordinary
    // input, or an excluded path replaced by a symlink/file, remains
    // visible/fail-closed.
    if (isExcludedDirectory && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
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
      const stats = inputChildStats(entry, path);
      if (!stats) {
        continue;
      }
      if (stats.isDirectory() && isExcludedInputDirectory(path)) {
        continue;
      }
      if (!stats.isDirectory() && isExcludedInputFile(path)) {
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

function inputGenerationEntry(path: string): BuildInputGeneration {
  const stats = lstatSync(path, { bigint: true });
  const relativePath = relative(repoRoot, path);
  const mode = Number(stats.mode & 0o7777n);
  const identity = {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
  };
  if (stats.isDirectory()) {
    // Build commands legitimately replace excluded dist/scratch entries under
    // input roots, which changes parent-directory timestamps. Stable
    // structural differences remain covered by the complete content manifest;
    // persistent generation metadata is reserved for files and symlinks whose
    // bytes/targets can influence the build.
    return { path: relativePath, kind: "directory", mode, ...identity };
  }
  const generation = {
    ...identity,
    modifiedAtNs: stats.mtimeNs.toString(),
    changedAtNs: stats.ctimeNs.toString(),
  };
  if (stats.isFile()) {
    return {
      path: relativePath,
      kind: "file",
      mode,
      size: stats.size.toString(),
      ...generation,
    };
  }
  if (stats.isSymbolicLink()) {
    return {
      path: relativePath,
      kind: "symlink",
      mode,
      target: readlinkSync(path),
      ...generation,
    };
  }
  throw new Error(`Unsupported build input type at ${relativePath}`);
}

function inputGenerationEntriesUnder(directory: string): BuildInputGeneration[] {
  let rootEntry: BuildInputGeneration;
  try {
    rootEntry = inputGenerationEntry(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  if (rootEntry.kind !== "directory") {
    return [rootEntry];
  }

  const entries: BuildInputGeneration[] = [rootEntry];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const stats = inputChildStats(entry, path);
      if (!stats) {
        continue;
      }
      if (stats.isDirectory() && isExcludedInputDirectory(path)) {
        continue;
      }
      if (!stats.isDirectory() && isExcludedInputFile(path)) {
        continue;
      }
      entries.push(inputGenerationEntry(path));
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

  const inputs = new Map<string, BuildInput>();
  const addInput = (path: string): void => {
    for (const entry of inputEntriesUnder(path)) {
      inputs.set(entry.path, entry);
    }
  };
  for (const path of packageInputRoots(pkg)) {
    addInput(path);
  }

  for (const entry of [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(JSON.stringify(entry));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function packageInputGenerationSha256(pkg: WorkspacePackage): string {
  const hash = createHash("sha256");
  const entries = new Map<string, BuildInputGeneration>();
  for (const path of packageInputRoots(pkg)) {
    for (const entry of inputGenerationEntriesUnder(path)) {
      entries.set(entry.path, entry);
    }
  }
  for (const entry of [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))) {
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

function inputWatchDirectories(pkg: WorkspacePackage): string[] {
  const directories = new Set<string>();
  const addInput = (path: string): void => {
    for (const entry of inputEntriesUnder(path)) {
      directories.add(
        entry.kind === "directory"
          ? join(repoRoot, entry.path)
          : dirname(join(repoRoot, entry.path)),
      );
    }
  };

  for (const path of packageInputRoots(pkg)) {
    addInput(path);
  }
  return [...directories];
}

function isPathWithin(directory: string, path: string): boolean {
  const relativePath = relative(directory, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function isBuildInputPath(pkg: WorkspacePackage, path: string): boolean {
  if (
    ["bun.lock", "package.json", "tsconfig.base.json"].some(
      (relativePath) => path === join(repoRoot, relativePath),
    )
  ) {
    return true;
  }
  if (isPathWithin(join(repoRoot, "scripts"), path)) {
    return true;
  }
  return workspaceDependencyClosure(pkg).some((dependency) =>
    isPathWithin(join(repoRoot, dependency.dir), path),
  );
}

function startInputMutationMonitor(
  pkg: WorkspacePackage,
  initialInputSha256: string,
): InputMutationMonitor {
  let dirty = false;
  let checking = false;
  const reasons = new Set<string>();
  const initialInputGenerationSha256 = packageInputGenerationSha256(pkg);
  const watchers: FSWatcher[] = [];
  const markDirty = (reason: string): void => {
    dirty = true;
    reasons.add(reason);
  };
  const observeUnattributedNotification = (): void => {
    markDirty("watch:unattributed-notification");
  };
  const watchDirectories = inputWatchDirectories(pkg);
  for (const directory of watchDirectories) {
    try {
      watchers.push(
        watch(directory, (_eventType, filename) => {
          if (process.env.OPENGENI_BUILD_CACHE_DROP_INPUT_WATCH_EVENTS === "1") {
            return;
          }
          // Notifications are generation evidence, not merely prompts to
          // re-read the current bytes. Latch every ambiguous notification and
          // every relevant path immediately: if A changes to B and back to A
          // while this event loop is paused, a later hash can only see A, but
          // the queued notification still proves the build did not observe one
          // stable input generation.
          if (!filename) {
            // A transient input can be created and deleted between content /
            // generation snapshots, while parent-directory timestamps are
            // intentionally excluded to tolerate dist churn. With no path we
            // cannot prove the notification belongs to an excluded output, so
            // preserve it as fail-closed generation evidence.
            observeUnattributedNotification();
            return;
          }
          const changedPath = join(directory, filename.toString());
          if (isExcludedInputFile(changedPath)) {
            return;
          }
          const changedRelativePath = relative(repoRoot, changedPath);
          if (isWithinExcludedInputDirectory(changedPath)) {
            return;
          }
          if (!isBuildInputPath(pkg, changedPath)) {
            return;
          }
          markDirty(`watch:${changedRelativePath}`);
        }),
      );
    } catch {
      // A source directory that disappears while the build is running is a
      // mutation. Fail closed rather than publishing an unobserved key.
      markDirty(`watch-unavailable:${relative(repoRoot, directory)}`);
    }
  }

  const poller = setInterval(() => {
    if (checking || dirty) {
      return;
    }
    checking = true;
    try {
      if (
        packageInputGenerationSha256(pkg) !== initialInputGenerationSha256 ||
        packageInputSha256(pkg) !== initialInputSha256
      ) {
        markDirty("poll:input-state-changed");
      }
    } catch {
      markDirty("poll:input-state-unreadable");
    } finally {
      checking = false;
    }
  }, BUILD_SOURCE_POLL_MS);
  pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_AFTER_INPUT_MONITOR_START");
  if (process.env.OPENGENI_BUILD_CACHE_INJECT_UNATTRIBUTED_EVENT === "1") {
    observeUnattributedNotification();
  }

  return {
    changed: () => dirty,
    finish: async () => {
      clearInterval(poller);
      // A detached build can finish while this wrapper is scheduler-paused.
      // Drain the poll phase before closing the watchers: close() discards
      // queued notifications, so closing first would lose the exact A-B-A
      // evidence this monitor exists to latch.
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const watcher of watchers) {
        watcher.close();
      }
      let inputSha256 = initialInputSha256;
      try {
        if (packageInputGenerationSha256(pkg) !== initialInputGenerationSha256) {
          markDirty("finish:input-generation-changed");
        }
        inputSha256 = packageInputSha256(pkg);
      } catch {
        markDirty("finish:input-state-unreadable");
      }
      if (inputSha256 !== initialInputSha256) {
        markDirty("finish:input-content-changed");
      }
      return { changed: dirty, inputSha256, reasons: [...reasons].sort() };
    },
  };
}

function removeCacheRecordIfMatches(pkg: WorkspacePackage, inputSha256: string): void {
  const record = readJsonFile<BuildCacheRecord>(packageCachePath(pkg));
  if (record?.version === BUILD_CACHE_VERSION && record.inputSha256 === inputSha256) {
    unlinkSync(packageCachePath(pkg));
  }
}

function recordSuccessfulBuild(
  pkg: WorkspacePackage,
  inputSha256: string,
  monitor: InputMutationMonitor,
): boolean {
  const outputs = buildOutputs(pkg);
  if (!outputs?.length) {
    process.stdout.write(`[build:packages] no cache record for ${pkg.name} (no dist output)\n`);
    return true;
  }
  mkdirSync(buildCacheRoot, { recursive: true });
  const cachePath = packageCachePath(pkg);
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (monitor.changed() || packageInputSha256(pkg) !== inputSha256) {
      return false;
    }
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: BUILD_CACHE_VERSION, inputSha256, outputs }, null, 2)}\n`,
    );
    if (monitor.changed() || packageInputSha256(pkg) !== inputSha256) {
      return false;
    }
    renameSync(temporaryPath, cachePath);
    return true;
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
}

for (const pkg of packages) {
  if (!pkg.packageJson.scripts?.build) {
    throw new Error(`${pkg.name} is publishable but has no build script.`);
  }
}

async function runBuildSupervisor(
  lockPath: string,
  token: string,
  packageDirectory: string,
  requesterPid: number,
): Promise<number> {
  const startPath = join(lockPath, `start-${token}`);
  const candidatePath = candidateLockPath(lockPath, token);
  const startupDeadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    if (!existsSync(lockPath)) {
      if (!existsSync(candidatePath)) {
        return 1;
      }
      if (!processIsAlive(requesterPid)) {
        removeCandidateLock(lockPath, token);
        return 1;
      }
      if (Date.now() >= startupDeadline) {
        removeCandidateLock(lockPath, token);
        return 1;
      }
      sleepSync(25);
      continue;
    }
    const owner = readLockOwner(lockPath);
    if (owner?.token !== token) {
      return 1;
    }
    if (existsSync(startPath)) {
      break;
    }
    if (!processIsAlive(requesterPid)) {
      return 1;
    }
    if (Date.now() >= startupDeadline) {
      return 1;
    }
    sleepSync(25);
  }

  const child = spawn(process.execPath, ["run", "build"], {
    cwd: join(repoRoot, packageDirectory),
    // The supervisor is the immutable process-group owner published before
    // this spawn. Keeping the build in its group means a reclaimer can drain
    // the whole tree even if this exact spawn/update interval is interrupted.
    detached: false,
    stdio: "inherit",
  });
  if (!child.pid) {
    return 1;
  }

  pauseForFailureInjection("OPENGENI_BUILD_CACHE_PAUSE_AFTER_BUILD_SPAWN");

  const currentOwner = readLockOwner(lockPath);
  if (currentOwner?.token !== token) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The generation was already replaced; its reclaimer owns cleanup.
    }
    return 1;
  }
  writeLockOwner(lockPath, {
    ...currentOwner,
    state: "building",
    buildPid: child.pid,
    processGroupId: process.platform === "win32" ? null : process.pid,
  });

  let requesterDied = false;
  const requesterPoller = setInterval(() => {
    if (!processIsAlive(requesterPid)) {
      requesterDied = true;
      try {
        if (process.platform === "win32") {
          child.kill();
        } else {
          // The supervisor is the group leader; this drains itself and every
          // build descendant without leaving an orphan for a successor.
          process.kill(-process.pid, "SIGTERM");
        }
      } catch {
        // The child/supervisor may already be exiting.
      }
    }
  }, 25);

  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitStatus) => resolve(exitStatus ?? 1));
  }).finally(() => clearInterval(requesterPoller));

  if (requesterDied) {
    return status === 0 ? 1 : status;
  }
  const finalOwner = readLockOwner(lockPath);
  if (finalOwner?.token === token) {
    writeLockOwner(lockPath, {
      ...finalOwner,
      state: "publishing",
      buildPid: null,
      processGroupId: process.platform === "win32" ? null : process.pid,
    });
  }
  return status;
}

async function runPackageBuild(pkg: WorkspacePackage, lock: PackageLock): Promise<number> {
  lock.startBuild();
  return await lock.waitForBuild();
}

async function main(): Promise<void> {
  for (const pkg of packages) {
    for (let attempt = 1; attempt <= MAX_SOURCE_MUTATION_RETRIES; attempt += 1) {
      const lock = acquirePackageLock(pkg);
      try {
        // A competing builder may have changed the shared dist tree or cache
        // record while this process was waiting. Derive the key only after
        // ownership is established, then keep the lock through validation,
        // build, and publish.
        const inputSha256 = packageInputSha256(pkg);
        if (hasValidCachedBuild(pkg, inputSha256)) {
          process.stdout.write(`[build:packages] cached ${pkg.name} (${pkg.dir})\n`);
          break;
        }

        process.stdout.write(`[build:packages] ${pkg.name} (${pkg.dir})\n`);
        const monitor = startInputMutationMonitor(pkg, inputSha256);
        try {
          const result = await runPackageBuild(pkg, lock);
          lock.markPublishing();
          if (result !== 0) {
            process.exitCode = result;
            await monitor.finish();
            break;
          }

          const recorded = recordSuccessfulBuild(pkg, inputSha256, monitor);
          const observation = await monitor.finish();
          if (!recorded || observation.changed || observation.inputSha256 !== inputSha256) {
            if (recorded) {
              removeCacheRecordIfMatches(pkg, inputSha256);
            }
            const reason =
              observation.reasons.length > 0
                ? ` (${observation.reasons.join(", ")})`
                : " (input hash changed during cache publication)";
            if (attempt === MAX_SOURCE_MUTATION_RETRIES) {
              throw new Error(
                `Build inputs changed during ${pkg.name} build${reason}; refusing to publish a cache record`,
              );
            }
            process.stdout.write(
              `[build:packages] source changed during ${pkg.name}${reason}; retrying (${attempt}/${MAX_SOURCE_MUTATION_RETRIES})\n`,
            );
            continue;
          }
          break;
        } catch (error) {
          await monitor.finish();
          throw error;
        }
      } finally {
        lock.release();
      }
    }
  }
}

if (process.argv[2] === BUILD_SUPERVISOR_ARG) {
  const lockPath = process.argv[3];
  const token = process.argv[4];
  const packageDirectory = process.argv[5];
  const requesterPid = Number(process.argv[6]);
  if (!lockPath || !token || !packageDirectory || !Number.isInteger(requesterPid)) {
    throw new Error("Invalid package build supervisor arguments");
  }
  process.exitCode = await runBuildSupervisor(lockPath, token, packageDirectory, requesterPid);
} else {
  await main();
}
