import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  BrowserWorkingCopyAdoption,
  BrowserWorkingRuntimeAuthority,
  BrowserWorkingRuntimeReceipt,
} from "./working-runtime-journal";

/** Adoption of a verified copied working directory.
 *
 * A working copy is bound to its profile directory's device and inode. A copy
 * restored after disk loss holds the same bytes in a new directory, so the
 * ordinary recovery path refuses it by design. Adoption is the supported way
 * to continue from such a copy:
 *
 * - an approved manifest digest names the exact bytes to adopt;
 * - a durable intent record is written before any side effect;
 * - the copy is made, without following links, into a fresh staging
 *   directory and verified against that digest;
 * - an adopt receipt with the staged profile's own identity is appended;
 * - the original directory is preserved under a new name and the staged copy
 *   takes its place, with every step journaled so a crash at any boundary is
 *   reconciled forward or reported, never guessed.
 *
 * Nothing here deletes bytes. Retained staging and preserved directories are
 * reported by status and removed only by a separately authorized cleanup.
 */

export type DirectoryIdentity = { device: number; inode: number };

export type WorkingCopyManifest = {
  digest: string;
  entries: number;
  bytes: number;
};

export type WorkingCopyAdoptionPhase =
  | "intent"
  | "copied"
  | "receipt"
  | "source_preserved"
  | "adopted"
  | "interrupted"
  | "failed"
  | "collision";

export type WorkingCopyAdoptionRecord = {
  version: 1;
  operationId: string;
  browserSessionId: string;
  controllerGeneration: string;
  manifestDigest: string;
  source: { session: DirectoryIdentity; profile: DirectoryIdentity };
  stagingName: string;
  preservedName: string;
  staging: { session: DirectoryIdentity; profile: DirectoryIdentity } | null;
  phase: WorkingCopyAdoptionPhase;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Phases after which nothing further happens without a new operation. */
export const TERMINAL_ADOPTION_PHASES: ReadonlySet<WorkingCopyAdoptionPhase> = new Set([
  "adopted",
  "interrupted",
  "failed",
]);

export type WorkingCopyAdoptionFailureReason =
  | "unsupported_platform"
  | "unsupported_entry"
  | "working_copy_changed"
  | "digest_mismatch"
  | "adoption_in_progress"
  | "adoption_collision"
  | "operation_conflict"
  // Refusals proven before anything is written.
  | "browser_running"
  | "working_copy_invalid"
  | "receipt_not_adoptable"
  | "authority_changed"
  | "process_state_unknown"
  | "adoption_not_needed"
  | "adoption_unresolved";

export class WorkingCopyAdoptionError extends Error {
  constructor(
    readonly reason: WorkingCopyAdoptionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "WorkingCopyAdoptionError";
  }
}

const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2_000_000;

/** Entries that are derived or per-launch and never part of a working copy:
 * SQLite shared-memory indexes (rebuilt from the WAL on open, and rewritten
 * merely by reading a journal) and per-launch launcher scripts/FIFOs, which
 * the controller recreates for every launch and reaps on startup. */
export function isTransientWorkingCopyEntry(relativePath: string): boolean {
  if (relativePath.endsWith("-shm")) return true;
  return relativePath === "chrome-launch" || relativePath.startsWith("chrome-launch/");
}

type ManifestLine = [path: string, kind: string, mode: number, size: number, content: string];

function manifestDigest(lines: ManifestLine[]): string {
  const hash = createHash("sha256");
  hash.update("opengeni.browser-working-copy.v1\n");
  for (const line of [...lines].sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  ))
    hash.update(`${JSON.stringify(line)}\n`);
  return hash.digest("hex");
}

function changed(path: string): WorkingCopyAdoptionError {
  return new WorkingCopyAdoptionError(
    "working_copy_changed",
    `working copy changed while it was read (${path})`,
  );
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new WorkingCopyAdoptionError("unsupported_entry", "working copy path is not a directory");
  }
  return { device: metadata.dev, inode: metadata.ino };
}

