import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  SandboxArchiveError,
  resolveSandboxArchiveLimits,
  type SandboxArchiveLimits,
} from "@openai/agents/sandbox";
import type { WorkspaceArchiveSpool } from "./archive-spool";
import { ownedArchiveSpool, privateArchiveSpoolDirectory } from "./host-archive-spool";
import { removeHostArchiveTemporaryDirectory } from "./host-archive-temporary";

/**
 * A remote session that can move its portable workspace tar as a byte stream.
 * Both directions run one process in the sandbox (`tar -x` reading stdin,
 * `tar -c` writing stdout), so neither the worker nor the sandbox ever holds
 * the whole archive: the worker passes it through in small chunks between a
 * private disk spool and the provider's process streams.
 */
export type WorkspaceTarStreamSession = {
  /**
   * Replaces the workspace root's contents with the tar read from `chunks`.
   * Resolves only after the whole stream was consumed and the extractor
   * exited successfully; a rejected iterator aborts the extraction. A chunk
   * is valid only until the next one is requested (the reader reuses one
   * buffer), so an implementation that keeps bytes longer copies them.
   */
  hydrateWorkspaceTarStream: (chunks: AsyncIterable<Uint8Array>) => Promise<void>;
  /**
   * Streams a tar of the workspace root, with the same exclusions as the
   * session's own tar persistence, awaiting `sink` for every chunk.
   */
  persistWorkspaceTarStream: (sink: (chunk: Uint8Array) => Promise<void>) => Promise<void>;
};

export function workspaceTarStreamSession(session: unknown): WorkspaceTarStreamSession | null {
  if (!session || typeof session !== "object") return null;
  const candidate = session as Partial<WorkspaceTarStreamSession>;
  return typeof candidate.hydrateWorkspaceTarStream === "function" &&
    typeof candidate.persistWorkspaceTarStream === "function"
    ? (candidate as WorkspaceTarStreamSession)
    : null;
}

/** The SDK's `workspaceTarProtectedPaths`: the manifest's ephemeral paths,
 * which a hydrated archive must not write. An empty path protects the whole
 * root, so it is kept, unlike the archive's exclusions. */
export function workspaceTarProtectedPaths(session: unknown): string[] {
  const manifest = (
    session as { state?: { manifest?: { ephemeralPersistencePaths?: () => Set<unknown> } } }
  )?.state?.manifest;
  return [...(manifest?.ephemeralPersistencePaths?.() ?? [])]
    .filter((path): path is string => typeof path === "string")
    .sort((left, right) => left.localeCompare(right));
}

const TAR_BLOCK_SIZE = 512;
/** Read size for a spool streamed into a sandbox; one reused buffer. */
const SPOOL_READ_BYTES = 1024 * 1024;

export type WorkspaceTarStreamValidatorOptions = {
  /** The SDK's hydration passes `false`; its capture check leaves it unset. */
  allowSymlinks?: boolean;
  /** Workspace-relative paths the archive must not write (ephemeral paths). */
  rejectRelPaths?: readonly string[];
  /** Raw session limits, resolved exactly as the SDK does: absent means none. */
  archiveLimits?: SandboxArchiveLimits | null;
};

type TarMember = { rawName: string; path: string; type: "file" | "directory" | "symlink" };

/**
 * The Agents SDK's `validateWorkspaceTarArchive` (agents-extensions 0.14.3,
 * `sandbox/shared/archive`), applied to a stream instead of a whole buffer.
 * It keeps the same member rules, error messages and archive limits, and
 * holds only one header and the current PAX/long-name payload.
 *
 * Every member header is checked inside `push` before that chunk may be
 * forwarded to an extractor. The SDK's final pass (no member below a file or
 * symlink) is applied as each member arrives, in both directions, so a later
 * member can never make an earlier, already-extracted one unsafe.
 */
export class WorkspaceTarStreamValidator {
  private readonly limits: ReturnType<typeof resolveSandboxArchiveLimits>;
  private readonly rejectedPaths: string[];
  private readonly header = new Uint8Array(TAR_BLOCK_SIZE);
  private headerFill = 0;
  private state: "header" | "payload" | "padding" | "done" = "header";
  private payloadRemaining = 0;
  private paddingRemaining = 0;
  /** A PAX or GNU long-name payload, gathered as it arrives rather than
   * allocated up front from its declared size. */
  private capture: { type: "x" | "g" | "L"; name: string; parts: Uint8Array[] } | null = null;
  private pendingLongName: string | undefined;
  private pendingPax: Record<string, string> | undefined;
  private readonly typesByPath = new Map<string, TarMember["type"]>();
  /** Every parent path seen, with the first member below it. */
  private readonly parentPaths = new Map<string, string>();
  private memberCount = 0;
  private extractedBytes = 0;
  private inputBytes = 0;
  private failure: unknown;

