import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  type DecipherGCM,
  type Hash,
} from "node:crypto";
import { link, lstat, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { PassThrough, Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { BROWSER_PROFILE_ARTIFACT_FORMAT } from "@opengeni/contracts";

export { BROWSER_PROFILE_ARTIFACT_FORMAT } from "@opengeni/contracts";

const ARTIFACT_MAGIC = Buffer.from([0x4f, 0x47, 0x42, 0x53, 0x01, 0x00, 0x00, 0x00]);
const PROFILE_MAGIC = Buffer.from([0x4f, 0x47, 0x42, 0x50, 0x01, 0x00, 0x00, 0x00]);
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ARTIFACT_HEADER_BYTES = ARTIFACT_MAGIC.byteLength + IV_BYTES;
const FILE_ENTRY = 0x01;
const ARCHIVE_END = 0x00;
const ENTRY_HEADER_BYTES = 1 + 4 + 8;
const DEFAULT_MAX_FILES = 200_000;
const DEFAULT_MAX_PROFILE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_AAD_BYTES = 16 * 1024;
const FILE_CHUNK_BYTES = 1024 * 1024;

const EXCLUDED_NAMES = new Set([
  "BrowserMetrics",
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
  "Cache",
  "Code Cache",
  "Crash Reports",
  "Crashpad",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
]);

export type BrowserProfileTab = {
  url: string;
  selected: boolean;
};

export type BrowserProfileManifest = {
  schemaVersion: 1;
  browserSessionId: string;
  controllerGeneration: string;
  capturedAt: string;
  engine: "chromium" | "chrome";
  engineVersion: string | null;
  driverId: string;
  driverSchemaVersion: number;
  profileCrypto: "chromium_basic" | "chromium_mock_keychain" | "platform_bound";
  platform: "linux" | "macos" | "windows";
  architecture: "x64" | "arm64";
  tabs: BrowserProfileTab[];
};

export type BrowserProfileArtifactReceipt = {
  format: typeof BROWSER_PROFILE_ARTIFACT_FORMAT;
  artifactDigest: string;
  contentDigest: string;
  sizeBytes: number;
  fileCount: number;
  profileBytes: number;
  manifest: BrowserProfileManifest;
};

export type BrowserProfileArtifactLimits = {
  maxFiles?: number;
  maxProfileBytes?: number;
};

export function parseBrowserProfileManifest(input: unknown): BrowserProfileManifest {
  return validateManifest(input);
}

export function parseBrowserProfileArtifactReceipt(input: unknown): BrowserProfileArtifactReceipt {
  if (!isRecord(input)) throw new Error("browser profile artifact receipt must be an object");
  const allowed = new Set([
    "format",
    "artifactDigest",
    "contentDigest",
    "sizeBytes",
    "fileCount",
    "profileBytes",
    "manifest",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("browser profile artifact receipt contains unknown fields");
  }
  if (input.format !== BROWSER_PROFILE_ARTIFACT_FORMAT) {
    throw new Error("browser profile artifact receipt format is invalid");
  }
  return {
    format: BROWSER_PROFILE_ARTIFACT_FORMAT,
    artifactDigest: sha256Value(input.artifactDigest, "artifact digest"),
    contentDigest: sha256Value(input.contentDigest, "content digest"),
    sizeBytes: boundedPositiveIntegerValue(
      input.sizeBytes,
      Number.MAX_SAFE_INTEGER,
      "artifact size",
    ),
    fileCount: boundedNonnegativeInteger(input.fileCount, DEFAULT_MAX_FILES, "profile file count"),
    profileBytes: boundedNonnegativeInteger(
      input.profileBytes,
      DEFAULT_MAX_PROFILE_BYTES,
      "profile byte count",
    ),
    manifest: validateManifest(input.manifest),
  };
}

export async function captureEncryptedBrowserProfile(input: {
  profileDirectory: string;
  artifactPath: string;
  dataKey: Uint8Array;
  aad: Uint8Array;
  manifest: BrowserProfileManifest;
  limits?: BrowserProfileArtifactLimits;
}): Promise<BrowserProfileArtifactReceipt> {
  const profileDirectory = resolve(input.profileDirectory);
  const artifactPath = resolve(input.artifactPath);
  assertSeparatePaths(profileDirectory, artifactPath);
  const manifest = validateManifest(input.manifest);
  const key = dataKey(input.dataKey);
  const aad = associatedData(input.aad);
  const limits = normalizeLimits(input.limits);
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    key.fill(0);
    throw new Error("browser profile manifest exceeds its byte envelope");
  }
  const inventory = { fileCount: 0, profileBytes: 0 };
  const temporaryPath = `${artifactPath}.partial.${randomUUID()}`;
  await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
  await rm(temporaryPath, { force: true });
  const content = new DigestTransform();
  const artifact = new DigestTransform();
  try {
    await pipeline(
      Readable.from(encodeProfileArchive(profileDirectory, manifestBytes, limits, inventory)),
      createGzip({ level: 6 }),
      content,
      new ArtifactEncryptTransform(key, aad),
      artifact,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    await publishPrivateFile(temporaryPath, artifactPath);
    return {
      format: BROWSER_PROFILE_ARTIFACT_FORMAT,
      artifactDigest: artifact.digest(),
      contentDigest: content.digest(),
      sizeBytes: artifact.bytes,
      fileCount: inventory.fileCount,
      profileBytes: inventory.profileBytes,
      manifest,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    key.fill(0);
  }
}

export async function restoreEncryptedBrowserProfile(input: {
  artifactPath: string;
  outputProfileDirectory: string;
  dataKey: Uint8Array;
  aad: Uint8Array;
  expectedArtifactDigest: string;
  expectedContentDigest: string;
  expectedSizeBytes: number;
  limits?: BrowserProfileArtifactLimits;
}): Promise<BrowserProfileArtifactReceipt> {
  const artifactPath = resolve(input.artifactPath);
  const outputProfileDirectory = resolve(input.outputProfileDirectory);
  assertSeparatePaths(outputProfileDirectory, artifactPath);
  const key = dataKey(input.dataKey);
  const aad = associatedData(input.aad);
  const expectedArtifactDigest = sha256(input.expectedArtifactDigest, "artifact digest");
  const expectedContentDigest = sha256(input.expectedContentDigest, "content digest");
  const expectedSizeBytes = boundedPositiveInteger(
    input.expectedSizeBytes,
    Number.MAX_SAFE_INTEGER,
    "artifact size",
  );
  const limits = normalizeLimits(input.limits);
  const actual = await stat(artifactPath);
  if (!actual.isFile() || actual.size !== expectedSizeBytes) {
    key.fill(0);
    throw new Error("browser profile artifact size does not match its authority");
  }
  const artifact = new DigestTransform();
  const content = new DigestTransform();
  const cleartext = new PassThrough({ highWaterMark: FILE_CHUNK_BYTES });
  let manifest: BrowserProfileManifest | null = null;
  let inventory: { fileCount: number; profileBytes: number } | null = null;
  try {
    await mkdir(outputProfileDirectory, { recursive: false, mode: 0o700 });
    const decoding = pipeline(
      createReadStream(artifactPath),
      artifact,
      new ArtifactDecryptTransform(key, aad),
      content,
      createGunzip(),
      cleartext,
    );
    // Attach a rejection observer immediately. Authentication can fail after
    // the async archive reader has consumed all tentative GCM plaintext; Bun
    // otherwise reports that short scheduling gap as an unhandled rejection.
    const observedDecoding = decoding.catch(() => undefined);
    try {
      const extracted = await extractProfileArchive(cleartext, outputProfileDirectory, limits);
      manifest = extracted.manifest;
      inventory = extracted.inventory;
      await decoding;
    } catch (error) {
      cleartext.destroy();
      await observedDecoding;
      throw error;
    }
    if (artifact.bytes !== expectedSizeBytes || artifact.digest() !== expectedArtifactDigest) {
      throw new Error("browser profile artifact digest does not match its authority");
    }
    if (content.digest() !== expectedContentDigest) {
      throw new Error("browser profile content digest does not match its authority");
    }
    return {
      format: BROWSER_PROFILE_ARTIFACT_FORMAT,
      artifactDigest: expectedArtifactDigest,
      contentDigest: expectedContentDigest,
      sizeBytes: expectedSizeBytes,
      fileCount: inventory.fileCount,
      profileBytes: inventory.profileBytes,
      manifest,
    };
  } catch (error) {
    await rm(outputProfileDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    key.fill(0);
  }
}

async function* encodeProfileArchive(
  profileDirectory: string,
  manifest: Buffer,
  limits: Required<BrowserProfileArtifactLimits>,
  inventory: { fileCount: number; profileBytes: number },
): AsyncGenerator<Buffer> {
  const profileStat = await lstat(profileDirectory);
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
    throw new Error("browser profile path is not a private directory");
  }
  yield PROFILE_MAGIC;
  yield entryHeader("manifest.json", manifest.byteLength);
  yield manifest;
  for await (const entry of walkProfile(profileDirectory, "")) {
    inventory.fileCount += 1;
    inventory.profileBytes += entry.size;
    if (inventory.fileCount > limits.maxFiles) {
      throw new Error("browser profile file-count bound was reached");
    }
    if (inventory.profileBytes > limits.maxProfileBytes) {
      throw new Error("browser profile byte bound was reached");
    }
    const archivePath = `profile/${entry.relativePath}`;
    yield entryHeader(archivePath, entry.size);
    const handle = await open(entry.absolutePath, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== entry.size) {
        throw new Error("browser profile changed while it was being captured");
      }
      let emitted = 0;
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        highWaterMark: FILE_CHUNK_BYTES,
      })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        emitted += bytes.byteLength;
        if (emitted > entry.size) {
          throw new Error("browser profile file grew while it was being captured");
        }
        yield bytes;
      }
      if (emitted !== entry.size) {
        throw new Error("browser profile file changed while it was being captured");
      }
    } finally {
      await handle.close();
    }
  }
  yield Buffer.from([ARCHIVE_END]);
}