type Visit =
  | { kind: "directory"; relativePath: string; mode: number }
  | { kind: "file"; relativePath: string; mode: number; size: number; sha256: string }
  | { kind: "symlink"; relativePath: string; target: string };

/** Walk one directory tree without following links or leaving it. Each
 * directory is checked to be the same directory before and after it is
 * listed and to resolve inside the root; each file is opened with O_NOFOLLOW
 * and must be the inode that was listed. Anything else is refused. */
async function walk(
  root: string,
  onEntry: (visit: Visit, absolutePath: string, chunk?: AsyncIterable<Buffer>) => Promise<void>,
): Promise<WorkingCopyManifest> {
  const resolvedRoot = await realpath(root);
  if (resolvedRoot !== resolve(root)) {
    throw new WorkingCopyAdoptionError("unsupported_entry", "working copy root is not canonical");
  }
  const lines: ManifestLine[] = [];
  let bytes = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    const absoluteDirectory = relativeDirectory
      ? join(resolvedRoot, relativeDirectory)
      : resolvedRoot;
    const before = await lstat(absoluteDirectory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw changed(relativeDirectory || ".");
    if ((await realpath(absoluteDirectory)) !== absoluteDirectory) {
      throw new WorkingCopyAdoptionError(
        "unsupported_entry",
        `working copy directory leaves its root (${relativeDirectory})`,
      );
    }
    const names = (await readdir(absoluteDirectory)).sort();
    const after = await lstat(absoluteDirectory);
    if (!sameIdentity(before, after) || !after.isDirectory())
      throw changed(relativeDirectory || ".");
    const directoryPath = relativeDirectory || ".";
    lines.push([directoryPath, "directory", before.mode & 0o7777, 0, ""]);
    await onEntry(
      { kind: "directory", relativePath: directoryPath, mode: before.mode & 0o7777 },
      absoluteDirectory,
    );
    for (const name of names) {
      if (name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
        throw new WorkingCopyAdoptionError(
          "unsupported_entry",
          "working copy entry name is invalid",
        );
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (isTransientWorkingCopyEntry(relativePath)) continue;
      if (lines.length >= MAX_ENTRIES) {
        throw new WorkingCopyAdoptionError(
          "unsupported_entry",
          "working copy has too many entries",
        );
      }
      const absolutePath = join(absoluteDirectory, name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        const again = await lstat(absolutePath);
        if (!again.isSymbolicLink() || !sameIdentity(metadata, again)) throw changed(relativePath);
        lines.push([relativePath, "symlink", 0, 0, target]);
        await onEntry({ kind: "symlink", relativePath, target }, absolutePath);
      } else if (metadata.isDirectory()) {
        pending.push(relativePath);
      } else if (metadata.isFile()) {
        const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || !sameIdentity(metadata, opened)) throw changed(relativePath);
          const hash = createHash("sha256");
          let size = 0;
          const chunks = (async function* () {
            const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
            for (;;) {
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
              if (bytesRead === 0) return;
              const chunk = buffer.subarray(0, bytesRead);
              hash.update(chunk);
              size += bytesRead;
              yield chunk;
            }
          })();
          let consumed = false;
          await onEntry(
            { kind: "file", relativePath, mode: metadata.mode & 0o7777, size: 0, sha256: "" },
            absolutePath,
            {
              [Symbol.asyncIterator]: () => {
                consumed = true;
                return chunks;
              },
            },
          );
          if (!consumed) for await (const _chunk of chunks);
          const closing = await handle.stat();
          if (closing.size !== size || closing.mtimeMs !== opened.mtimeMs)
            throw changed(relativePath);
          bytes += size;
          lines.push([relativePath, "file", metadata.mode & 0o7777, size, hash.digest("hex")]);
        } finally {
          await handle.close();
        }
      } else {
        throw new WorkingCopyAdoptionError(
          "unsupported_entry",
          `working copy holds an unsupported special file (${relativePath})`,
        );
      }
    }
  }
  return { digest: manifestDigest(lines), entries: lines.length, bytes };
}