  constructor(private readonly options: WorkspaceTarStreamValidatorOptions = {}) {
    this.limits = resolveSandboxArchiveLimits(options.archiveLimits ?? undefined);
    this.rejectedPaths = [...(options.rejectRelPaths ?? [])].map(normalizeTarRelPath);
  }

  /** The SDK checks the archive's byte length before parsing it. */
  checkInputBytes(totalBytes: number): void {
    this.guard(() => checkArchiveInputBytes(totalBytes, this.limits));
  }

  push(chunk: Uint8Array): void {
    this.guard(() => {
      this.inputBytes += chunk.byteLength;
      checkArchiveInputBytes(this.inputBytes, this.limits);
      let offset = 0;
      while (offset < chunk.byteLength && this.state !== "done") {
        if (this.state === "header") {
          const take = Math.min(TAR_BLOCK_SIZE - this.headerFill, chunk.byteLength - offset);
          this.header.set(chunk.subarray(offset, offset + take), this.headerFill);
          this.headerFill += take;
          offset += take;
          if (this.headerFill === TAR_BLOCK_SIZE) {
            this.headerFill = 0;
            this.onHeader();
          }
        } else if (this.state === "payload") {
          const take = Math.min(this.payloadRemaining, chunk.byteLength - offset);
          this.capture?.parts.push(chunk.slice(offset, offset + take));
          this.payloadRemaining -= take;
          offset += take;
          if (this.payloadRemaining === 0) this.onPayloadEnd();
        } else {
          const take = Math.min(this.paddingRemaining, chunk.byteLength - offset);
          this.paddingRemaining -= take;
          offset += take;
          if (this.paddingRemaining === 0) this.state = "header";
        }
      }
    });
  }

  /** Rejects an archive that ends inside a header or a member's payload. */
  finish(): void {
    this.guard(() => {
      if (this.state === "header" && this.headerFill > 0) {
        throw tarError("<tar>", "truncated header");
      }
      if (this.state === "payload") throw tarError("<tar>", "truncated member payload");
    });
  }

  private guard(step: () => void): void {
    if (this.failure !== undefined) throw this.failure;
    try {
      step();
    } catch (error) {
      this.failure =
        error instanceof SandboxArchiveError
          ? error
          : new SandboxArchiveError("Invalid workspace tar archive.", {
              cause: error instanceof Error ? error.message : String(error),
            });
      throw this.failure;
    }
  }

  private onHeader(): void {
    const header = this.header;
    if (header.every((byte) => byte === 0)) {
      this.state = "done";
      return;
    }
    const rawType = header[156] === 0 ? "" : String.fromCharCode(header[156]!);
    const size = parseTarOctal(header, 124, 12);
    const padding = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE - size;
    if (rawType === "x" || rawType === "g" || rawType === "L") {
      this.capture = {
        type: rawType,
        name: readTarString(header, 0, 100),
        parts: [],
      };
    } else {
      this.capture = null;
      this.onMember(rawType, size);
    }
    this.payloadRemaining = size;
    this.paddingRemaining = padding;
    if (size > 0) this.state = "payload";
    else this.onPayloadEnd();
  }

  private onPayloadEnd(): void {
    const capture = this.capture;
    this.capture = null;
    const payload = capture ? Buffer.concat(capture.parts) : null;
    if (payload && (capture?.type === "x" || capture?.type === "g")) {
      const pax = parsePaxPayload(payload);
      if (pax.size !== undefined) throw tarError(capture.name, "PAX size override not allowed");
      if (pax["GNU.sparse.name"] !== undefined) {
        throw tarError(capture.name, "PAX GNU.sparse.name override not allowed");
      }
      if (capture.type === "x") {
        this.pendingPax = pax;
      } else {
        for (const key of ["path", "linkpath"]) {
          if (pax[key] !== undefined) {
            throw tarError(capture.name, `global PAX ${key} override not allowed`);
          }
        }
      }
    } else if (payload && capture?.type === "L") {
      this.pendingLongName = trimTarString(decodeBytes(payload));
    }
    this.state = this.paddingRemaining > 0 ? "padding" : "header";
  }

