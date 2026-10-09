import { rmSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Private host-archive spool directories are process-owned. In-process callers
 * dispose them on every success/failure path, but a worker that stops while a
 * capture, upload or restore is in flight (rolling deploy, SIGTERM drain, crash)
 * cannot run that cleanup, and each spool holds a whole workspace archive.
 *
 * The directory name therefore records its owner process identity: the PID
 * namespace, PID and kernel start time. A later process may remove a directory
 * only when that exact owner is provably gone: same PID namespace (PIDs from
 * another namespace are not comparable), and that PID either no longer exists or
 * now belongs to a different process start. Live owners, including concurrent
 * workers sharing one TMPDIR, are never touched. Unmarked legacy names are
 * never swept because their owner cannot be proven gone.
 */
export const HOST_ARCHIVE_TEMPORARY_PREFIX = "opengeni-host-archive-";

const OWNED_NAME = /^opengeni-host-archive-o(\d+)\.(\d+)\.(\d+)-[A-Za-z0-9]{6}$/;

type ProcessOwner = { namespace: string; pid: number; startTime: string };

async function processStartTime(pid: number | "self"): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name is parenthesized and may contain spaces or ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Field 22 (starttime) is the 20th field after "pid (comm)".
    const startTime = fields[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

async function pidNamespace(): Promise<string | null> {
  try {
    return /^pid:\[(\d+)\]$/.exec(await readlink("/proc/self/ns/pid"))?.[1] ?? null;
  } catch {
    return null;
  }
}

let ownerIdentity: Promise<ProcessOwner | null> | undefined;
function currentOwner(): Promise<ProcessOwner | null> {
  return (ownerIdentity ??= (async () => {
    const [namespace, startTime] = await Promise.all([pidNamespace(), processStartTime("self")]);
    return namespace && startTime ? { namespace, pid: process.pid, startTime } : null;
  })());
}

/** Spool directories this process still owns; removed on normal process exit. */
const liveDirectories = new Set<string>();
let exitHookInstalled = false;
function removeLiveDirectoriesOnExit() {
  for (const directory of liveDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Exit cleanup is best effort; the next process's sweep reclaims it.
    }
  }
  liveDirectories.clear();
}

/** Create a private owner-marked spool directory directly under `base`. */
export async function createHostArchiveTemporaryDirectory(base: string): Promise<string> {
  const owner = await currentOwner();
  const prefix = owner
    ? `${HOST_ARCHIVE_TEMPORARY_PREFIX}o${owner.namespace}.${owner.pid}.${owner.startTime}-`
    : HOST_ARCHIVE_TEMPORARY_PREFIX;
  const directory = await mkdtemp(join(base, prefix));
  liveDirectories.add(directory);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", removeLiveDirectoriesOnExit);
  }
  return directory;
}

/** Remove a spool directory created by this process. Idempotent. */
export async function removeHostArchiveTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  liveDirectories.delete(directory);
}

async function ownerIsGone(
  current: ProcessOwner,
  owner: { namespace: string; pid: number; startTime: string },
): Promise<boolean> {
  if (owner.namespace !== current.namespace) return false;
  if (owner.pid === current.pid) return owner.startTime !== current.startTime;
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  const liveStartTime = await processStartTime(owner.pid);
  return liveStartTime !== owner.startTime;
}

/**
 * Remove spool directories left behind by processes that no longer exist.
 * Returns the removed paths. Never throws: cleanup must not block startup or a
 * capture.
 */
export async function sweepOrphanedHostArchiveTemporaryDirectories(
  bases: readonly string[] = hostArchiveTemporaryBases(),
): Promise<string[]> {
  const removed: string[] = [];
  const current = await currentOwner();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!current || uid === undefined) return removed;
  const seen = new Set<string>();
  for (const candidate of bases) {
    const base = await realpath(candidate).catch(() => null);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    const names = await readdir(base).catch(() => [] as string[]);
    for (const name of names) {
      const match = OWNED_NAME.exec(name);
      if (!match) continue;
      const owner = { namespace: match[1]!, pid: Number(match[2]), startTime: match[3]! };
      try {
        if (!(await ownerIsGone(current, owner))) continue;
        const path = join(base, name);
        const stats = await lstat(path);
        if (!stats.isDirectory() || stats.uid !== uid) continue;
        await rm(path, { recursive: true, force: true });
        removed.push(path);
      } catch {
        // Another sweeper removed it, or it is not ours to inspect.
      }
    }
  }
  return removed;
}

/** The disk temporary locations `privateTemporaryDirectory` may choose. */
export function hostArchiveTemporaryBases(): string[] {
  return [tmpdir(), "/var/tmp", "/tmp"];
}

let processSweep: Promise<string[]> | undefined;
/** Sweep once per process: at worker start and before the first spool. */
export function sweepOrphanedHostArchiveTemporaryDirectoriesOnce(): Promise<string[]> {
  return (processSweep ??= sweepOrphanedHostArchiveTemporaryDirectories());
}
