import { createHash, type Hash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceTreeFingerprint } from "@opengeni/contracts";
import type { WorkspaceArchiveSpool } from "./archive-spool";
import { WorkspaceArchiveIntegrityError } from "./workspace-archive";

const CHUNK_BYTES = 64 * 1024;
// Filesystem representability, not an archive resource quota. Check component
// UTF-8 bytes before clearing a destination, not after open/mkdir fails.
const HOST_FILENAME_BYTES = 255;
const PROJECTION = "sdk_local_archive_v1" as const;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ_DIRECTORY = READ | constants.O_DIRECTORY;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Matches SDK 0.14.3 resolveSandboxArchiveLimits: absent/null means unlimited;
 * an explicit object fills undefined fields with SDK defaults, null disables a field.
 * chunkBytes controls buffering, never the amount of input accepted. */
export type HostWorkspaceArchiveOptions = {
  chunkBytes?: number;
  archiveLimits?: {
    maxInputBytes?: number | null;
    maxExtractedBytes?: number | null;
    maxMembers?: number | null;
  } | null;
};

function invalid(message: string): never {
  throw new WorkspaceArchiveIntegrityError("archive_hydration_failed", message);
}

function changed(cause?: unknown): never {
  throw new WorkspaceArchiveIntegrityError(
    "workspace_changed_during_capture",
    "host workspace changed during archive observation",
    { retryable: true, cause },
  );
}

function captureError(error: unknown): never {
  if (error instanceof WorkspaceArchiveIntegrityError) throw error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return changed(error);
  // Disk exhaustion, permission failures and other operational errors are not
  // evidence of a changing tree and must not become a retryable race diagnosis.
  throw error;
}

function chunkSize(options: HostWorkspaceArchiveOptions): number {
  const size = options.chunkBytes ?? CHUNK_BYTES;
  if (!Number.isSafeInteger(size) || size < 1 || size > CHUNK_BYTES) {
    throw new RangeError(`chunkBytes must be between 1 and ${CHUNK_BYTES}`);
  }
  return size;
}

function limitsFor(options: HostWorkspaceArchiveOptions) {
  if (options.archiveLimits == null) return null;
  const defaults = {
    maxInputBytes: 1024 ** 3,
    maxExtractedBytes: 4 * 1024 ** 3,
    maxMembers: 100_000,
  };
  const limits = { ...defaults, ...options.archiveLimits };
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
    if (limits[key] === undefined) limits[key] = defaults[key];
    const value = limits[key];
    if (value != null && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError(`archiveLimits.${key} must be at least 1`);
    }
  }
  return limits;
}

function checkLimit(actual: number, limit: number | null | undefined, label: string) {
  if (!Number.isSafeInteger(actual)) invalid(`${label} exceeds the supported integer range`);
  if (limit != null && actual > limit)
    invalid(`workspace archive ${label} exceeds configured limit`);
}