  private onMember(rawType: string, size: number): void {
    const header = this.header;
    const name =
      this.pendingPax?.path ??
      this.pendingLongName ??
      joinTarName(readTarString(header, 0, 100), readTarString(header, 345, 155));
    const linkName = this.pendingPax?.linkpath ?? readTarString(header, 157, 100);
    this.pendingPax = undefined;
    this.pendingLongName = undefined;
    const mode =
      this.rejectedPaths.length > 0 && rawType === "5" ? parseTarOctal(header, 100, 8) : undefined;
    if (rawType === "5" && safeTarMemberRelPath(name) === null) {
      assertTarMemberDoesNotOverlapRejectedPath(
        { rawName: name, path: "", type: "directory" },
        this.rejectedPaths,
        mode,
      );
    }
    const member = validateTarMember(name, rawType, this.options, linkName);
    if (!member) return;
    assertTarMemberDoesNotOverlapRejectedPath(member, this.rejectedPaths, mode);
    this.memberCount += 1;
    checkLimit(
      this.limits?.maxMembers,
      this.memberCount,
      "archive member count exceeds limit",
      name,
    );
    if (member.type === "file") {
      this.extractedBytes += size;
      checkLimit(
        this.limits?.maxExtractedBytes,
        this.extractedBytes,
        "archive extracted size exceeds limit",
        name,
      );
    }
    const previous = this.typesByPath.get(member.path);
    if (previous && !(previous === "directory" && member.type === "directory")) {
      throw tarError(name, `duplicate archive path: ${member.path}`);
    }
    // The SDK checks, after reading everything, that no member descends
    // through a non-directory or a symlink. Applied per member: this member's
    // parents must not be earlier non-directories ...
    for (const parent of parentPaths(member.path)) {
      const parentType = this.typesByPath.get(parent);
      if (parentType && parentType !== "directory") {
        throw tarError(name, `archive path descends through non-directory: ${parent}`);
      }
      if (!this.parentPaths.has(parent)) this.parentPaths.set(parent, name);
    }
    // ... and a non-directory must not be the parent of an earlier member,
    // which is named, as the SDK names the member that descends.
    const below = member.type === "directory" ? undefined : this.parentPaths.get(member.path);
    if (below !== undefined) {
      throw tarError(below, `archive path descends through non-directory: ${member.path}`);
    }
    this.typesByPath.set(member.path, member.type);
  }
}

function validateTarMember(
  name: string,
  typeFlag: string,
  options: WorkspaceTarStreamValidatorOptions,
  _linkName: string,
): TarMember | null {
  const relPath = safeTarMemberRelPath(name);
  if (relPath === null) {
    if (typeFlag === "5") return null;
    if (typeFlag === "2") throw tarError(name, "archive root symlink");
    if (typeFlag === "1") throw tarError(name, "archive root hardlink");
    throw tarError(name, "archive root member must be directory");
  }
  if (typeFlag === "1") throw tarError(name, "hardlink member not allowed");
  if (typeFlag === "2") {
    if (options.allowSymlinks === false) {
      throw tarError(name, `symlink member not allowed: ${relPath}`);
    }
    // The SDK checks symlink targets only when external targets are
    // disallowed, which neither of its workspace tar callers requests.
    return { rawName: name, path: relPath, type: "symlink" };
  }
  if (typeFlag === "5") return { rawName: name, path: relPath, type: "directory" };
  if (typeFlag === "" || typeFlag === "0") return { rawName: name, path: relPath, type: "file" };
  throw tarError(name, "unsupported member type");
}

function assertTarMemberDoesNotOverlapRejectedPath(
  member: TarMember,
  rejectedPaths: readonly string[],
  mode: number | undefined,
): void {
  const memberPath = member.path;
  for (const rejectedPath of rejectedPaths) {
    const isAncestor =
      memberPath === "" ? rejectedPath !== "" : rejectedPath.startsWith(`${memberPath}/`);
    if (
      member.type === "directory" &&
      isAncestor &&
      mode !== undefined &&
      (mode & 0o300) !== 0o300
    ) {
      throw tarError(member.rawName, `archive directory blocks protected path: ${rejectedPath}`);
    }
    if (
      rejectedPath === "" ||
      memberPath === rejectedPath ||
      memberPath.startsWith(`${rejectedPath}/`) ||
      (member.type !== "directory" && isAncestor)
    ) {
      throw tarError(member.rawName, `archive member overlaps protected path: ${rejectedPath}`);
    }
  }
}