async function* walkProfile(
  root: string,
  relativeDirectory: string,
): AsyncGenerator<{
  absolutePath: string;
  relativePath: string;
  size: number;
}> {
  const directory = relativeDirectory ? join(root, ...relativeDirectory.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const entry of entries) {
    if (excluded(relativeDirectory, entry.name, entry.isDirectory())) continue;
    const relativePath = relativeDirectory ? posix.join(relativeDirectory, entry.name) : entry.name;
    assertArchivePath(relativePath);
    const absolutePath = join(root, ...relativePath.split("/"));
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      throw new Error(`browser profile contains an unsupported symbolic link: ${relativePath}`);
    }
    if (info.isDirectory()) {
      yield* walkProfile(root, relativePath);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`browser profile contains an unsupported filesystem entry: ${relativePath}`);
    }
    if (!Number.isSafeInteger(info.size) || info.size < 0) {
      throw new Error("browser profile file size is invalid");
    }
    yield { absolutePath, relativePath, size: info.size };
  }
}

async function extractProfileArchive(
  source: AsyncIterable<Uint8Array>,
  outputProfileDirectory: string,
  limits: Required<BrowserProfileArtifactLimits>,
): Promise<{
  manifest: BrowserProfileManifest;
  inventory: { fileCount: number; profileBytes: number };
}> {
  const reader = new AsyncChunkReader(source);
  if (!(await reader.readExactly(PROFILE_MAGIC.byteLength)).equals(PROFILE_MAGIC)) {
    throw new Error("browser profile archive header is invalid");
  }
  const seen = new Set<string>();
  let manifest: BrowserProfileManifest | null = null;
  let fileCount = 0;
  let profileBytes = 0;
  while (true) {
    const type = (await reader.readExactly(1))[0]!;
    if (type === ARCHIVE_END) break;
    if (type !== FILE_ENTRY) throw new Error("browser profile archive entry type is invalid");
    const fixed = await reader.readExactly(12);
    const pathBytes = fixed.readUInt32BE(0);
    const rawSize = fixed.readBigUInt64BE(4);
    if (pathBytes < 1 || pathBytes > MAX_PATH_BYTES || rawSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("browser profile archive entry bounds are invalid");
    }
    const size = Number(rawSize);
    const path = decodePath(await reader.readExactly(pathBytes));
    assertArchivePath(path);
    if (seen.has(path)) throw new Error("browser profile archive contains a duplicate path");
    seen.add(path);
    if (path === "manifest.json") {
      if (manifest || seen.size !== 1 || size < 1 || size > MAX_MANIFEST_BYTES) {
        throw new Error("browser profile archive manifest is invalid");
      }
      const bytes = await reader.readExactly(size);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new Error("browser profile archive manifest is invalid JSON");
      }
      manifest = validateManifest(parsed);
      continue;
    }
    if (!manifest || !path.startsWith("profile/") || path.length === "profile/".length) {
      throw new Error("browser profile archive path is outside profile authority");
    }
    fileCount += 1;
    profileBytes += size;
    if (fileCount > limits.maxFiles || profileBytes > limits.maxProfileBytes) {
      throw new Error("browser profile archive exceeds its extraction bounds");
    }
    const relativePath = path.slice("profile/".length);
    const destination = resolve(outputProfileDirectory, ...relativePath.split("/"));
    if (!isPathWithin(outputProfileDirectory, destination)) {
      throw new Error("browser profile archive path escapes its destination");
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const handle = await open(destination, "wx", 0o600);
    try {
      let position = 0;
      while (position < size) {
        const chunk = await reader.readUpTo(Math.min(FILE_CHUNK_BYTES, size - position));
        const written = await handle.write(chunk, 0, chunk.byteLength, position);
        if (written.bytesWritten !== chunk.byteLength) {
          throw new Error("browser profile archive write was incomplete");
        }
        position += written.bytesWritten;
      }
    } finally {
      await handle.close();
    }
  }
  await reader.requireEnd();
  if (!manifest) throw new Error("browser profile archive has no manifest");
  return { manifest, inventory: { fileCount, profileBytes } };
}

