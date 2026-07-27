#!/usr/bin/env bun
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
  type FSWatcher,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, relative } from "node:path";
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
  finish: () => Promise<{ changed: boolean; inputSha256: string }>;
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
    if (owner.requesterPid && !processIsAlive(owner.requesterPid)) {
      return true;
    }
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

    // The lock directory is the immutable generation publication. Move only
    // the generation that was validated above to a unique quarantine path;
    // never recursively delete the shared lock path after a check. A
    // successor can publish a new generation at lockPath as soon as this move
    // wins, and a late reclaimer must be unable to remove it.
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
    const quarantinedOwner = readLockOwner(quarantinePath);
    if ((quarantinedOwner?.token ?? null) !== reclaimer.ownerToken) {
      // A successor may have won the shared path between our last read and
      // rename. Restore this moved generation only if no newer generation has
      // already been published; never overwrite that newer path.
      try {
        renameSync(quarantinePath, lockPath);
      } catch (restoreError) {
        const code = (restoreError as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOENT") {
          throw restoreError;
        }
      }
      return false;
    }
    rmSync(quarantinePath, { recursive: true, force: true });
    return true;
  } finally {
    removeReclaimerIfOwned(lockPath, reclaimer.token);
  }
}

function releasePackageLock(lockPath: string, token: string): void {
  const owner = readLockOwner(lockPath);
  if (owner?.token !== token) {
    return;
  }
  const releasePath = lockQuarantinePath(lockPath, token, "release");
  try {
    renameSync(lockPath, releasePath);
    const releasedOwner = readLockOwner(releasePath);
    if (releasedOwner?.token === token) {
      rmSync(releasePath, { recursive: true, force: true });
    } else {
      // The generation moved under our token check but did not contain the
      // same owner marker. Restore it only when the active path is still
      // absent; never overwrite a successor.
      try {
        renameSync(releasePath, lockPath);
      } catch (restoreError) {
        const code = (restoreError as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOENT") {
          throw restoreError;
        }
      }
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
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
    renameSync(candidatePath, lockPath);

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

  for (const path of [
    "bun.lock",
    "package.json",
    "tsconfig.base.json",
    "scripts/build-publishable-packages.ts",
    "scripts/publishable-workspaces.ts",
    "scripts",
  ]) {
    addInput(join(repoRoot, path));
  }
  for (const dependency of workspaceDependencyClosure(pkg)) {
    addInput(join(repoRoot, dependency.dir));
  }
  return [...directories];
}

function startInputMutationMonitor(
  pkg: WorkspacePackage,
  initialInputSha256: string,
): InputMutationMonitor {
  let dirty = false;
  let checking = false;
  const watchers: FSWatcher[] = [];
  const watchDirectories = inputWatchDirectories(pkg);
  for (const directory of watchDirectories) {
    try {
      watchers.push(
        watch(directory, (_eventType, filename) => {
          // A null filename is an ambiguous directory notification. The
          // polling/final snapshot below still detects real input changes;
          // treating it as dirty would mistake package dist replacement for
          // a source mutation on platforms that omit the filename.
          if (!filename) {
            return;
          }
          const changedPath = join(directory, filename.toString());
          const changedRelativePath = relative(repoRoot, changedPath);
          if (
            changedRelativePath
              .split(/[\\/]+/u)
              .some((part) => INPUT_EXCLUDED_DIRECTORY_NAMES.has(part))
          ) {
            return;
          }
          try {
            if (packageInputSha256(pkg) !== initialInputSha256) {
              dirty = true;
            }
          } catch {
            dirty = true;
          }
        }),
      );
    } catch {
      // A source directory that disappears while the build is running is a
      // mutation. Fail closed rather than publishing an unobserved key.
      dirty = true;
    }
  }

  const poller = setInterval(() => {
    if (checking || dirty) {
      return;
    }
    checking = true;
    try {
      if (packageInputSha256(pkg) !== initialInputSha256) {
        dirty = true;
      }
    } catch {
      dirty = true;
    } finally {
      checking = false;
    }
  }, BUILD_SOURCE_POLL_MS);

  return {
    changed: () => dirty,
    finish: async () => {
      clearInterval(poller);
      for (const watcher of watchers) {
        watcher.close();
      }
      // Let queued fs.watch notifications run before the final snapshot.
      await new Promise<void>((resolve) => setImmediate(resolve));
      let inputSha256 = initialInputSha256;
      try {
        inputSha256 = packageInputSha256(pkg);
      } catch {
        dirty = true;
      }
      if (inputSha256 !== initialInputSha256) {
        dirty = true;
      }
      return { changed: dirty, inputSha256 };
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
            if (attempt === MAX_SOURCE_MUTATION_RETRIES) {
              throw new Error(
                `Build inputs changed during ${pkg.name} build; refusing to publish a cache record`,
              );
            }
            process.stdout.write(
              `[build:packages] source changed during ${pkg.name}; retrying (${attempt}/${MAX_SOURCE_MUTATION_RETRIES})\n`,
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