function checkArchiveInputBytes(
  actual: number,
  limits: ReturnType<typeof resolveSandboxArchiveLimits>,
): void {
  const limit = limits?.maxInputBytes;
  if (limit != null && actual > limit) {
    throw new SandboxArchiveError("Workspace archive input size exceeds limit.", {
      reason: "archive input size exceeds limit",
      limit,
      actual,
    });
  }
}

function checkLimit(
  limit: number | null | undefined,
  actual: number,
  reason: string,
  member: string,
): void {
  if (limit != null && actual > limit) {
    throw new SandboxArchiveError(`Workspace ${reason}.`, { reason, limit, actual, member });
  }
}

function safeTarMemberRelPath(name: string): string | null {
  if (name === "" || name === "." || name === "./") return null;
  if (name.startsWith("/")) throw tarError(name, "absolute path");
  if (/^[A-Za-z]:/u.test(name)) throw tarError(name, "windows drive path");
  if (name.includes("\\")) throw tarError(name, "windows path separator");
  const parts = name.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) return null;
  if (parts.includes("..")) throw tarError(name, "parent traversal");
  return parts.join("/");
}

function normalizeTarRelPath(path: string): string {
  return safeTarMemberRelPath(path) ?? "";
}

function parentPaths(path: string): string[] {
  const parts = path.split("/");
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
}

function parsePaxPayload(payload: Uint8Array): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < payload.byteLength) {
    const space = payload.indexOf(0x20, offset);
    if (space === -1 || space === offset) throw tarError("<pax>", "invalid PAX record length");
    let length = 0;
    for (let index = offset; index < space; index += 1) {
      const digit = payload[index]! - 0x30;
      if (digit < 0 || digit > 9) throw tarError("<pax>", "invalid PAX record length");
      length = length * 10 + digit;
      if (!Number.isSafeInteger(length)) throw tarError("<pax>", "invalid PAX record length");
    }
    const recordEnd = offset + length;
    if (recordEnd > payload.byteLength) throw tarError("<pax>", "PAX record exceeds payload");
    if (recordEnd < space + 4 || payload[recordEnd - 1] !== 0x0a) {
      throw tarError("<pax>", "invalid PAX record framing");
    }
    let equals = -1;
    for (let index = space + 1; index < recordEnd - 1; index += 1) {
      if (payload[index] === 0x3d) {
        equals = index;
        break;
      }
    }
    if (equals <= space + 1) throw tarError("<pax>", "invalid PAX record framing");
    let key: string;
    let value: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      key = decoder.decode(payload.subarray(space + 1, equals));
      value = decoder.decode(payload.subarray(equals + 1, recordEnd - 1));
    } catch {
      throw tarError("<pax>", "invalid UTF-8 in PAX record");
    }
    if (key.includes("\0") || value.includes("\0")) {
      throw tarError("<pax>", "NUL byte in PAX record");
    }
    values[key] = value;
    offset = recordEnd;
  }
  return values;
}

function parseTarOctal(header: Uint8Array, start: number, length: number): number {
  if ((header[start]! & 0x80) !== 0) {
    throw tarError("<tar>", "base-256 tar sizes are not supported");
  }
  const text = readTarString(header, start, length).trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/u.test(text)) throw tarError("<tar>", "invalid octal size");
  return Number.parseInt(text, 8);
}

function readTarString(bytes: Uint8Array, start: number, length: number): string {
  return trimTarString(decodeBytes(bytes.subarray(start, start + length)));
}