class ArtifactEncryptTransform extends Transform {
  private readonly cipher;
  private readonly header: Buffer;

  constructor(key: Buffer, aad: Buffer) {
    super();
    const iv = randomBytes(IV_BYTES);
    this.header = Buffer.concat([ARTIFACT_MAGIC, iv]);
    this.cipher = createCipheriv("aes-256-gcm", key, iv);
    this.cipher.setAAD(aad);
  }

  override _construct(callback: (error?: Error | null) => void): void {
    this.push(this.header);
    callback();
  }

  override _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.push(this.cipher.update(chunk));
      callback();
    } catch (error) {
      callback(asError(error));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.push(this.cipher.final());
      this.push(this.cipher.getAuthTag());
      callback();
    } catch (error) {
      callback(asError(error));
    }
  }
}

class ArtifactDecryptTransform extends Transform {
  private readonly key: Buffer;
  private readonly aad: Buffer;
  private decipher: DecipherGCM | null = null;
  private pending = Buffer.alloc(0);
  private trailing = Buffer.alloc(0);

  constructor(key: Buffer, aad: Buffer) {
    super();
    this.key = key;
    this.aad = aad;
  }

  override _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.accept(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    } catch (error) {
      callback(asError(error));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (
        !this.decipher ||
        this.pending.byteLength > 0 ||
        this.trailing.byteLength !== AUTH_TAG_BYTES
      ) {
        throw new Error("browser profile artifact is truncated");
      }
      this.decipher.setAuthTag(this.trailing);
      this.push(this.decipher.final());
      callback();
    } catch (error) {
      callback(
        new Error("browser profile artifact authentication failed", {
          cause: asError(error),
        }),
      );
    }
  }

  private accept(chunk: Buffer): void {
    if (!this.decipher) {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (this.pending.byteLength < ARTIFACT_HEADER_BYTES) return;
      const header = this.pending.subarray(0, ARTIFACT_MAGIC.byteLength);
      if (!header.equals(ARTIFACT_MAGIC)) {
        throw new Error("browser profile artifact header is invalid");
      }
      const iv = this.pending.subarray(ARTIFACT_MAGIC.byteLength, ARTIFACT_HEADER_BYTES);
      this.decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      this.decipher.setAAD(this.aad);
      chunk = this.pending.subarray(ARTIFACT_HEADER_BYTES);
      this.pending = Buffer.alloc(0);
    }
    const combined = Buffer.concat([this.trailing, chunk]);
    if (combined.byteLength <= AUTH_TAG_BYTES) {
      this.trailing = combined;
      return;
    }
    const bodyBytes = combined.byteLength - AUTH_TAG_BYTES;
    this.push(this.decipher.update(combined.subarray(0, bodyBytes)));
    this.trailing = combined.subarray(bodyBytes);
  }
}

