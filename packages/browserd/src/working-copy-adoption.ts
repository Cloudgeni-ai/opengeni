import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
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
 * - the copy is made through held directory descriptors, never following
 *   links, into a fresh staging directory and verified against that digest,
 *   and the original must still hold those bytes once the copy is complete;
 * - an adopt receipt with the staged profile's own identity is appended, and
 *   the staged copy is measured again; a restart makes it live only if it
 *   still holds exactly those bytes;
 * - two ordinary renames follow, each journaled: the original moves to a
 *   preserved name, then the staged copy takes its place. Between them the
 *   live path is briefly empty. No atomic exchange is needed because the
 *   record names every directory by identity, so a restart can tell which
 *   rename happened and finish or report it; see reconcileLocked for the
 *   outcome at each boundary.
 *
 * Only the authority that approved an adoption (controller generation plus
 * token generation and token digests) carries it forward. Inspection and
 * status only observe; an adoption that stopped part way is settled only by
 * retrying it with the same operation id, or by a launch under that same
 * authority. Ending the browser is refused while an adoption is running or
 * unsettled.
 *
 * Excluded from the copy are only the controller's own derived entries at
 * fixed paths (see excludedEntry); the manifest lists them.
 *
 * Adoption and reconciliation for one browser run under one exclusive,
 * kernel-held lock, so a second controller can never act on an adoption that
 * is still running.
 *
 * Nothing here deletes bytes. Retained staging and preserved directories are
 * reported by status and removed only by a separately authorized cleanup.
 */

export type DirectoryIdentity = { device: number; inode: number };

export type WorkingCopyManifest = {
  digest: string;
  entries: number;
  bytes: number;
  /** Controller-owned entries left out of the copy, by path from the root
   * (see excludedEntry). Everything else is in the digest. */
  excluded: string[];
};

export type WorkingCopyAdoptionPhase =
  | "intent"
  | "copied"
  | "receipt"
  | "source_preserved"
  | "adopted"
  | "interrupted"
  | "failed"
  | "collision"
  | "reverting"
  | "reverted";

export type WorkingCopyAdoptionRecord = {
  version: 1;
  operationId: string;
  browserSessionId: string;
  controllerGeneration: string;
  /** Digest of the controller authority (token generation and token
   * digests) the adoption was approved under. Only that same authority may
   * carry it forward; see reconcileLocked. */
  authorityDigest: string;
  manifestDigest: string;
  source: { session: DirectoryIdentity; profile: DirectoryIdentity };
  stagingName: string;
  preservedName: string;
  staging: { session: DirectoryIdentity; profile: DirectoryIdentity } | null;
  /** Digest of the staged copy right after its adopt receipt was appended
   * (the receipt itself changes the copy's journal). Set with phase
   * "receipt"; a restart checks the copy against it before it goes live. */
  receiptDigest: string | null;
  /** The authority that asked to revert this adoption: put the browser's own
   * directory back and keep the staged copy. Set with phase "reverting". */
  revertedBy: AdoptionAuthority | null;
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
  "reverted",
]);

export type WorkingCopyAdoptionFailureReason =
  | "unsupported_platform"
  | "unsupported_entry"
  | "working_copy_changed"
  | "digest_mismatch"
  | "adoption_in_progress"
  | "adoption_collision"
  | "operation_conflict"
  | "adoption_not_found"
  | "adoption_complete"
  | "revert_blocked"
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

/** The controller's own SQLite journals, by path from the session root. */
const BROWSER_JOURNALS = [
  "working-runtime.sqlite",
  "operations.sqlite",
  "state-transfers.sqlite",
  "protected-auth-operations.sqlite",
  "downloads/downloads.sqlite",
];

/** The only entries left out of a working copy, all owned by the controller
 * at fixed paths, never by the browser or the person:
 * - the shared-memory index of each controller journal (a regular file
 *   `<journal>-shm`). SQLite rebuilds it from the journal's WAL on open, and
 *   merely reading a journal rewrites it, so it is derived, not state;
 * - the per-launch launcher directory `chrome-launch` (scripts and FIFOs),
 *   which the controller recreates for every launch and reaps on startup.
 * Any other entry, including a user file or folder whose name merely ends in
 * "-shm" or sits elsewhere, is part of the copy. Excluded paths are reported
 * with the manifest. */