function trimTarString(value: string): string {
  return value.replace(/\0.*$/u, "").replace(/\n$/u, "");
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function joinTarName(name: string, prefix: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

function tarError(member: string, reason: string): SandboxArchiveError {
  return new SandboxArchiveError(`Unsafe tar member "${member}": ${reason}`, { member, reason });
}

/**
 * Streams a session's workspace tar into a private, owner-marked disk spool on
 * this host, hashing it and applying the SDK's capture-time tar check as it
 * goes. The caller owns the returned spool and must dispose it.
 */
export async function captureWorkspaceTarStreamToSpool(
  session: WorkspaceTarStreamSession,
): Promise<WorkspaceArchiveSpool> {
  const directory = await privateArchiveSpoolDirectory();
  const path = join(directory, "archive.tar");
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const file = handle;
    const digest = createHash("sha256");
    const validator = new WorkspaceTarStreamValidator();
    let byteSize = 0;
    await session.persistWorkspaceTarStream(async (chunk) => {
      validator.push(chunk);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new Error("workspace archive spool write made no progress");
        offset += bytesWritten;
      }
      byteSize += chunk.byteLength;
    });
    validator.finish();
    await handle.close();
    handle = undefined;
    return ownedArchiveSpool(directory, path, byteSize, digest.digest("hex"));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await removeHostArchiveTemporaryDirectory(directory).catch(() => undefined);
    throw error;
  }
}

/**
 * Streams a verified spool into a session's workspace. Each chunk is checked
 * by the SDK's hydration rules before the extractor can see it, and the bytes
 * are hashed again on the way so a spool that changed on disk after its
 * download was verified fails the hydration instead of completing it.
 */
export async function hydrateWorkspaceTarStreamFromSpool(
  session: WorkspaceTarStreamSession,
  spool: WorkspaceArchiveSpool,
  expected: { archiveBytes: number; archiveSha256: string },
  options: { rejectRelPaths: readonly string[]; archiveLimits?: SandboxArchiveLimits | null },
): Promise<void> {
  const validator = new WorkspaceTarStreamValidator({
    allowSymlinks: false,
    rejectRelPaths: options.rejectRelPaths,
    archiveLimits: options.archiveLimits ?? null,
  });
  validator.checkInputBytes(expected.archiveBytes);
  async function* verifiedChunks(): AsyncGenerator<Uint8Array> {
    const digest = createHash("sha256");
    let byteSize = 0;
    for await (const chunk of readSpoolFile(spool)) {
      if (chunk.byteLength > expected.archiveBytes - byteSize) {
        throw new SandboxArchiveError("Workspace archive spool is larger than its descriptor.", {
          expected: expected.archiveBytes,
        });
      }
      validator.push(chunk);
      digest.update(chunk);
      byteSize += chunk.byteLength;
      yield chunk;
    }
    validator.finish();
    if (byteSize !== expected.archiveBytes || digest.digest("hex") !== expected.archiveSha256) {
      throw new SandboxArchiveError("Workspace archive spool does not match its descriptor.", {
        expected: expected.archiveBytes,
        actual: byteSize,
      });
    }
  }
  await session.hydrateWorkspaceTarStream(verifiedChunks());
}

/** One buffer holding a spool's bytes, for a session that can only hydrate
 * from memory. Reads through one reused buffer into its final buffer, and
 * checks the bytes against the spool's verified digest again. */
export async function readWorkspaceArchiveSpool(spool: WorkspaceArchiveSpool): Promise<Uint8Array> {
  const bytes = new Uint8Array(spool.byteSize);
  const digest = createHash("sha256");
  let offset = 0;
  for await (const chunk of readSpoolFile(spool)) {
    if (chunk.byteLength > bytes.byteLength - offset) {
      throw new SandboxArchiveError("Workspace archive spool is larger than its descriptor.", {
        expected: spool.byteSize,
      });
    }
    bytes.set(chunk, offset);
    digest.update(chunk);
    offset += chunk.byteLength;
  }
  if (offset !== bytes.byteLength || digest.digest("hex") !== spool.sha256) {
    throw new SandboxArchiveError("Workspace archive spool does not match its descriptor.", {
      expected: spool.byteSize,
      actual: offset,
    });
  }
  return bytes;
}

/**
 * Reads a spool's file through one reused buffer: each chunk is valid only
 * until the next is requested. A spool's own reader allocates a buffer per
 * chunk, and for a large archive the garbage of those, not any retained copy,
 * set the restore's peak memory. Callers re-hash what they read, so a file
 * that changed after its spool was verified still fails.
 */
async function* readSpoolFile(spool: WorkspaceArchiveSpool): AsyncGenerator<Uint8Array> {
  const handle = await open(spool.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(SPOOL_READ_BYTES);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}