/** Exact manifest of a working directory, excluding transient entries. */
export async function workingCopyManifest(directory: string): Promise<WorkingCopyManifest> {
  return await walk(directory, async () => {});
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Copy one tree into a new directory, hashing exactly the bytes read.
 * The destination must not exist. Returns the manifest of what was read. */
export async function copyWorkingCopy(
  sourceDirectory: string,
  destinationDirectory: string,
): Promise<WorkingCopyManifest> {
  const destinationRoot = resolve(destinationDirectory);
  const createdDirectories: Array<{ path: string; mode: number }> = [];
  const manifest = await walk(sourceDirectory, async (visit, absolutePath, content) => {
    const target =
      visit.relativePath === "." ? destinationRoot : join(destinationRoot, visit.relativePath);
    if (visit.kind === "directory") {
      await mkdir(target, { mode: 0o700 });
      createdDirectories.push({ path: target, mode: visit.mode });
      return;
    }
    if (visit.kind === "symlink") {
      await symlink(visit.target, target);
      return;
    }
    const source = await lstat(absolutePath);
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      for await (const chunk of content!) await handle.write(chunk);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, visit.mode);
    await utimes(target, source.atime, source.mtime);
  });
  for (const directory of createdDirectories.reverse()) {
    await chmod(directory.path, directory.mode);
    await syncDirectory(directory.path);
  }
  return manifest;
}

export type AdoptionPaths = {
  sessionsDirectory: string;
  live: string;
  recordsDirectory: string;
  activePath: string;
};

export function adoptionPaths(rootDirectory: string, browserSessionId: string): AdoptionPaths {
  const sessionsDirectory = join(rootDirectory, "sessions");
  const recordsDirectory = join(rootDirectory, "working-copy-adoptions", browserSessionId);
  return {
    sessionsDirectory,
    live: join(sessionsDirectory, browserSessionId),
    recordsDirectory,
    activePath: join(recordsDirectory, "active"),
  };
}

function recordPath(paths: AdoptionPaths, operationId: string): string {
  return join(paths.recordsDirectory, `${operationId}.json`);
}