class DigestTransform extends Transform {
  private readonly hash: Hash = createHash("sha256");
  private settledDigest: string | null = null;
  bytes = 0;

  override _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += bytes.byteLength;
    this.hash.update(bytes);
    this.push(bytes);
    callback();
  }

  digest(): string {
    this.settledDigest ??= this.hash.digest("hex");
    return this.settledDigest;
  }
}

class AsyncChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async readExactly(size: number): Promise<Buffer> {
    if (size === 0) return Buffer.alloc(0);
    const output = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const chunk = await this.readUpTo(size - offset);
      chunk.copy(output, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  async readUpTo(maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("archive reader byte request is invalid");
    }
    while (this.buffer.byteLength === 0) {
      if (this.ended) throw new Error("browser profile archive is truncated");
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        continue;
      }
      this.buffer = Buffer.from(next.value);
    }
    const size = Math.min(maxBytes, this.buffer.byteLength);
    const value = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return value;
  }

  async requireEnd(): Promise<void> {
    if (this.buffer.byteLength > 0) {
      throw new Error("browser profile archive contains trailing bytes");
    }
    const next = await this.iterator.next();
    if (!next.done) throw new Error("browser profile archive contains trailing bytes");
    this.ended = true;
  }
}

function entryHeader(path: string, size: number): Buffer {
  assertArchivePath(path);
  const pathBytes = Buffer.from(path, "utf8");
  if (pathBytes.byteLength > MAX_PATH_BYTES) {
    throw new Error("browser profile archive path exceeds its byte envelope");
  }
  const header = Buffer.allocUnsafe(ENTRY_HEADER_BYTES + pathBytes.byteLength);
  header[0] = FILE_ENTRY;
  header.writeUInt32BE(pathBytes.byteLength, 1);
  header.writeBigUInt64BE(BigInt(size), 5);
  pathBytes.copy(header, ENTRY_HEADER_BYTES);
  return header;
}