const EXCLUDED_JOURNAL_INDEXES: ReadonlySet<string> = new Set(
  BROWSER_JOURNALS.map((journal) => `${journal}-shm`),
);
const LAUNCHER_DIRECTORY = "chrome-launch";

function excludedEntry(
  relativePath: string,
  metadata: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean },
): boolean {
  if (metadata.isSymbolicLink()) return false;
  if (EXCLUDED_JOURNAL_INDEXES.has(relativePath)) return metadata.isFile();
  return relativePath === LAUNCHER_DIRECTORY && metadata.isDirectory();
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

/** The authority a request acts under: the controller generation and a
 * digest of its token authority. */
export type AdoptionAuthority = { controllerGeneration: string; authorityDigest: string };

export function adoptionAuthority(input: {
  controllerGeneration: string;
  authority: BrowserWorkingRuntimeAuthority;
}): AdoptionAuthority {
  const { tokenGeneration, placementDigest, controlDigest, viewDigest } = input.authority;
  return {
    controllerGeneration: input.controllerGeneration,
    authorityDigest: createHash("sha256")
      .update(
        JSON.stringify([
          "working-copy-authority.v1",
          tokenGeneration,
          placementDigest,
          controlDigest,
          viewDigest,
        ]),
      )
      .digest("hex"),
  };
}

function sameAuthority(record: WorkingCopyAdoptionRecord, current: AdoptionAuthority): boolean {
  return (
    record.controllerGeneration === current.controllerGeneration &&
    record.authorityDigest === current.authorityDigest
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
  | { kind: "file"; relativePath: string; mode: number; atime: Date; mtime: Date }
  | { kind: "symlink"; relativePath: string; target: string };

/** Path of an open descriptor, or of a name inside an open directory, through
 * Linux's per-process descriptor links. Resolving a name this way is the same
 * as openat(2) on the held directory: renaming or replacing any ancestor path
 * cannot redirect it. */
function descriptorPath(handle: FileHandle, name?: string): string {
  return name === undefined ? `/proc/self/fd/${handle.fd}` : `/proc/self/fd/${handle.fd}/${name}`;
}

async function openDirectoryNoFollow(path: string, relativePath: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR" || code === "ENOENT") throw changed(relativePath);
    throw error;
  }
}

function sameStatus(
  left: { dev: number; ino: number; mtimeMs: number; ctimeMs: number; size: number },
  right: { dev: number; ino: number; mtimeMs: number; ctimeMs: number; size: number },
): boolean {
  return (
    sameIdentity(left, right) &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.size === right.size
  );
}

/** Walk one directory tree without following links or leaving it.
 *
 * The root is opened once and every later name is resolved relative to an
 * already open directory, never through a path string, so a concurrent swap
 * of any directory for a link cannot make the walk read outside the tree.
 * Each directory must be unchanged (same identity, times and size) after its
 * entries were visited, and each file must be the inode that was listed and
 * unchanged after it was read. Anything else is refused. Linux only: it
 * relies on the kernel's descriptor links. */
async function walk(
  root: string,
  onEntry: (visit: Visit, content?: AsyncIterable<Buffer>) => Promise<void>,
): Promise<WorkingCopyManifest> {
  if (process.platform !== "linux") {
    throw new WorkingCopyAdoptionError(
      "unsupported_platform",
      "working copy adoption is supported only on Linux controllers",
    );
  }
  const resolvedRoot = await realpath(root);
  if (resolvedRoot !== resolve(root)) {
    throw new WorkingCopyAdoptionError("unsupported_entry", "working copy root is not canonical");
  }
  const lines: ManifestLine[] = [];
  const excluded: string[] = [];
  let bytes = 0;

  async function visitDirectory(handle: FileHandle, relativeDirectory: string): Promise<void> {
    const directoryPath = relativeDirectory || ".";
    const before = await handle.stat();
    if (!before.isDirectory()) throw changed(directoryPath);
    const names = (await readdir(descriptorPath(handle))).sort();
    lines.push([directoryPath, "directory", before.mode & 0o7777, 0, ""]);
    await onEntry({ kind: "directory", relativePath: directoryPath, mode: before.mode & 0o7777 });
    for (const name of names) {
      if (name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
        throw new WorkingCopyAdoptionError(
          "unsupported_entry",
          "working copy entry name is invalid",
        );
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (lines.length >= MAX_ENTRIES) {
        throw new WorkingCopyAdoptionError(
          "unsupported_entry",
          "working copy has too many entries",
        );
      }
      const entryPath = descriptorPath(handle, name);
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(entryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw changed(relativePath);
        throw error;
      }
      if (excludedEntry(relativePath, metadata)) {
        excluded.push(relativePath);
        continue;
      }
      if (metadata.isSymbolicLink()) {
        const target = await readlink(entryPath);
        const again = await lstat(entryPath);
        if (!again.isSymbolicLink() || !sameStatus(metadata, again)) throw changed(relativePath);
        lines.push([relativePath, "symlink", 0, 0, target]);
        await onEntry({ kind: "symlink", relativePath, target });
      } else if (metadata.isDirectory()) {
        const child = await openDirectoryNoFollow(entryPath, relativePath);
        try {
          if (!sameIdentity(metadata, await child.stat())) throw changed(relativePath);
          await visitDirectory(child, relativePath);
        } finally {
          await child.close();
        }
      } else if (metadata.isFile()) {
        let file: FileHandle;
        try {
          file = await open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ELOOP" || code === "ENOENT") throw changed(relativePath);
          throw error;
        }
        try {
          const opened = await file.stat();
          if (!opened.isFile() || !sameIdentity(metadata, opened)) throw changed(relativePath);
          const hash = createHash("sha256");
          let size = 0;
          const chunks = (async function* () {
            const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
            for (;;) {
              const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
              if (bytesRead === 0) return;
              const chunk = buffer.subarray(0, bytesRead);
              hash.update(chunk);
              size += bytesRead;
              yield chunk;
            }
          })();
          let consumed = false;
          await onEntry(
            {
              kind: "file",
              relativePath,
              mode: opened.mode & 0o7777,
              atime: opened.atime,
              mtime: opened.mtime,
            },
            {
              [Symbol.asyncIterator]: () => {
                consumed = true;
                return chunks;
              },
            },
          );
          if (!consumed) for await (const _chunk of chunks);
          const closing = await file.stat();
          if (closing.size !== size || !sameStatus(opened, closing)) throw changed(relativePath);
          bytes += size;
          lines.push([relativePath, "file", opened.mode & 0o7777, size, hash.digest("hex")]);
        } finally {
          await file.close();
        }
      } else {
        throw new WorkingCopyAdoptionError(
          "unsupported_entry",
          `working copy holds an unsupported special file (${relativePath})`,
        );
      }
    }
    // An entry added, removed or renamed here while it was walked changes
    // this directory's times; the listing would no longer be exact.
    if (!sameStatus(before, await handle.stat())) throw changed(directoryPath);
  }

  const rootHandle = await openDirectoryNoFollow(resolvedRoot, ".");
  try {
    if ((await readlink(descriptorPath(rootHandle))) !== resolvedRoot) throw changed(".");
    await visitDirectory(rootHandle, "");
  } finally {
    await rootHandle.close();
  }
  return { digest: manifestDigest(lines), entries: lines.length, bytes, excluded: excluded.sort() };
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
  const manifest = await walk(sourceDirectory, async (visit, content) => {
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
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      for await (const chunk of content!) await handle.write(chunk);
      await handle.chmod(visit.mode);
      await handle.utimes(visit.atime, visit.mtime);
      await handle.sync();
    } finally {
      await handle.close();
    }
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

/** Returned when another holder (an adoption running in this or another
 * controller process) has a browser's adoption lock. */
export const ADOPTION_IN_FLIGHT = "in_flight" as const;

function lockBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    /database is locked/iu.test(String((error as Error).message))
  );
}

/** Run `body` while holding one browser's working directory lock: an
 * exclusive SQLite transaction on a per-browser lock file. Every operation
 * that can move or use the directory holds it for its whole transition: an
 * adoption or revert, an end, retirement or set-aside, and the directory
 * phase of a launch. The kernel holds the underlying lock and releases it if
 * the process dies, so a crash never leaves a stale lock, and two
 * controllers (or two calls in one process) never act on the directory at
 * once. Never waits: a held lock is reported as {@link ADOPTION_IN_FLIGHT}.
 * Not reentrant: a holder must not take it again. */
export async function withWorkingDirectoryLock<T>(
  paths: AdoptionPaths,
  body: () => Promise<T>,
): Promise<T | typeof ADOPTION_IN_FLIGHT> {
  await mkdir(paths.recordsDirectory, { recursive: true, mode: 0o700 });
  const database = new Database(join(paths.recordsDirectory, "lock.sqlite"), {
    create: true,
    readwrite: true,
  });
  try {
    database.exec("PRAGMA busy_timeout = 0");
    try {
      database.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if (lockBusy(error)) return ADOPTION_IN_FLIGHT;
      throw error;
    }
    try {
      return await body();
    } finally {
      database.exec("ROLLBACK");
    }
  } finally {
    database.close();
  }
}

function adoptionRunning(): WorkingCopyAdoptionError {
  return new WorkingCopyAdoptionError(
    "adoption_in_progress",
    "another operation (an adoption, revert, launch or end) is using this browser's working directory right now; retry once it finishes",
  );
}

/** True when the directory holds exactly the bytes of `digest`. A tree that
 * cannot be read as a working copy, or is missing, does not. */
async function holdsDigest(path: string, digest: string | null): Promise<boolean> {
  if (digest === null) return false;
  try {
    return (await workingCopyManifest(path)).digest === digest;
  } catch (error) {
    if (error instanceof WorkingCopyAdoptionError) return false;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Bring one record to a terminal phase where the filesystem proves it, and
 * otherwise to an explicit blocked phase (collision). Idempotent across
 * restarts; the caller holds the working directory lock. It never deletes
 * anything, never classifies an unknown state as absent, and never selects
 * one copy over another silently:
 *
 * - While nothing has moved (the original is still live), any doubt ends the
 *   adoption as failed with the original live and the staged copy kept: the
 *   original no longer is the approved directory and profile with the
 *   approved bytes, the staged copy no longer holds the bytes measured after
 *   its receipt, or the preserved name is taken.
 * - Once the original may have moved aside, every step first proves that the
 *   original is still at its preserved name, as the same directory and
 *   profile, with exactly the approved bytes, and that the staged copy holds
 *   its post-receipt bytes. Any doubt is a collision that keeps every
 *   directory and blocks launches until the adoption is reverted
 *   ({@link revertWorkingCopyAdoption}).
 *
 * Only the authority that approved the adoption carries it forward. Another
 * authority changes nothing: the record is returned as it was, because a
 * different request alone does not prove the approving authority is gone.
 * A record being reverted is continued only by a revert. `stagingVerified`
 * is set only by the adoption that just measured the staged copy under the
 * same lock. */
async function reconcileLocked(
  paths: AdoptionPaths,
  record: WorkingCopyAdoptionRecord,
  authority: AdoptionAuthority,
  stagingVerified = false,
  afterPhase?: (boundary: AdoptionBoundary) => Promise<void>,
): Promise<WorkingCopyAdoptionRecord> {
  const staging = join(paths.sessionsDirectory, record.stagingName);
  const preserved = join(paths.sessionsDirectory, record.preservedName);
  let state = record;
  let verified = stagingVerified;
  const copyIntact = async (path: string) =>
    verified || (verified = await holdsDigest(path, state.receiptDigest));
  const end = async (
    phase: "failed" | "collision",
    failureCode: string,
  ): Promise<WorkingCopyAdoptionRecord> => {
    const ended = await advance(paths, state, phase, { failureCode });
    if (phase === "failed") await releaseActiveAdoption(paths, ended.operationId);
    return ended;
  };
  if (state.phase === "intent" || state.phase === "copied") {
    // No receipt was recorded: the decision to adopt never became durable.
    // The original is still live if its identity is; any staging copy is kept.
    const live = await identityOrNull(paths.live);
    state = equalIdentity(live, state.source.session)
      ? await advance(paths, state, "interrupted", { failureCode: "adoption_interrupted" })
      : await advance(paths, state, "collision", { failureCode: "live_directory_changed" });
  }
  if (
    (state.phase === "receipt" || state.phase === "source_preserved") &&
    !sameAuthority(state, authority)
  )
    return state;
  /** Why the original is not provably intact at its preserved name, or null
   * when it is the approved directory and profile with the approved bytes. */
  const originalProblem = async (): Promise<string | null> => {
    const identity = await identityOrNull(preserved);
    if (identity === null) return "original_missing";
    if (
      !equalIdentity(identity, state.source.session) ||
      !equalIdentity(await identityOrNull(join(preserved, "profile")), state.source.profile) ||
      !(await holdsDigest(preserved, state.manifestDigest))
    )
      return "original_changed";
    return null;
  };
  const stagingIntact = async (path: string) =>
    state.staging !== null &&
    equalIdentity(await identityOrNull(path), state.staging.session) &&
    (await copyIntact(path));
  if (state.phase === "receipt") {
    const live = await identityOrNull(paths.live);
    const stagedLive = state.staging !== null && equalIdentity(live, state.staging.session);
    if (equalIdentity(live, state.source.session)) {
      // Nothing has moved yet.
      if (
        !equalIdentity(await identityOrNull(join(paths.live, "profile")), state.source.profile) ||
        !(await holdsDigest(paths.live, state.manifestDigest))
      )
        return await end("failed", "working_copy_changed");
      if (!(await stagingIntact(staging))) return await end("failed", "staged_copy_changed");
      if (await identityOrNull(preserved)) return await end("failed", "preserved_name_taken");
      await rename(paths.live, preserved);
      await syncDirectory(paths.sessionsDirectory);
      state = await advance(paths, state, "source_preserved");
      await afterPhase?.("source_preserved");
    } else if (live === null || stagedLive) {
      // The original moved aside, and perhaps the copy went live, before
      // either step was journaled.
      const problem = await originalProblem();
      if (problem) return await end("collision", problem);
      if (!(await stagingIntact(stagedLive ? paths.live : staging)))
        return await end("collision", "staged_copy_changed");
      state = await advance(paths, state, "source_preserved");
    } else {
      return await end("collision", "live_directory_changed");
    }
  }
  if (state.phase === "source_preserved") {
    const problem = await originalProblem();
    if (problem) return await end("collision", problem);
    const live = await identityOrNull(paths.live);
    if (state.staging && equalIdentity(live, state.staging.session)) {
      if (!(await copyIntact(paths.live))) return await end("collision", "staged_copy_changed");
      state = await advance(paths, state, "adopted");
    } else if (live === null && (await stagingIntact(staging))) {
      await rename(staging, paths.live);
      await syncDirectory(paths.sessionsDirectory);
      await afterPhase?.("copy_live");
      state = await advance(paths, state, "adopted");
    } else if (live === null) {
      return await end("collision", "staged_copy_changed");
    } else {
      return await end("collision", "live_directory_changed");
    }
  }
  if (TERMINAL_ADOPTION_PHASES.has(state.phase)) {
    await releaseActiveAdoption(paths, state.operationId);
  }
  return state;
}

/** Never equal to a recorded authority: reconciling under it only settles
 * what the filesystem proves regardless of authority (an adoption that
 * stopped before its receipt). */
const NO_AUTHORITY: AdoptionAuthority = { controllerGeneration: "", authorityDigest: "" };

/** The adoption that still owns a browser's directory, decided by a caller
 * that holds its working directory lock. A claim without a record is
 * released: the claim precedes the record within one locked adoption and
 * the record precedes every side effect, so holding the lock proves that
 * adoption stopped before changing anything. A recorded adoption is
 * reconciled under `current` (null for none), which carries it forward only
 * when it is the approving authority. Returns null when nothing blocks. */
export async function activeAdoptionLocked(
  paths: AdoptionPaths,
  current: AdoptionAuthority | null,
): Promise<WorkingCopyAdoptionRecord | null> {
  const operationId = await readActiveAdoption(paths);
  if (!operationId) return null;
  const record = await readAdoptionRecord(paths, operationId);
  if (!record) {
    await releaseActiveAdoption(paths, operationId);
    return null;
  }
  const settled = await reconcileLocked(paths, record, current ?? NO_AUTHORITY);
  return TERMINAL_ADOPTION_PHASES.has(settled.phase) ? null : settled;
}

/** An active adoption whose claim has no record yet: its adoption either is
 * starting or stopped before writing anything. The next holder of the lock
 * releases it. */
export const ADOPTION_UNRECORDED = "unrecorded" as const;

/** {@link activeAdoptionLocked} under the working directory lock, or
 * {@link ADOPTION_IN_FLIGHT} while another operation holds it. */
export async function settleActiveAdoption(
  paths: AdoptionPaths,
  current: AdoptionAuthority | null,
): Promise<WorkingCopyAdoptionRecord | typeof ADOPTION_IN_FLIGHT | null> {
  return await withWorkingDirectoryLock(
    paths,
    async () => await activeAdoptionLocked(paths, current),
  );
}

/** What blocks launches for a browser, read without changing anything and
 * without the lock (inspection). An active claim whose directory lock is
 * held is reported in flight. */
export async function observeActiveAdoption(
  paths: AdoptionPaths,
): Promise<
  WorkingCopyAdoptionRecord | typeof ADOPTION_IN_FLIGHT | typeof ADOPTION_UNRECORDED | null
> {
  const operationId = await readActiveAdoption(paths);
  if (!operationId) return null;
  if (await adoptionLocked(paths)) return ADOPTION_IN_FLIGHT;
  const record = await readAdoptionRecord(paths, operationId);
  if (!record) return ADOPTION_UNRECORDED;
  return TERMINAL_ADOPTION_PHASES.has(record.phase) ? null : record;
}

/** True while any operation in any process holds this browser's working
 * directory lock. */
export async function adoptionLocked(paths: AdoptionPaths): Promise<boolean> {
  try {
    await lstat(paths.recordsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return (await withWorkingDirectoryLock(paths, async () => false)) === ADOPTION_IN_FLIGHT;
}

/** A durable phase, or a step between two durable phases that tests stop at
 * as a crash would ("copy_live": the staged copy was renamed live but the
 * adoption was not yet recorded as adopted; "copy_set_aside": a revert moved
 * the staged copy back to its staging name but has not yet put the original
 * back). */
export type AdoptionBoundary = WorkingCopyAdoptionPhase | "copy_live" | "copy_set_aside";

export type AdoptWorkingCopyInput = {
  operationId: string;
  browserSessionId: string;
  manifestDigest: string;
  /** The authority this request acts under; it is recorded, and only the
   * same authority can carry the adoption forward. */
  authority: AdoptionAuthority;
  /** For a new adoption: checks made while the lock is held and before
   * anything is written (the browser is stopped and its copy adoptable).
   * Throws to refuse. */
  beforeIntent?: () => Promise<void>;
  /** Called with the verified staging directory before it can become live.
   * Appends the adopt receipt; must be idempotent for the same operation. */
  appendReceipt(stagingDirectory: string): Promise<void>;
  /** Fault injection for tests: called after each durable boundary. */
  afterPhase?: (boundary: AdoptionBoundary) => Promise<void>;
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
  const result = await withWorkingDirectoryLock(paths, async () => await adoptLocked(paths, input));
  if (result === ADOPTION_IN_FLIGHT) throw adoptionRunning();
  return result;
}

async function adoptLocked(
  paths: AdoptionPaths,
  input: AdoptWorkingCopyInput,
): Promise<WorkingCopyAdoptionRecord> {
  const existing = await readAdoptionRecord(paths, input.operationId);
  if (existing) {
    if (
      existing.browserSessionId !== input.browserSessionId ||
      existing.manifestDigest !== input.manifestDigest
    ) {
      throw new WorkingCopyAdoptionError(
        "operation_conflict",
        "adoption operation id is bound to another request",
      );
    }
    if (existing.phase === "reverting") {
      throw new WorkingCopyAdoptionError(
        "adoption_unresolved",
        "this adoption is being reverted and can no longer be completed; retry the revert to finish it",
      );
    }
    // A retry never repeats a side effect; it only reconciles what exists,
    // and only the approving authority carries it forward.
    const settled = await reconcileLocked(
      paths,
      existing,
      input.authority,
      false,
      input.afterPhase,
    );
    if (
      (settled.phase === "receipt" || settled.phase === "source_preserved") &&
      !sameAuthority(settled, input.authority)
    ) {
      throw new WorkingCopyAdoptionError(
        "authority_changed",
        "this adoption was approved under another controller authority, and only that authority can finish it; nothing was changed. Revert it to put the browser's own directory back, then adopt again if the copy should still be used",
      );
    }
    return settled;
  }
  const blocking = await activeAdoptionLocked(paths, input.authority);
  if (blocking) {
    throw new WorkingCopyAdoptionError(
      blocking.phase === "collision" ? "adoption_collision" : "adoption_in_progress",
      "another working copy adoption for this browser is unresolved; finish or revert it first",
    );
  }
  await input.beforeIntent?.();
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
    controllerGeneration: input.authority.controllerGeneration,
    authorityDigest: input.authority.authorityDigest,
    manifestDigest: input.manifestDigest,
    source: { session: sessionIdentity, profile: profileIdentity },
    stagingName: `${input.browserSessionId}.adopt-${input.operationId}`,
    preservedName: `${input.browserSessionId}.preserved-${input.operationId}`,
    staging: null,
    receiptDigest: null,
    revertedBy: null,
    phase: "intent",
    failureCode: null,
    createdAt: now,
    updatedAt: now,
  });
  await input.afterPhase?.("intent");
  const staging = join(paths.sessionsDirectory, record.stagingName);
  const refuse = async (failureCode: string, error: WorkingCopyAdoptionError): Promise<never> => {
    // A definite refusal: the original was only read and any partial
    // staging copy is kept for inspection.
    record = await advance(paths, record, "failed", { failureCode });
    await releaseActiveAdoption(paths, input.operationId);
    throw error;
  };
  let read: WorkingCopyManifest;
  try {
    read = await copyWorkingCopy(paths.live, staging);
  } catch (error) {
    if (!(error instanceof WorkingCopyAdoptionError)) throw error;
    return await refuse(error.reason, error);
  }
  if (read.digest !== input.manifestDigest) {
    return await refuse(
      "digest_mismatch",
      new WorkingCopyAdoptionError(
        "digest_mismatch",
        "the working copy no longer matches the approved manifest; nothing was adopted",
      ),
    );
  }
  if (!(await holdsDigest(staging, input.manifestDigest))) {
    return await refuse(
      "copy_verification_failed",
      new WorkingCopyAdoptionError(
        "digest_mismatch",
        "the staged copy does not match the approved manifest; nothing was adopted",
      ),
    );
  }
  // Every file was checked while it was read, but one read early could have
  // changed before the copy finished. The original must still hold exactly
  // the approved bytes once the copy is complete.
  if (!(await holdsDigest(paths.live, input.manifestDigest))) {
    return await refuse(
      "working_copy_changed",
      new WorkingCopyAdoptionError(
        "working_copy_changed",
        "the working copy changed while it was copied; nothing was adopted",
      ),
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
  record = await advance(paths, record, "receipt", {
    receiptDigest: (await workingCopyManifest(staging)).digest,
  });
  await input.afterPhase?.("receipt");
  return await reconcileLocked(paths, record, input.authority, true, input.afterPhase);
}

export type RevertWorkingCopyAdoptionInput = {
  operationId: string;
  /** The current authority for the browser. Any current authority may
   * revert: a revert only puts the browser's own directory back and keeps
   * the staged copy, so it never selects new state for the browser. */
  authority: AdoptionAuthority;
  /** Fault injection for tests: called after each durable boundary. */
  afterPhase?: (boundary: AdoptionBoundary) => Promise<void>;
};

/** Revert an adoption that has not finished: put the browser's own directory
 * back at its live path and keep the staged copy at its staging name. It is
 * the supported way out of a collision, of an adoption whose approving
 * authority is gone, and of one nobody wants finished.
 *
 * A revert is journaled ("reverting") before any rename, and each retry
 * derives the remaining steps from the directories' identities, so a crash
 * at any point is finished by retrying it; an adoption retry never resumes a
 * reverting record. It refuses, changing nothing, when the original is
 * neither live nor at its preserved name, when an unknown directory holds
 * the live path, or when the staging name is taken. It never deletes. A
 * finished adoption cannot be reverted, and one that never moved anything
 * is reported as it is. */
export async function revertWorkingCopyAdoption(
  paths: AdoptionPaths,
  input: RevertWorkingCopyAdoptionInput,
): Promise<WorkingCopyAdoptionRecord> {
  if (process.platform !== "linux") {
    throw new WorkingCopyAdoptionError(
      "unsupported_platform",
      "working copy adoption is supported only on Linux controllers",
    );
  }
  const result = await withWorkingDirectoryLock(
    paths,
    async () => await revertLocked(paths, input),
  );
  if (result === ADOPTION_IN_FLIGHT) throw adoptionRunning();
  return result;
}

function revertBlocked(message: string): WorkingCopyAdoptionError {
  return new WorkingCopyAdoptionError(
    "revert_blocked",
    `${message}; nothing was changed and every directory is kept`,
  );
}

async function revertLocked(
  paths: AdoptionPaths,
  input: RevertWorkingCopyAdoptionInput,
): Promise<WorkingCopyAdoptionRecord> {
  let record = await readAdoptionRecord(paths, input.operationId);
  if (!record) {
    throw new WorkingCopyAdoptionError(
      "adoption_not_found",
      "this controller has no record of that adoption, which proves it changed nothing here",
    );
  }
  if (record.phase === "intent" || record.phase === "copied") {
    // Never got as far as a receipt: settle it as the filesystem proves.
    record = await reconcileLocked(paths, record, input.authority);
  }
  if (record.phase === "adopted") {
    throw new WorkingCopyAdoptionError(
      "adoption_complete",
      "this adoption finished and the browser now uses the adopted copy, so it cannot be reverted; nothing was changed",
    );
  }
  // failed, interrupted, reverted: the browser's own directory is live.
  if (TERMINAL_ADOPTION_PHASES.has(record.phase)) return record;
  const staging = join(paths.sessionsDirectory, record.stagingName);
  const preserved = join(paths.sessionsDirectory, record.preservedName);
  const live = await identityOrNull(paths.live);
  const originalLive = equalIdentity(live, record.source.session);
  const copyLive = record.staging !== null && equalIdentity(live, record.staging.session);
  if (!originalLive) {
    if (!equalIdentity(await identityOrNull(preserved), record.source.session))
      throw revertBlocked(
        `the browser's own directory is neither at its live path nor at ${record.preservedName}, so it cannot be put back. Put it back at ${record.preservedName}, then revert again`,
      );
    if (live !== null && !copyLive)
      throw revertBlocked(
        "an unknown directory holds the browser's live path, so the browser's own directory cannot be put back. A person must inspect the machine",
      );
    if (copyLive && (await identityOrNull(staging)) !== null)
      throw revertBlocked(
        `the staging name ${record.stagingName} is taken, so the adopted copy cannot be moved aside. A person must inspect the machine`,
      );
  }
  if (record.phase !== "reverting") {
    record = await advance(paths, record, "reverting", { revertedBy: input.authority });
    await input.afterPhase?.("reverting");
  }
  if (copyLive) {
    await rename(paths.live, staging);
    await syncDirectory(paths.sessionsDirectory);
    await input.afterPhase?.("copy_set_aside");
  }
  if (!originalLive) {
    await rename(preserved, paths.live);
    await syncDirectory(paths.sessionsDirectory);
  }
  record = await advance(paths, record, "reverted");
  await releaseActiveAdoption(paths, record.operationId);
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
    "the browser is running, starting or being ended on this controller; only a stopped working copy can be adopted",
  working_copy_invalid: "the working directory is incomplete or is not a plain directory",
  receipt_not_adoptable:
    "the working copy has no completed launch record with a browser process, so it cannot be adopted",
  authority_changed:
    "the working copy was launched under another controller authority, so it cannot be adopted here",
  process_state_unknown: "a process may still be using the working copy, so it is left untouched",
  adoption_not_needed:
    "the working copy is still the directory it was launched in; it can be continued without adoption",
  adoption_unresolved:
    "a working copy adoption for this browser is unresolved; retry that same adoption under the authority that approved it to settle it, or revert it",
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
  "reverting",
  "reverted",
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

function parseAuthority(value: unknown): AdoptionAuthority | null {
  if (value === undefined || value === null) return null;
  const authority = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    typeof authority.controllerGeneration !== "string" ||
    typeof authority.authorityDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(authority.authorityDigest)
  )
    throw new Error("working copy adoption record is invalid");
  return {
    controllerGeneration: authority.controllerGeneration,
    authorityDigest: authority.authorityDigest,
  };
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
    typeof record.authorityDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.authorityDigest) ||
    typeof record.manifestDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.manifestDigest) ||
    typeof record.stagingName !== "string" ||
    record.stagingName !== `${record.browserSessionId}.adopt-${record.operationId}` ||
    record.preservedName !== `${record.browserSessionId}.preserved-${record.operationId}` ||
    !PHASES.includes(record.phase as WorkingCopyAdoptionPhase) ||
    !(
      record.receiptDigest === null ||
      (typeof record.receiptDigest === "string" && /^[0-9a-f]{64}$/u.test(record.receiptDigest))
    ) ||
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
    authorityDigest: record.authorityDigest,
    manifestDigest: record.manifestDigest,
    source: parsePair(record.source),
    stagingName: record.stagingName,
    preservedName: record.preservedName as string,
    staging: record.staging === null ? null : parsePair(record.staging),
    receiptDigest: record.receiptDigest as string | null,
    revertedBy: parseAuthority(record.revertedBy),
    phase: record.phase as WorkingCopyAdoptionPhase,
    failureCode: record.failureCode as string | null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