/** Durably write one record: temp file, fsync, rename, fsync directory. */
export async function writeAdoptionRecord(
  paths: AdoptionPaths,
  record: WorkingCopyAdoptionRecord,
): Promise<WorkingCopyAdoptionRecord> {
  await mkdir(paths.recordsDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(paths.recordsDirectory, `.${record.operationId}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, recordPath(paths, record.operationId));
  await syncDirectory(paths.recordsDirectory);
  return record;
}

export async function readAdoptionRecord(
  paths: AdoptionPaths,
  operationId: string,
): Promise<WorkingCopyAdoptionRecord | null> {
  let text: string;
  try {
    text = await readFile(recordPath(paths, operationId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseAdoptionRecord(JSON.parse(text));
}

export async function readActiveAdoption(paths: AdoptionPaths): Promise<string | null> {
  try {
    const operationId = (await readFile(paths.activePath, "utf8")).trim();
    if (!UUID.test(operationId)) throw new Error("working copy adoption marker is invalid");
    return operationId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Claim the single active adoption for one browser. Succeeds when this
 * operation already holds it; throws when another operation does. */
export async function claimActiveAdoption(
  paths: AdoptionPaths,
  operationId: string,
): Promise<void> {
  await mkdir(paths.recordsDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(paths.recordsDirectory, `.active.${randomUUID()}.tmp`);
  await writeFile(temporary, operationId, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, paths.activePath);
    await syncDirectory(paths.recordsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = await readActiveAdoption(paths);
    if (holder !== operationId) {
      throw new WorkingCopyAdoptionError(
        "adoption_in_progress",
        "another working copy adoption is in progress for this browser",
      );
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function releaseActiveAdoption(
  paths: AdoptionPaths,
  operationId: string,
): Promise<void> {
  if ((await readActiveAdoption(paths)) !== operationId) return;
  await unlink(paths.activePath);
  await syncDirectory(paths.recordsDirectory);
}

async function identityOrNull(path: string): Promise<DirectoryIdentity | null> {
  try {
    return await directoryIdentity(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function equalIdentity(left: DirectoryIdentity | null, right: DirectoryIdentity | null) {
  return (
    left !== null && right !== null && left.device === right.device && left.inode === right.inode
  );
}

async function advance(
  paths: AdoptionPaths,
  record: WorkingCopyAdoptionRecord,
  phase: WorkingCopyAdoptionPhase,
  changes: Partial<WorkingCopyAdoptionRecord> = {},
): Promise<WorkingCopyAdoptionRecord> {
  return await writeAdoptionRecord(paths, {
    ...record,
    ...changes,
    phase,
    updatedAt: new Date().toISOString(),
  });
}

/** Bring one record to a terminal phase where the filesystem proves it, and
 * otherwise to an explicit blocked phase. It never deletes anything and never
 * classifies an unknown state as absent. Idempotent across restarts. */
export async function reconcileAdoption(
  paths: AdoptionPaths,
  record: WorkingCopyAdoptionRecord,
): Promise<WorkingCopyAdoptionRecord> {
  const staging = join(paths.sessionsDirectory, record.stagingName);
  const preserved = join(paths.sessionsDirectory, record.preservedName);
  let current = record;
  if (current.phase === "intent" || current.phase === "copied") {
    // No receipt was written: the decision to adopt never became durable. The
    // original is still live if its identity is; any staging copy is kept.
    const live = await identityOrNull(paths.live);
    current = equalIdentity(live, current.source.session)
      ? await advance(paths, current, "interrupted", { failureCode: "adoption_interrupted" })
      : await advance(paths, current, "collision", { failureCode: "live_directory_changed" });
  }
  if (current.phase === "receipt") {
    const live = await identityOrNull(paths.live);
    if (equalIdentity(live, current.source.session)) {
      if (await identityOrNull(preserved)) {
        return await advance(paths, current, "collision", {
          failureCode: "preserved_name_taken",
        });
      }
      await rename(paths.live, preserved);
      await syncDirectory(paths.sessionsDirectory);
      current = await advance(paths, current, "source_preserved");
    } else if (
      live === null &&
      equalIdentity(await identityOrNull(preserved), current.source.session)
    ) {
      current = await advance(paths, current, "source_preserved");
    } else if (current.staging && equalIdentity(live, current.staging.session)) {
      current = await advance(paths, current, "source_preserved");
    } else {
      return await advance(paths, current, "collision", { failureCode: "live_directory_changed" });
    }
  }
  if (current.phase === "source_preserved") {
    const live = await identityOrNull(paths.live);
    if (current.staging && equalIdentity(live, current.staging.session)) {
      current = await advance(paths, current, "adopted");
    } else if (
      live === null &&
      current.staging &&
      equalIdentity(await identityOrNull(staging), current.staging.session)
    ) {
      await rename(staging, paths.live);
      await syncDirectory(paths.sessionsDirectory);
      current = await advance(paths, current, "adopted");
    } else {
      return await advance(paths, current, "collision", { failureCode: "live_directory_changed" });
    }
  }
  if (TERMINAL_ADOPTION_PHASES.has(current.phase)) {
    await releaseActiveAdoption(paths, current.operationId);
  }
  return current;
}

/** Reconcile the active adoption for a browser, if any. Returns the record
 * that still blocks ordinary launches, or null when none does. */
export async function settleActiveAdoption(
  paths: AdoptionPaths,
): Promise<WorkingCopyAdoptionRecord | null> {
  const operationId = await readActiveAdoption(paths);
  if (!operationId) return null;
  const record = await readAdoptionRecord(paths, operationId);
  if (!record) {
    // The claim precedes the record only within one adoption call; a claim
    // with no record therefore made no change. Leave it visible as blocking
    // only if the record cannot be read for another reason.
    await releaseActiveAdoption(paths, operationId);
    return null;
  }
  const settled = await reconcileAdoption(paths, record);
  return TERMINAL_ADOPTION_PHASES.has(settled.phase) ? null : settled;
}

export type AdoptWorkingCopyInput = {
  operationId: string;
  browserSessionId: string;
  controllerGeneration: string;
  manifestDigest: string;
  /** Called with the verified staging directory before it can become live.
   * Appends the adopt receipt; must be idempotent for the same operation. */
  appendReceipt(stagingDirectory: string): Promise<void>;
  /** Fault injection for tests: called after each durable phase. */
  afterPhase?: (phase: WorkingCopyAdoptionPhase) => Promise<void>;
};

export async function adoptWorkingCopy(
  paths: AdoptionPaths,
  input: AdoptWorkingCopyInput,
): Promise<WorkingCopyAdoptionRecord> {
  if (process.platform !== "linux") {
    throw new WorkingCopyAdoptionError(
      "unsupported_platform",
      "working copy adoption is supported only on Linux controllers",
    );
  }
  const existing = await readAdoptionRecord(paths, input.operationId);
  if (existing) {
    if (
      existing.browserSessionId !== input.browserSessionId ||
      existing.controllerGeneration !== input.controllerGeneration ||
      existing.manifestDigest !== input.manifestDigest
    ) {
      throw new WorkingCopyAdoptionError(
        "operation_conflict",
        "adoption operation id is bound to another request",
      );
    }
    // A retry never repeats a side effect; it only reconciles what exists.
    return await reconcileAdoption(paths, existing);
  }
  const blocking = await settleActiveAdoption(paths);
  if (blocking) {
    throw new WorkingCopyAdoptionError(
      blocking.phase === "collision" ? "adoption_collision" : "adoption_in_progress",
      "another working copy adoption for this browser is unresolved",
    );
  }
  const sessionIdentity = await directoryIdentity(paths.live);
  const profileIdentity = await directoryIdentity(join(paths.live, "profile"));
  const now = new Date().toISOString();
  // The claim precedes the record, and the record precedes every side effect:
  // a claim without a record proves nothing was changed.
  await claimActiveAdoption(paths, input.operationId);
  let record = await writeAdoptionRecord(paths, {
    version: 1,
    operationId: input.operationId,
    browserSessionId: input.browserSessionId,
    controllerGeneration: input.controllerGeneration,
    manifestDigest: input.manifestDigest,
    source: { session: sessionIdentity, profile: profileIdentity },
    stagingName: `${input.browserSessionId}.adopt-${input.operationId}`,
    preservedName: `${input.browserSessionId}.preserved-${input.operationId}`,
    staging: null,
    phase: "intent",
    failureCode: null,
    createdAt: now,
    updatedAt: now,
  });
  await input.afterPhase?.("intent");
  const staging = join(paths.sessionsDirectory, record.stagingName);
  let read: WorkingCopyManifest;
  try {
    read = await copyWorkingCopy(paths.live, staging);
  } catch (error) {
    if (!(error instanceof WorkingCopyAdoptionError)) throw error;
    // A definite refusal while reading: the original was only read and the
    // partial staging copy is kept for inspection.
    record = await advance(paths, record, "failed", { failureCode: error.reason });
    await releaseActiveAdoption(paths, input.operationId);
    throw error;
  }
  if (read.digest !== input.manifestDigest) {
    record = await advance(paths, record, "failed", { failureCode: "digest_mismatch" });
    await releaseActiveAdoption(paths, input.operationId);
    throw new WorkingCopyAdoptionError(
      "digest_mismatch",
      "the working copy no longer matches the approved manifest; nothing was adopted",
    );
  }
  const written = await workingCopyManifest(staging);
  if (written.digest !== input.manifestDigest) {
    record = await advance(paths, record, "failed", { failureCode: "copy_verification_failed" });
    await releaseActiveAdoption(paths, input.operationId);
    throw new WorkingCopyAdoptionError(
      "digest_mismatch",
      "the staged copy does not match the approved manifest; nothing was adopted",
    );
  }
  if (!equalIdentity(await identityOrNull(paths.live), sessionIdentity)) {
    record = await advance(paths, record, "collision", { failureCode: "live_directory_changed" });
    throw new WorkingCopyAdoptionError(
      "adoption_collision",
      "the live working directory changed during adoption; both copies are kept",
    );
  }
  record = await advance(paths, record, "copied", {
    staging: {
      session: await directoryIdentity(staging),
      profile: await directoryIdentity(join(staging, "profile")),
    },
  });
  await input.afterPhase?.("copied");
  await input.appendReceipt(staging);
  record = await advance(paths, record, "receipt");
  await input.afterPhase?.("receipt");
  record = await reconcileAdoption(paths, record);
  return record;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type BrowserWorkingCopyAuthorityInput = {
  browserSessionId: string;
  controllerGeneration: string;
  authority: BrowserWorkingRuntimeAuthority;
};

export type BrowserWorkingCopyRefusal =
  | "unsupported_platform"
  | "browser_running"
  | "working_copy_invalid"
  | "receipt_not_adoptable"
  | "authority_changed"
  | "process_state_unknown"
  | "adoption_not_needed"
  | "adoption_unresolved";

export type BrowserWorkingCopyAdoptionStatus = {
  operationId: string;
  browserSessionId: string;
  controllerGeneration: string;
  manifestDigest: string;
  phase: WorkingCopyAdoptionPhase;
  failureCode: string | null;
  /** Sibling directories this adoption kept, by name under sessions/. */
  retainedDirectories: string[];
  createdAt: string;
  updatedAt: string;
};

export type BrowserWorkingCopyInspection = {
  browserSessionId: string;
  controllerGeneration: string;
  platformSupported: boolean;
  /** Exact digest of the bytes adoption would take; null when refused. */
  manifest: WorkingCopyManifest | null;
  currentProfile: DirectoryIdentity | null;
  receipt: {
    operationId: string;
    intent: BrowserWorkingRuntimeReceipt["intent"];
    state: BrowserWorkingRuntimeReceipt["state"];
    recordedProfile: DirectoryIdentity;
    /** Digest of the checkpoint restore this working copy was launched from. */
    restoreAuthorityDigest: string | null;
    directoryLaunchAllowed: boolean;
    authorityMatches: boolean;
    adoption: BrowserWorkingCopyAdoption | null;
  } | null;
  profileIdentityMatches: boolean;
  /** false only when no process provably uses the profile. */
  profileInUse: boolean | null;
  activeAdoption: BrowserWorkingCopyAdoptionStatus | null;
  refusal: BrowserWorkingCopyRefusal | null;
};

export function emptyWorkingCopyEvidence(
  input: { browserSessionId: string; controllerGeneration: string },
  refusal: BrowserWorkingCopyRefusal,
): Omit<BrowserWorkingCopyInspection, "platformSupported" | "activeAdoption"> {
  return {
    browserSessionId: input.browserSessionId,
    controllerGeneration: input.controllerGeneration,
    manifest: null,
    currentProfile: null,
    receipt: null,
    profileIdentityMatches: false,
    profileInUse: null,
    refusal,
  };
}

const REFUSAL_MESSAGES: Record<BrowserWorkingCopyRefusal, string> = {
  unsupported_platform: "working copy adoption is supported only on Linux controllers",
  browser_running:
    "the browser is running on this controller; only a stopped working copy can be adopted",
  working_copy_invalid: "the working directory is incomplete or is not a plain directory",
  receipt_not_adoptable:
    "the working copy has no completed launch record with a browser process, so it cannot be adopted",
  authority_changed:
    "the working copy was launched under another controller authority, so it cannot be adopted here",
  process_state_unknown: "a process may still be using the working copy, so it is left untouched",
  adoption_not_needed:
    "the working copy is still the directory it was launched in; it can be continued without adoption",
  adoption_unresolved: "another working copy adoption for this browser is unresolved",
};

export function workingCopyRefusalError(refusal: BrowserWorkingCopyRefusal) {
  return new WorkingCopyAdoptionError(refusal, REFUSAL_MESSAGES[refusal]);
}

export async function workingCopyAdoptionStatus(
  paths: AdoptionPaths,
  record: WorkingCopyAdoptionRecord,
): Promise<BrowserWorkingCopyAdoptionStatus> {
  const retainedDirectories: string[] = [];
  for (const name of [record.stagingName, record.preservedName]) {
    if (await identityOrNull(join(paths.sessionsDirectory, name))) retainedDirectories.push(name);
  }
  return {
    operationId: record.operationId,
    browserSessionId: record.browserSessionId,
    controllerGeneration: record.controllerGeneration,
    manifestDigest: record.manifestDigest,
    phase: record.phase,
    failureCode: record.failureCode,
    retainedDirectories,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const BROWSER_JOURNALS = [
  "working-runtime.sqlite",
  "operations.sqlite",
  "state-transfers.sqlite",
  "protected-auth-operations.sqlite",
  "downloads/downloads.sqlite",
];

/** SQLite integrity of the controller's own journals in a staged copy. The
 * staged copy is the adopter's own; opening it may fold its WAL, which is a
 * change to the adopter's copy only, after its bytes were verified. */
export async function assertWorkingCopyJournalsIntact(directory: string): Promise<void> {
  for (const name of BROWSER_JOURNALS) {
    const path = join(directory, name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile()) throw workingCopyRefusalError("working_copy_invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let result: string | undefined;
    try {
      const database = new Database(path, { readwrite: true, create: false, strict: true });
      try {
        result = (database.query("PRAGMA integrity_check").get() as { integrity_check?: string })
          ?.integrity_check;
      } finally {
        database.close();
      }
    } catch {
      result = undefined;
    }
    if (result !== "ok") {
      throw new WorkingCopyAdoptionError(
        "working_copy_invalid",
        `the working copy's ${name} fails its integrity check`,
      );
    }
  }
}
const PHASES: readonly WorkingCopyAdoptionPhase[] = [
  "intent",
  "copied",
  "receipt",
  "source_preserved",
  "adopted",
  "interrupted",
  "failed",
  "collision",
];

