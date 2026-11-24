import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bearers the API refused for good, remembered across processes.
 *
 * A script that runs `ogtool call` or the native `codemode call` in a loop
 * starts a new process for every call, so an in-process memory never sees the
 * earlier refusal and every iteration reaches the API again. A bearer the API
 * answered with 401, or with 403 `agent_attempt_caller_stale` (its turn
 * attempt ended), can never become valid again: later calls with it fail
 * locally with the same refusal. A renewed bearer has another key and is sent
 * normally.
 *
 * Markers live in one private (0700) per-user directory under the temporary
 * directory and hold only the refusal's status, code and message, under a
 * domain-separated hash of the API base and bearer: never bearer bytes. The
 * native client (agent/crates/opengeni-agent/src/codemode.rs) reads and writes
 * the same markers. Any file-system problem only disables the memory.
 */
export type CodemodeBearerRefusal = {
  status: number;
  code?: string;
  message: string;
};

export type CodemodeRefusedBearerStore = {
  read(key: string): Promise<CodemodeBearerRefusal | null>;
  record(key: string, refusal: CodemodeBearerRefusal): Promise<void>;
};

export const CODEMODE_REFUSED_BEARER_DIRECTORY_PREFIX = "opengeni-codemode-refused-";
/** Delegated bearers live at most 24 hours; an older marker names nothing usable. */
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_MARKER_BYTES = 8 * 1024;
const MAX_MESSAGE_CHARS = 2048;
const MAX_PRUNED_PER_RECORD = 64;
const KEY = /^[0-9a-f]{64}$/u;
const CODE = /^[a-z0-9_]{1,128}$/u;

/** The refusal can never clear for this bearer. */
export function isTerminalCodemodeBearerRefusal(status: number, code: string | null | undefined) {
  return status === 401 || (status === 403 && code === "agent_attempt_caller_stale");
}

/** Marker name for one bearer at one API base (trailing slashes ignored). */
export function codemodeRefusedBearerKey(baseUrl: string, token: string): string {
  return createHash("sha256")
    .update("opengeni:codemode-refused-bearer:v1\0")
    .update(baseUrl.trim().replace(/\/+$/u, ""))
    .update("\0")
    .update(token)
    .digest("hex");
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** The shared per-user marker directory both Codemode command-line clients use. */
export function temporaryCodemodeRefusedBearerStore(
  root: string = tmpdir(),
): CodemodeRefusedBearerStore {
  const uid = currentUid();
  const directory = join(root, `${CODEMODE_REFUSED_BEARER_DIRECTORY_PREFIX}${uid ?? "user"}`);
  const owned = (stats: { uid: number }) => uid === null || stats.uid === uid;
  const privateDirectory = async (create: boolean): Promise<boolean> => {
    if (create) await mkdir(directory, { mode: 0o700 }).catch(() => undefined);
    const stats = await lstat(directory).catch(() => null);
    return Boolean(
      stats?.isDirectory() && owned(stats) && (uid === null || (stats.mode & 0o077) === 0),
    );
  };
  return {
    async read(key) {
      try {
        if (!KEY.test(key) || !(await privateDirectory(false))) return null;
        const path = join(directory, key);
        const stats = await lstat(path);
        if (!stats.isFile() || !owned(stats) || stats.size > MAX_MARKER_BYTES) return null;
        if (Date.now() - stats.mtimeMs >= MARKER_MAX_AGE_MS) {
          await rm(path, { force: true });
          return null;
        }
        return parseRefusal(JSON.parse(await readFile(path, "utf8")));
      } catch {
        return null;
      }
    },
    async record(key, refusal) {
      try {
        if (!KEY.test(key) || !(await privateDirectory(true))) return;
        const marker = parseRefusal(refusal);
        if (!marker) return;
        // Exclusive create never follows or replaces an existing path.
        await writeFile(join(directory, key), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
        await pruneExpiredMarkers(directory, owned);
      } catch {
        // The memory is an optimization; the refusal itself is already thrown.
      }
    },
  };
}

function parseRefusal(input: unknown): CodemodeBearerRefusal | null {
  if (!input || typeof input !== "object") return null;
  const { status, code, message } = input as Record<string, unknown>;
  if (typeof status !== "number" || typeof message !== "string") return null;
  if (code !== undefined && (typeof code !== "string" || !CODE.test(code))) return null;
  if (!isTerminalCodemodeBearerRefusal(status, code as string | undefined)) return null;
  return {
    status,
    ...(code === undefined ? {} : { code: code as string }),
    message: message.slice(0, MAX_MESSAGE_CHARS),
  };
}

async function pruneExpiredMarkers(
  directory: string,
  owned: (stats: { uid: number }) => boolean,
): Promise<void> {
  let removed = 0;
  for (const name of await readdir(directory)) {
    if (!KEY.test(name)) continue;
    const path = join(directory, name);
    const stats = await lstat(path).catch(() => null);
    if (!stats?.isFile() || !owned(stats)) continue;
    if (Date.now() - stats.mtimeMs < MARKER_MAX_AGE_MS) continue;
    await rm(path, { force: true }).catch(() => undefined);
    removed += 1;
    if (removed >= MAX_PRUNED_PER_RECORD) return;
  }
}