function excluded(relativeDirectory: string, name: string, directory: boolean): boolean {
  if (EXCLUDED_NAMES.has(name) || name.startsWith("Singleton")) return true;
  if (directory && EXCLUDED_DIRECTORY_NAMES.has(name)) return true;
  const segments = relativeDirectory ? relativeDirectory.split("/") : [];
  return segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment));
}

function validateManifest(input: unknown): BrowserProfileManifest {
  if (!isRecord(input)) throw new Error("browser profile manifest must be an object");
  const allowed = new Set([
    "schemaVersion",
    "browserSessionId",
    "controllerGeneration",
    "capturedAt",
    "engine",
    "engineVersion",
    "driverId",
    "driverSchemaVersion",
    "profileCrypto",
    "platform",
    "architecture",
    "tabs",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("browser profile manifest contains unknown fields");
  }
  if (input.schemaVersion !== 1) throw new Error("browser profile manifest version is invalid");
  if (typeof input.browserSessionId !== "string" || !isUuid(input.browserSessionId)) {
    throw new Error("browser profile manifest session id is invalid");
  }
  if (
    typeof input.controllerGeneration !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.controllerGeneration)
  ) {
    throw new Error("browser profile manifest controller generation is invalid");
  }
  if (typeof input.capturedAt !== "string" || !canonicalTimestamp(input.capturedAt)) {
    throw new Error("browser profile manifest timestamp is invalid");
  }
  if (input.engine !== "chromium" && input.engine !== "chrome") {
    throw new Error("browser profile manifest engine is invalid");
  }
  if (
    input.engineVersion !== null &&
    (typeof input.engineVersion !== "string" ||
      input.engineVersion.length < 1 ||
      Buffer.byteLength(input.engineVersion) > 256)
  ) {
    throw new Error("browser profile manifest engine version is invalid");
  }
  if (
    typeof input.driverId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input.driverId)
  ) {
    throw new Error("browser profile manifest driver id is invalid");
  }
  if (
    typeof input.driverSchemaVersion !== "number" ||
    !Number.isSafeInteger(input.driverSchemaVersion) ||
    input.driverSchemaVersion < 1 ||
    input.driverSchemaVersion > 1_000_000
  ) {
    throw new Error("browser profile manifest driver schema version is invalid");
  }
  if (
    input.profileCrypto !== "chromium_basic" &&
    input.profileCrypto !== "chromium_mock_keychain" &&
    input.profileCrypto !== "platform_bound"
  ) {
    throw new Error("browser profile manifest crypto policy is invalid");
  }
  if (input.platform !== "linux" && input.platform !== "macos" && input.platform !== "windows") {
    throw new Error("browser profile manifest platform is invalid");
  }
  if (input.architecture !== "x64" && input.architecture !== "arm64") {
    throw new Error("browser profile manifest architecture is invalid");
  }
  if (!Array.isArray(input.tabs) || input.tabs.length > 1_000) {
    throw new Error("browser profile manifest tabs are invalid");
  }
  const tabs = input.tabs.map((tab) => {
    if (
      !isRecord(tab) ||
      Object.keys(tab).some((key) => key !== "url" && key !== "selected") ||
      typeof tab.url !== "string" ||
      Buffer.byteLength(tab.url) > 16_384 ||
      typeof tab.selected !== "boolean"
    ) {
      throw new Error("browser profile manifest tab is invalid");
    }
    return { url: tab.url, selected: tab.selected };
  });
  if (tabs.filter((tab) => tab.selected).length > 1) {
    throw new Error("browser profile manifest selects more than one tab");
  }
  return {
    schemaVersion: 1,
    browserSessionId: input.browserSessionId,
    controllerGeneration: input.controllerGeneration,
    capturedAt: input.capturedAt,
    engine: input.engine,
    engineVersion: input.engineVersion,
    driverId: input.driverId,
    driverSchemaVersion: input.driverSchemaVersion,
    profileCrypto: input.profileCrypto,
    platform: input.platform,
    architecture: input.architecture,
    tabs,
  };
}