function parseIdentity(value: unknown): DirectoryIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger((value as DirectoryIdentity).device) ||
    !Number.isSafeInteger((value as DirectoryIdentity).inode)
  )
    throw new Error("working copy adoption record is invalid");
  return { device: (value as DirectoryIdentity).device, inode: (value as DirectoryIdentity).inode };
}

function parsePair(value: unknown) {
  if (typeof value !== "object" || value === null)
    throw new Error("working copy adoption record is invalid");
  const pair = value as Record<string, unknown>;
  return { session: parseIdentity(pair.session), profile: parseIdentity(pair.profile) };
}

function parseAdoptionRecord(value: unknown): WorkingCopyAdoptionRecord {
  const record = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    record.version !== 1 ||
    typeof record.operationId !== "string" ||
    !UUID.test(record.operationId) ||
    typeof record.browserSessionId !== "string" ||
    !UUID.test(record.browserSessionId) ||
    typeof record.controllerGeneration !== "string" ||
    typeof record.manifestDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.manifestDigest) ||
    typeof record.stagingName !== "string" ||
    record.stagingName !== `${record.browserSessionId}.adopt-${record.operationId}` ||
    record.preservedName !== `${record.browserSessionId}.preserved-${record.operationId}` ||
    !PHASES.includes(record.phase as WorkingCopyAdoptionPhase) ||
    !(record.failureCode === null || typeof record.failureCode === "string") ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  )
    throw new Error("working copy adoption record is invalid");
  return {
    version: 1,
    operationId: record.operationId,
    browserSessionId: record.browserSessionId,
    controllerGeneration: record.controllerGeneration,
    manifestDigest: record.manifestDigest,
    source: parsePair(record.source),
    stagingName: record.stagingName,
    preservedName: record.preservedName as string,
    staging: record.staging === null ? null : parsePair(record.staging),
    phase: record.phase as WorkingCopyAdoptionPhase,
    failureCode: record.failureCode as string | null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