function sameEntry(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function sameVersion(a: BigIntStats, b: BigIntStats) {
  return sameEntry(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function fdPath(handle: FileHandle, name?: string) {
  return name === undefined ? `/proc/self/fd/${handle.fd}` : `/proc/self/fd/${handle.fd}/${name}`;
}

/** Node has no openat API. Linux's descriptor namespace supplies the same pinned
 * parent resolution; O_NOFOLLOW applies to the child, never an untrusted ancestor.
 * Do not replace this with lstat(path) followed by open(path): that races. */
async function openRoot(root: string, create = false): Promise<FileHandle> {
  if (process.platform !== "linux")
    invalid("host archive codec requires Linux descriptor-relative filesystem access");
  if (!isAbsolute(root)) invalid("host workspace root must be absolute");
  const absolute = resolve(root);
  if (create && absolute === sep) invalid("cannot restore into the filesystem root");
  let current = await open(sep, READ_DIRECTORY);
  try {
    for (const segment of absolute.split(sep).filter(Boolean)) {
      if (create) {
        await mkdir(fdPath(current, segment), { mode: 0o777 }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
      }
      const next = await open(fdPath(current, segment), READ_DIRECTORY);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

type TreeIndex = {
  directories: Map<string, BigIntStats>;
  files: Map<string, BigIntStats>;
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function inventory(root: FileHandle, excludedPaths: readonly string[]): Promise<TreeIndex> {
  const tree: TreeIndex = { directories: new Map(), files: new Map() };
  const walk = async (handle: FileHandle, logical: string) => {
    const before = await handle.stat({ bigint: true });
    tree.directories.set(logical, before);
    const names = await readdir(fdPath(handle));
    for (const name of names) {
      const path = logical ? `${logical}/${name}` : name;
      if (
        excludedPaths.some(
          (excluded) => excluded === "" || path === excluded || path.startsWith(`${excluded}/`),
        )
      )
        continue;
      const stats = await lstat(fdPath(handle, name), { bigint: true });
      if (stats.isDirectory()) {
        const child = await open(fdPath(handle, name), READ_DIRECTORY);
        try {
          if (!sameVersion(stats, await child.stat({ bigint: true }))) changed();
          await walk(child, path);
          if (!sameVersion(stats, await lstat(fdPath(handle, name), { bigint: true }))) changed();
        } finally {
          await child.close();
        }
      } else if (stats.isFile()) {
        tree.files.set(path, stats);
      }
      // Exactly the SDK projection: symlinks, FIFOs, sockets and devices are skipped.
    }
    if (!sameVersion(before, await handle.stat({ bigint: true }))) changed();
  };
  await walk(root, "");
  return tree;
}

async function openDirectory(root: FileHandle, logical: string, tree?: TreeIndex, create = false) {
  let current = await open(fdPath(root), READ_DIRECTORY & ~constants.O_NOFOLLOW);
  try {
    if (tree && !sameVersion(tree.directories.get("")!, await current.stat({ bigint: true })))
      changed();
    let path = "";
    for (const segment of logical.split("/").filter(Boolean)) {
      path = path ? `${path}/${segment}` : segment;
      if (create) {
        await mkdir(fdPath(current, segment), { mode: 0o777 }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
      }
      const next = await open(fdPath(current, segment), READ_DIRECTORY);
      await current.close();
      current = next;
      if (tree) {
        const expected = tree.directories.get(path);
        if (!expected || !sameVersion(expected, await current.stat({ bigint: true }))) changed();
      }
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

function parentAndName(path: string): [string, string] {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? ["", path] : [path.slice(0, slash), path.slice(slash + 1)];
}

async function readTreeFile(
  root: FileHandle,
  tree: TreeIndex,
  path: string,
  consume: (bytes: Buffer) => void | Promise<void>,
) {
  const [parent, name] = parentAndName(path);
  const directory = await openDirectory(root, parent, tree);
  try {
    const expected = tree.files.get(path)!;
    const handle = await open(fdPath(directory, name), READ);
    try {
      if (!sameVersion(expected, await handle.stat({ bigint: true }))) changed();
      const size = Number(expected.size);
      checkLimit(size, null, "file size");
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - offset),
          offset,
        );
        if (bytesRead === 0) changed();
        await consume(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (
        !sameVersion(expected, await handle.stat({ bigint: true })) ||
        !sameVersion(expected, await lstat(fdPath(directory, name), { bigint: true }))
      )
        changed();
    } finally {
      await handle.close();
    }
  } finally {
    await directory.close();
  }
}

function frame(hash: Hash, label: string, value: string) {
  hash
    .update(label)
    .update("\0")
    .update(String(Buffer.byteLength(value)))
    .update("\0")
    .update(value)
    .update("\0");
}

function projection(directories: readonly string[]) {
  const hash = createHash("sha256");
  frame(hash, "projection", PROJECTION);
  for (const path of [...directories].sort(compare)) frame(hash, "dir", path);
  return hash;
}

function fingerprint(
  hash: Hash,
  directories: number,
  files: number,
  totalFileBytes: number,
): WorkspaceTreeFingerprint {
  checkLimit(totalFileBytes, null, "extracted size");
  return {
    algorithm: "sha256",
    sha256: hash.digest("hex"),
    entryCount: directories + files,
    fileCount: files,
    totalFileBytes,
    projection: PROJECTION,
  };
}

async function verifyInventory(rootPath: string, root: FileHandle, tree: TreeIndex) {
  const fresh = await openRoot(rootPath);
  try {
    if (!sameVersion(tree.directories.get("")!, await fresh.stat({ bigint: true }))) changed();
  } finally {
    await fresh.close();
  }
  for (const path of tree.directories.keys()) {
    const handle = await openDirectory(root, path, tree);
    await handle.close();
  }
  for (const [path, expected] of tree.files) {
    const [parent, name] = parentAndName(path);
    const handle = await openDirectory(root, parent, tree);
    try {
      if (!sameVersion(expected, await lstat(fdPath(handle, name), { bigint: true }))) changed();
    } finally {
      await handle.close();
    }
  }
}

async function hashTree(rootPath: string, root: FileHandle, tree: TreeIndex) {
  const directories = [...tree.directories.keys()].filter(Boolean);
  const hash = projection(directories);
  let total = 0;
  for (const path of [...tree.files.keys()].sort(compare)) {
    const size = Number(tree.files.get(path)!.size);
    frame(hash, "file", path);
    frame(hash, "bytes", String(size));
    await readTreeFile(root, tree, path, (bytes) => {
      hash.update(bytes);
    });
    total += size;
  }
  await verifyInventory(rootPath, root, tree);
  return fingerprint(hash, directories.length, tree.files.size, total);
}

export async function fingerprintHostWorkspace(
  root: string,
  excludedPaths: readonly string[],
): Promise<WorkspaceTreeFingerprint> {
  const handle = await openRoot(root);
  try {
    return await hashTree(root, handle, await inventory(handle, excludedPaths));
  } catch (error) {
    return captureError(error);
  } finally {
    await handle.close();
  }
}

function within(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function privateTemporaryDirectory(root: string) {
  // Resolve the actual location before creating anything: TMPDIR can itself be a
  // symlink or live inside the source workspace. Never add spool files to it.
  const actualRoot = await realpath(root).catch(() => resolve(root));
  for (const candidate of [tmpdir(), "/var/tmp", "/tmp"]) {
    const base = await realpath(candidate).catch(() => null);
    if (!base || within(actualRoot, base) || within("/dev/shm", base)) continue;
    return await mkdtemp(join(base, "opengeni-host-archive-"));
  }
  invalid("no private disk temporary directory exists outside the workspace");
}

async function writeAll(handle: FileHandle, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (!bytesWritten) throw new Error("archive spool write made no progress");
    offset += bytesWritten;
  }
}

class ArchiveWriter {
  readonly hash = createHash("sha256");
  byteSize = 0;
  constructor(readonly handle: FileHandle) {}
  async write(input: string | Uint8Array) {
    const bytes = typeof input === "string" ? Buffer.from(input) : input;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
      await writeAll(this.handle, chunk);
      this.hash.update(chunk);
      this.byteSize += chunk.length;
      checkLimit(this.byteSize, null, "input size");
    }
  }
}

/** Native base64 conversion remains bounded to a chunk; both binary backing
 * stores are reused. In particular, never Buffer.concat the carry with every
 * source chunk or Buffer.from every encoded string: external-memory GC can lag
 * far behind those allocations even though no individual buffer is large. */
class Base64Encoder {
  private readonly input = Buffer.allocUnsafe(CHUNK_BYTES + 2);
  private readonly output = Buffer.allocUnsafe(Math.ceil((CHUNK_BYTES + 2) / 3) * 4);
  private carry = 0;
  constructor(private readonly writer: ArchiveWriter) {}
  async write(bytes: Buffer) {
    bytes.copy(this.input, this.carry);
    const available = this.carry + bytes.length;
    const length = available - (available % 3);
    if (length) await this.encode(length);
    this.carry = available - length;
    this.input.copy(this.input, 0, length, available);
  }
  private async encode(length: number) {
    const written = this.output.write(this.input.subarray(0, length).toString("base64"), "ascii");
    await this.writer.write(this.output.subarray(0, written));
  }
  async finish() {
    if (this.carry) await this.encode(this.carry);
  }
}

function ownedSpool(
  directory: string,
  path: string,
  byteSize: number,
  sha256: string,
): WorkspaceArchiveSpool {
  let disposal: Promise<void> | undefined;
  return {
    path,
    byteSize,
    sha256,
    async *open() {
      if (disposal) throw new Error("archive spool has been disposed");
      const handle = await open(path, READ);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || Number(before.size) !== byteSize) invalid("archive spool changed");
        let position = 0;
        while (position < byteSize) {
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, byteSize - position));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) invalid("archive spool was truncated");
          position += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
        if (!sameVersion(before, await handle.stat({ bigint: true })))
          invalid("archive spool changed while reading");
      } finally {
        await handle.close();
      }
    },
    dispose() {
      return (disposal ??= rm(directory, { recursive: true, force: true }));
    },
  };
}

export async function captureHostWorkspaceArchive(
  root: string,
  excludedPaths: readonly string[],
): Promise<{ spool: WorkspaceArchiveSpool; workspace: WorkspaceTreeFingerprint }> {
  const handle = await openRoot(root);
  let temporary: string | undefined;
  try {
    const tree = await inventory(handle, excludedPaths);
    const before = await hashTree(root, handle, tree);
    temporary = await privateTemporaryDirectory(root);
    const path = join(temporary, "archive.json");
    const file = await open(path, CREATE, 0o600);
    const writer = new ArchiveWriter(file);
    const directories = [...tree.directories.keys()].filter(Boolean).sort(compare);
    const hash = projection(directories);
    let total = 0;
    try {
      await writer.write('{"version":1,"directories":[');
      for (let index = 0; index < directories.length; index++) {
        await writer.write(`${index ? "," : ""}${JSON.stringify(directories[index])}`);
      }
      await writer.write('],"files":[');
      let first = true;
      for (const logical of [...tree.files.keys()].sort(compare)) {
        const size = Number(tree.files.get(logical)!.size);
        frame(hash, "file", logical);
        frame(hash, "bytes", String(size));
        await writer.write(`${first ? "" : ","}{"path":${JSON.stringify(logical)},"data":"`);
        first = false;
        const encoder = new Base64Encoder(writer);
        await readTreeFile(handle, tree, logical, async (bytes) => {
          hash.update(bytes);
          await encoder.write(bytes);
        });
        await encoder.finish();
        await writer.write('"}');
        total += size;
      }
      await writer.write("]}");
    } finally {
      await file.close();
    }
    const archived = fingerprint(hash, directories.length, tree.files.size, total);
    // Prove equivalence of the serialized bytes themselves, not just of the
    // source chunks passed to the base64 encoder.
    const encoded = await open(path, READ);
    const payloadPath = join(temporary, "capture-payload");
    let decoded: WorkspaceTreeFingerprint;
    try {
      const payload = await open(
        payloadPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        decoded = await fingerprintArchiveIndex(await indexArchive(encoded, payload, {}), payload);
      } finally {
        await payload.close();
      }
    } finally {
      await encoded.close();
    }
    await unlink(payloadPath);
    await verifyInventory(root, handle, tree);
    const after = await hashTree(root, handle, await inventory(handle, excludedPaths));
    if (
      before.sha256 !== archived.sha256 ||
      after.sha256 !== archived.sha256 ||
      decoded.sha256 !== archived.sha256
    )
      changed();
    const spool = ownedSpool(temporary, path, writer.byteSize, writer.hash.digest("hex"));
    temporary = undefined;
    return { spool, workspace: archived };
  } catch (error) {
    return captureError(error);
  } finally {
    try {
      await handle.close();
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
}

/** Byte-oriented JSON lexer. Only metadata strings are accumulated. String
 * payloads are decoded in bounded runs, including JSON escapes and split UTF-8. */
class JsonReader {
  private readonly buffer: Buffer;
  private cursor = 0;
  private available = 0;
  private position = 0;
  constructor(
    private readonly handle: FileHandle,
    size: number,
  ) {
    this.buffer = Buffer.allocUnsafe(size);
  }
  private async fill() {
    if (this.cursor < this.available) return true;
    const { bytesRead } = await this.handle.read(this.buffer, 0, this.buffer.length, this.position);
    this.position += bytesRead;
    this.cursor = 0;
    this.available = bytesRead;
    return bytesRead !== 0;
  }
  async peek(): Promise<number> {
    return (await this.fill()) ? this.buffer[this.cursor]! : -1;
  }
  async byte(): Promise<number> {
    const byte = await this.peek();
    if (byte === -1) invalid("truncated workspace archive JSON");
    this.cursor++;
    return byte;
  }
  async whitespace() {
    while (true) {
      const byte = await this.peek();
      if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13) return;
      this.cursor++;
    }
  }
  async expect(character: string) {
    await this.whitespace();
    if ((await this.byte()) !== character.charCodeAt(0))
      invalid(`expected ${character} in workspace archive JSON`);
  }
  async string(consume?: Base64Decoder): Promise<string> {
    await this.expect('"');
    const parts: string[] = [];
    const decoder = consume
      ? undefined
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const emit = async (text: string) => {
      if (!text) return;
      if (consume) await consume.write(text);
      else parts.push(text);
    };
    while (await this.fill()) {
      const start = this.cursor;
      while (this.cursor < this.available) {
        const byte = this.buffer[this.cursor]!;
        if (byte === 34 || byte === 92 || byte < 32) break;
        this.cursor++;
      }
      if (this.cursor > start) {
        const bytes = this.buffer.subarray(start, this.cursor);
        // Base64's alphabet is ASCII. Its decoder validates these bytes directly,
        // so payload runs never become UTF-8/base64 strings or fresh buffers.
        if (consume) await consume.write(bytes);
        else await emit(decoder!.decode(bytes, { stream: true }));
      }
      if (this.cursor === this.available) continue;
      if (decoder) await emit(decoder.decode());
      const special = await this.byte();
      if (special === 34) return parts.join("");
      if (special !== 92) invalid("unescaped control character in workspace archive JSON");
      const escape = String.fromCharCode(await this.byte());
      if (escape === "u") {
        let digits = "";
        for (let index = 0; index < 4; index++) digits += String.fromCharCode(await this.byte());
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) invalid("invalid JSON Unicode escape");
        await emit(String.fromCharCode(Number.parseInt(digits, 16)));
      } else {
        const escapes: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (!Object.hasOwn(escapes, escape)) invalid("invalid JSON escape");
        await emit(escapes[escape]!);
      }
    }
    invalid("unterminated workspace archive JSON string");
  }
  async array(item: () => Promise<void>) {
    await this.expect("[");
    await this.whitespace();
    if ((await this.peek()) === 93) {
      await this.byte();
      return;
    }
    while (true) {
      await item();
      await this.whitespace();
      const separator = await this.byte();
      if (separator === 93) return;
      if (separator !== 44) invalid("invalid workspace archive JSON array");
    }
  }
  async object(field: (key: string) => Promise<void>) {
    await this.expect("{");
    const keys = new Set<string>();
    await this.whitespace();
    if ((await this.peek()) === 125) {
      await this.byte();
      return keys;
    }
    while (true) {
      const key = await this.string();
      if (keys.has(key)) invalid("duplicate workspace archive JSON property");
      keys.add(key);
      await this.expect(":");
      await field(key);
      await this.whitespace();
      const separator = await this.byte();
      if (separator === 125) return keys;
      if (separator !== 44) invalid("invalid workspace archive JSON object");
    }
  }
  async version() {
    await this.whitespace();
    // Recognize the exact numeric value 1 without accumulating a potentially
    // archive-sized number token (1, 1.0, 0.1e1, 100e-2, etc.).
    let digits = 0;
    let integerDigits = 0;
    let significant = -1;
    let valid = true;
    const isDigit = (byte: number) => byte >= 48 && byte <= 57;
    const mantissaDigit = (byte: number) => {
      if (byte !== 48) {
        if (byte !== 49 || significant !== -1) valid = false;
        if (significant === -1) significant = digits;
      }
      digits++;
    };
    if ((await this.peek()) === 45) {
      valid = false;
      await this.byte();
    }
    const first = await this.byte();
    if (!isDigit(first)) invalid("invalid workspace archive version number");
    mantissaDigit(first);
    integerDigits++;
    if (first !== 48) {
      while (isDigit(await this.peek())) {
        mantissaDigit(await this.byte());
        integerDigits++;
      }
    } else if (isDigit(await this.peek())) invalid("invalid leading zero in archive version");
    if ((await this.peek()) === 46) {
      await this.byte();
      if (!isDigit(await this.peek())) invalid("invalid archive version fraction");
      while (isDigit(await this.peek())) mantissaDigit(await this.byte());
    }
    let exponent = 0;
    let sign = 1;
    if ((await this.peek()) === 101 || (await this.peek()) === 69) {
      await this.byte();
      if ((await this.peek()) === 45 || (await this.peek()) === 43) {
        if ((await this.byte()) === 45) sign = -1;
      }
      if (!isDigit(await this.peek())) invalid("invalid archive version exponent");
      while (isDigit(await this.peek())) {
        // Saturation is arithmetic only: every byte is still read/validated.
        exponent = Math.min(Number.MAX_SAFE_INTEGER, exponent * 10 + (await this.byte()) - 48);
      }
    }
    if (!valid || significant === -1 || integerDigits - significant - 1 + sign * exponent !== 0)
      invalid("unsupported workspace archive version");
  }
}

class Base64Decoder {
  private readonly output = Buffer.allocUnsafe(CHUNK_BYTES);
  private outputLength = 0;
  private bits = 0;
  private digits = 0;
  /** 1 requires the second '=', 2 forbids any further data. */
  private padding = 0;
  byteSize = 0;
  constructor(private readonly consume: (bytes: Buffer) => Promise<void>) {}
  private async flush() {
    if (!this.outputLength) return;
    await this.consume(this.output.subarray(0, this.outputLength));
    this.byteSize += this.outputLength;
    this.outputLength = 0;
  }
  async write(input: string | Uint8Array) {
    for (let index = 0; index < input.length; index++) {
      const code = typeof input === "string" ? input.charCodeAt(index) : input[index]!;
      if (this.padding === 2) invalid("data follows workspace archive base64 padding");
      if (this.padding === 1) {
        if (code !== 61) invalid("missing workspace archive base64 padding");
        this.padding = 2;
        continue;
      }
      // Any complete quartet emits at most three bytes. Await the sink before
      // reusing storage; there are no asynchronous operations per input byte.
      if (this.outputLength > this.output.length - 3) await this.flush();
      if (code === 61) {
        if (this.digits === 2) {
          if (this.bits & 15) invalid("noncanonical workspace archive base64 unused bits");
          this.output[this.outputLength++] = this.bits >>> 4;
          this.padding = 1;
        } else if (this.digits === 3) {
          if (this.bits & 3) invalid("noncanonical workspace archive base64 unused bits");
          this.output[this.outputLength++] = this.bits >>> 10;
          this.output[this.outputLength++] = (this.bits >>> 2) & 255;
          this.padding = 2;
        } else invalid("invalid workspace archive base64 padding");
        this.digits = 0;
        continue;
      }
      const value =
        code >= 65 && code <= 90
          ? code - 65
          : code >= 97 && code <= 122
            ? code - 71
            : code >= 48 && code <= 57
              ? code + 4
              : code === 43
                ? 62
                : code === 47
                  ? 63
                  : -1;
      if (value < 0) invalid("invalid workspace archive base64 alphabet");
      this.bits = (this.bits << 6) | value;
      if (++this.digits === 4) {
        this.output[this.outputLength++] = this.bits >>> 16;
        this.output[this.outputLength++] = (this.bits >>> 8) & 255;
        this.output[this.outputLength++] = this.bits & 255;
        this.bits = 0;
        this.digits = 0;
      }
    }
  }
  async finish() {
    if (this.digits || this.padding === 1) invalid("truncated workspace archive base64");
    await this.flush();
  }
}

type FileSpan = { path: string; offset: number; byteSize: number };
type ArchiveIndex = { directories: string[]; files: FileSpan[] };

async function fingerprintArchiveIndex(index: ArchiveIndex, payload: FileHandle) {
  const hash = projection(index.directories);
  let total = 0;
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  for (const file of [...index.files].sort((a, b) => compare(a.path, b.path))) {
    frame(hash, "file", file.path);
    frame(hash, "bytes", String(file.byteSize));
    let copied = 0;
    while (copied < file.byteSize) {
      const { bytesRead } = await payload.read(
        buffer,
        0,
        Math.min(buffer.length, file.byteSize - copied),
        file.offset + copied,
      );
      if (!bytesRead) invalid("validated workspace payload was truncated");
      hash.update(buffer.subarray(0, bytesRead));
      copied += bytesRead;
    }
    total += file.byteSize;
  }
  return fingerprint(hash, index.directories.length, index.files.length, total);
}

function validatePath(path: string) {
  if (
    !path ||
    path.includes("\0") ||
    Buffer.from(path).toString("utf8") !== path ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          Buffer.byteLength(part, "utf8") > HOST_FILENAME_BYTES,
      )
  )
    invalid("unsafe workspace archive path");
}

async function indexArchive(
  input: FileHandle,
  payload: FileHandle,
  options: HostWorkspaceArchiveOptions,
): Promise<ArchiveIndex> {
  const reader = new JsonReader(input, chunkSize(options));
  const limits = limitsFor(options);
  const directories: string[] = [];
  const files: FileSpan[] = [];
  let extracted = 0;
  let members = 0;
  const member = () => {
    checkLimit(++members, limits?.maxMembers, "member count");
  };
  const keys = await reader.object(async (key) => {
    if (key === "version") return await reader.version();
    if (key === "directories") {
      return await reader.array(async () => {
        const path = await reader.string();
        validatePath(path);
        directories.push(path);
        member();
      });
    }
    if (key === "files") {
      return await reader.array(async () => {
        let path: string | undefined;
        const offset = extracted;
        const decoder = new Base64Decoder(async (bytes) => {
          extracted += bytes.length;
          checkLimit(extracted, limits?.maxExtractedBytes, "extracted size");
          await writeAll(payload, bytes);
        });
        const fields = await reader.object(async (field) => {
          if (field === "path") {
            path = await reader.string();
            validatePath(path);
          } else if (field === "data") {
            await reader.string(decoder);
            await decoder.finish();
          } else invalid("unknown workspace archive file property");
        });
        if (path === undefined || !fields.has("data"))
          invalid("workspace archive file is missing path or data");
        files.push({ path, offset, byteSize: decoder.byteSize });
        member();
      });
    }
    invalid("unknown workspace archive property");
  });
  if (!keys.has("version") || !keys.has("directories") || !keys.has("files"))
    invalid("workspace archive is missing required properties");
  await reader.whitespace();
  if ((await reader.peek()) !== -1) invalid("trailing data in workspace archive JSON");
  const paths = new Map<string, "file" | "directory">();
  for (const [path, kind] of [
    ...directories.map((directory) => [directory, "directory"] as const),
    ...files.map((file) => [file.path, "file"] as const),
  ]) {
    if (paths.has(path)) invalid("duplicate workspace archive path");
    paths.set(path, kind);
  }
  for (const path of paths.keys()) {
    let parent = parentAndName(path)[0];
    while (parent) {
      if (paths.get(parent) === "file") invalid("workspace archive file is also an ancestor");
      parent = parentAndName(parent)[0];
    }
  }
  return { directories, files };
}

/** Removes directory entries through pinned parents. unlink never follows a
 * symlink; rmdir never follows a replacement symlink. No recursive rm uses an
 * attacker-controlled pathname. */
async function clearDirectory(handle: FileHandle) {
  for (const name of await readdir(fdPath(handle))) {
    const path = fdPath(handle, name);
    const stats = await lstat(path, { bigint: true });
    if (stats.isDirectory()) {
      const child = await open(path, READ_DIRECTORY);
      try {
        if (!sameEntry(stats, await child.stat({ bigint: true })))
          invalid("restore destination directory changed");
        await clearDirectory(child);
        if (!sameEntry(stats, await lstat(path, { bigint: true })))
          invalid("restore destination directory changed");
        await rmdir(path);
      } finally {
        await child.close();
      }
    } else {
      await unlink(path);
    }
  }
}

async function copySpan(payload: FileHandle, output: FileHandle, span: FileSpan) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let copied = 0;
  while (copied < span.byteSize) {
    const { bytesRead } = await payload.read(
      buffer,
      0,
      Math.min(buffer.length, span.byteSize - copied),
      span.offset + copied,
    );
    if (!bytesRead) invalid("validated workspace payload was truncated");
    await writeAll(output, buffer.subarray(0, bytesRead));
    copied += bytesRead;
  }
}

export async function restoreHostWorkspaceArchive(
  root: string,
  spool: WorkspaceArchiveSpool,
  options: HostWorkspaceArchiveOptions = {},
): Promise<void> {
  // A provider callback can mutate the caller's spool/options objects. The
  // selected expectation must remain the one supplied before any asynchronous
  // work, not a replacement advertised while bytes are being produced.
  const { byteSize: expectedByteSize, sha256: expectedSha256 } = spool;
  const readChunks = spool.open.bind(spool);
  const processingChunkBytes = chunkSize(options);
  const limits = limitsFor(options);
  checkLimit(expectedByteSize, limits?.maxInputBytes, "input size");
  if (expectedByteSize < 0 || !/^[0-9a-f]{64}$/.test(expectedSha256))
    invalid("invalid workspace archive spool metadata");
  const temporary = await privateTemporaryDirectory(root);
  const handles: FileHandle[] = [];
  try {
    const input = await open(
      join(temporary, "input.json"),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    handles.push(input);
    const writer = new ArchiveWriter(input);
    // Read the untrusted source exactly once. All later work uses this private
    // copy, so a changing/reopenable provider cannot switch bytes after validation.
    for await (const bytes of readChunks()) {
      if (!(bytes instanceof Uint8Array)) invalid("invalid workspace archive stream chunk");
      checkLimit(writer.byteSize + bytes.length, limits?.maxInputBytes, "input size");
      if (writer.byteSize + bytes.length > expectedByteSize)
        invalid("workspace archive size mismatch");
      await writer.write(bytes);
    }
    if (writer.byteSize !== expectedByteSize || writer.hash.digest("hex") !== expectedSha256)
      invalid("workspace archive SHA-256/size mismatch");
    const payload = await open(
      join(temporary, "payload"),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    handles.push(payload);
    const archive = await indexArchive(input, payload, {
      chunkBytes: processingChunkBytes,
      archiveLimits: limits,
    });
    // Nothing above creates, clears or truncates anything under root.
    const destination = await openRoot(root, true);
    handles.push(destination);
    const destinationIdentity = await destination.stat({ bigint: true });
    await clearDirectory(destination);
    for (const path of archive.directories) {
      const directory = await openDirectory(destination, path, undefined, true);
      await directory.close();
    }
    for (const span of archive.files) {
      const [parent, name] = parentAndName(span.path);
      const directory = await openDirectory(destination, parent, undefined, true);
      try {
        const output = await open(fdPath(directory, name), CREATE, 0o666);
        try {
          const identity = await output.stat({ bigint: true });
          await copySpan(payload, output, span);
          const freshParent = await openDirectory(destination, parent);
          try {
            if (
              !sameEntry(
                await directory.stat({ bigint: true }),
                await freshParent.stat({ bigint: true }),
              ) ||
              !sameEntry(identity, await lstat(fdPath(freshParent, name), { bigint: true }))
            )
              invalid("restore destination file changed");
          } finally {
            await freshParent.close();
          }
        } finally {
          await output.close();
        }
      } finally {
        await directory.close();
      }
    }
    const fresh = await openRoot(root);
    try {
      if (!sameEntry(destinationIdentity, await fresh.stat({ bigint: true })))
        invalid("restore destination root changed");
    } finally {
      await fresh.close();
    }
  } finally {
    try {
      await Promise.all(handles.map((handle) => handle.close()));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