function normalizeLimits(
  limits: BrowserProfileArtifactLimits | undefined,
): Required<BrowserProfileArtifactLimits> {
  return {
    maxFiles: boundedPositiveInteger(
      limits?.maxFiles ?? DEFAULT_MAX_FILES,
      DEFAULT_MAX_FILES,
      "browser profile file bound",
    ),
    maxProfileBytes: boundedPositiveInteger(
      limits?.maxProfileBytes ?? DEFAULT_MAX_PROFILE_BYTES,
      DEFAULT_MAX_PROFILE_BYTES,
      "browser profile byte bound",
    ),
  };
}

function dataKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error("browser profile data key must be exactly 32 bytes");
  }
  return Buffer.from(value);
}

function associatedData(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_AAD_BYTES) {
    throw new Error("browser profile associated data is invalid");
  }
  return Buffer.from(value);
}

function sha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

function assertArchivePath(path: string): void {
  const bytes = Buffer.byteLength(path);
  if (
    bytes < 1 ||
    bytes > MAX_PATH_BYTES ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    posix.normalize(path) !== path ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("browser profile archive path is invalid");
  }
}

function decodePath(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("browser profile archive path is not valid UTF-8");
  }
}

function assertSeparatePaths(directory: string, file: string): void {
  if (directory === file || isPathWithin(directory, file) || isPathWithin(file, directory)) {
    throw new Error("browser profile and artifact paths must not overlap");
  }
}

function isPathWithin(parent: string, child: string): boolean {
  const suffix = relative(resolve(parent), resolve(child));
  return (
    suffix !== "" &&
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`) &&
    !suffix.includes(`..${sep}`)
  );
}

async function publishPrivateFile(temporaryPath: string, artifactPath: string): Promise<void> {
  try {
    await link(temporaryPath, artifactPath);
    await unlink(temporaryPath);
  } catch (error) {
    if (process.platform === "win32") {
      await rename(temporaryPath, artifactPath);
      return;
    }
    throw error;
  }
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive bounded integer`);
  }
  return value;
}

function boundedPositiveIntegerValue(value: unknown, maximum: number, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`${label} must be a positive bounded integer`);
  }
  return boundedPositiveInteger(value, maximum, label);
}

function boundedNonnegativeInteger(value: unknown, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a nonnegative bounded integer`);
  }
  return value;
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be lowercase SHA-256`);
  return sha256(value, label);
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("browser profile artifact operation failed");
}
