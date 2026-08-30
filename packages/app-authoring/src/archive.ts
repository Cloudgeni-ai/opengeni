import { createHash } from "node:crypto";

import {
  WORKSPACE_APP_BUILD_FILE_MAX_BYTES,
  WORKSPACE_APP_BUILD_MAX_BYTES,
  WORKSPACE_APP_BUILD_MAX_FILES,
  WORKSPACE_APP_SOURCE_MAX_BYTES,
  WORKSPACE_APP_SOURCE_MAX_FILES,
  type AppBuildManifest,
} from "@opengeni/contracts/apps";

import {
  OG_APP_SOURCE_MANIFEST_PATH,
  normalizePortableAppPath,
  parseOgAppSourceManifest,
  type OgAppSourceManifest,
} from "./manifest";

const TAR_BLOCK_SIZE = 512;
const TAR_END_SIZE = TAR_BLOCK_SIZE * 2;
const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type PortableAppArchiveEntry = {
  path: string;
  bytes: Uint8Array;
  executable?: boolean;
};

export type InspectedPortableAppArchive = {
  entries: PortableAppArchiveEntry[];
  sourceManifest: OgAppSourceManifest;
};

function comparePortablePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteLength(value: string): number {
  return UTF8.encode(value).length;
}

function tarName(path: string): { name: string; prefix: string } {
  if (byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (byteLength(prefix) <= 155 && byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`App path ${JSON.stringify(path)} cannot be represented by portable ustar.`);
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = UTF8.encode(value);
  if (bytes.length > length) throw new Error(`Tar field exceeds ${length} bytes.`);
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Tar values must be nonnegative.");
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new Error("Tar numeric field overflow.");
  writeAscii(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return UTF8_DECODER.decode(zero < 0 ? field : field.subarray(0, zero));
}

function readOctal(block: Uint8Array, offset: number, length: number, label: string): number {
  const raw = readString(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(raw)) throw new Error(`Invalid tar ${label}.`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`Tar ${label} exceeds the safe integer range.`);
  return value;
}

function tarChecksum(block: Uint8Array): number {
  let checksum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return checksum;
}

function entryHeader(entry: PortableAppArchiveEntry): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const parts = tarName(entry.path);
  writeAscii(header, 0, 100, parts.name);
  writeOctal(header, 100, 8, entry.executable ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  writeAscii(header, 345, 155, parts.prefix);
  const checksum = tarChecksum(header).toString(8).padStart(6, "0");
  writeAscii(header, 148, 6, checksum);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function normalizeEntries(
  input: Iterable<PortableAppArchiveEntry>,
  limits: { maxFiles: number; maxBytes: number; maxFileBytes: number },
): PortableAppArchiveEntry[] {
  const seen = new Set<string>();
  const entries: PortableAppArchiveEntry[] = [];
  let totalBytes = 0;
  for (const source of input) {
    const path = normalizePortableAppPath(source.path);
    if (seen.has(path)) throw new Error(`Duplicate app archive path: ${path}.`);
    seen.add(path);
    const bytes = Uint8Array.from(source.bytes);
    if (bytes.byteLength > limits.maxFileBytes) {
      throw new Error(`App file ${path} exceeds the ${limits.maxFileBytes}-byte limit.`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxBytes) {
      throw new Error(`App files exceed the ${limits.maxBytes}-byte aggregate limit.`);
    }
    entries.push({ path, bytes, ...(source.executable ? { executable: true } : {}) });
    if (entries.length > limits.maxFiles) {
      throw new Error(`App archive exceeds the ${limits.maxFiles}-file limit.`);
    }
  }
  entries.sort((left, right) => comparePortablePaths(left.path, right.path));
  return entries;
}

export function validatePortableAppEntries(input: Iterable<PortableAppArchiveEntry>): {
  entries: PortableAppArchiveEntry[];
  sourceManifest: OgAppSourceManifest;
} {
  const entries = normalizeEntries(input, {
    maxFiles: WORKSPACE_APP_SOURCE_MAX_FILES,
    maxBytes: WORKSPACE_APP_SOURCE_MAX_BYTES,
    maxFileBytes: WORKSPACE_APP_BUILD_FILE_MAX_BYTES,
  });
  const manifestEntry = entries.find((entry) => entry.path === OG_APP_SOURCE_MANIFEST_PATH);
  if (!manifestEntry) throw new Error(`App source must contain ${OG_APP_SOURCE_MANIFEST_PATH}.`);
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(UTF8_DECODER.decode(manifestEntry.bytes));
  } catch {
    throw new Error(`${OG_APP_SOURCE_MANIFEST_PATH} must be valid UTF-8 JSON.`);
  }
  const sourceManifest = parseOgAppSourceManifest(rawManifest);
  if (!entries.some((entry) => entry.path === sourceManifest.entryPath)) {
    throw new Error(`App entryPath ${sourceManifest.entryPath} is missing from the source.`);
  }
  return { entries, sourceManifest };
}

export function createPortableAppArchive(input: Iterable<PortableAppArchiveEntry>): Uint8Array {
  const { entries } = validatePortableAppEntries(input);
  let length = TAR_END_SIZE;
  for (const entry of entries) {
    length += TAR_BLOCK_SIZE + Math.ceil(entry.bytes.byteLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  if (length > WORKSPACE_APP_SOURCE_MAX_BYTES) {
    throw new Error(`Portable app archive exceeds ${WORKSPACE_APP_SOURCE_MAX_BYTES} bytes.`);
  }
  const archive = new Uint8Array(length);
  let offset = 0;
  for (const entry of entries) {
    archive.set(entryHeader(entry), offset);
    offset += TAR_BLOCK_SIZE;
    archive.set(entry.bytes, offset);
    offset += Math.ceil(entry.bytes.byteLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return archive;
}

function blockIsZero(block: Uint8Array): boolean {
  return block.every((value) => value === 0);
}

export function inspectPortableAppArchive(bytes: Uint8Array): InspectedPortableAppArchive {
  if (
    bytes.byteLength < TAR_END_SIZE ||
    bytes.byteLength > WORKSPACE_APP_SOURCE_MAX_BYTES ||
    bytes.byteLength % TAR_BLOCK_SIZE !== 0
  ) {
    throw new Error("Portable app archive has an invalid bounded tar size.");
  }
  const entries: PortableAppArchiveEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let offset = 0;
  let ended = false;
  while (offset < bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (blockIsZero(header)) {
      const next = bytes.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_END_SIZE);
      if (next.byteLength !== TAR_BLOCK_SIZE || !blockIsZero(next)) {
        throw new Error("Portable app archive must end with two zero tar blocks.");
      }
      if (!blockIsZero(bytes.subarray(offset))) {
        throw new Error("Portable app archive contains nonzero trailing data.");
      }
      ended = true;
      break;
    }
    const expectedChecksum = readOctal(header, 148, 8, "checksum");
    if (expectedChecksum !== tarChecksum(header)) throw new Error("Tar header checksum mismatch.");
    if (readString(header, 257, 6) !== "ustar") {
      throw new Error("Portable app archives must use the ustar format.");
    }
    const type = header[156];
    if (type !== 0 && type !== "0".charCodeAt(0)) {
      throw new Error("Portable app archives may contain regular files only.");
    }
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = normalizePortableAppPath(prefix ? `${prefix}/${name}` : name);
    if (seen.has(path)) throw new Error(`Duplicate app archive path: ${path}.`);
    seen.add(path);
    const size = readOctal(header, 124, 12, "file size");
    if (size > WORKSPACE_APP_BUILD_FILE_MAX_BYTES) {
      throw new Error(`App file ${path} exceeds the per-file limit.`);
    }
    const dataOffset = offset + TAR_BLOCK_SIZE;
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (dataOffset + paddedSize > bytes.byteLength - TAR_END_SIZE) {
      throw new Error(`App file ${path} extends beyond the tar boundary.`);
    }
    const mode = readOctal(header, 100, 8, "mode");
    if ((mode & ~0o777) !== 0) throw new Error(`App file ${path} has an unsupported mode.`);
    const fileBytes = Uint8Array.from(bytes.subarray(dataOffset, dataOffset + size));
    if (!blockIsZero(bytes.subarray(dataOffset + size, dataOffset + paddedSize))) {
      throw new Error(`App file ${path} contains nonzero tar padding.`);
    }
    totalBytes += size;
    if (totalBytes > WORKSPACE_APP_SOURCE_MAX_BYTES) {
      throw new Error("Portable app archive exceeds the aggregate byte limit.");
    }
    entries.push({ path, bytes: fileBytes, ...((mode & 0o111) !== 0 ? { executable: true } : {}) });
    if (entries.length > WORKSPACE_APP_SOURCE_MAX_FILES) {
      throw new Error("Portable app archive exceeds the file-count limit.");
    }
    offset = dataOffset + paddedSize;
  }
  if (!ended) throw new Error("Portable app archive is missing its end marker.");
  return validatePortableAppEntries(entries);
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (
    (
      {
        css: "text/css; charset=utf-8",
        csv: "text/csv; charset=utf-8",
        gif: "image/gif",
        html: "text/html; charset=utf-8",
        ico: "image/x-icon",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        js: "text/javascript; charset=utf-8",
        json: "application/json; charset=utf-8",
        mjs: "text/javascript; charset=utf-8",
        png: "image/png",
        svg: "image/svg+xml",
        txt: "text/plain; charset=utf-8",
        wasm: "application/wasm",
        webp: "image/webp",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createAppBuildManifest(
  input: Iterable<PortableAppArchiveEntry>,
  entryPath: string,
): AppBuildManifest {
  const entries = normalizeEntries(input, {
    maxFiles: WORKSPACE_APP_BUILD_MAX_FILES,
    maxBytes: WORKSPACE_APP_BUILD_MAX_BYTES,
    maxFileBytes: WORKSPACE_APP_BUILD_FILE_MAX_BYTES,
  });
  const normalizedEntryPath = normalizePortableAppPath(entryPath);
  if (!entries.some((entry) => entry.path === normalizedEntryPath)) {
    throw new Error(`Release entryPath ${normalizedEntryPath} is missing.`);
  }
  return {
    version: "opengeni.app-build.v1",
    entryPath: normalizedEntryPath,
    files: entries.map((entry) => ({
      path: entry.path,
      contentType: contentType(entry.path),
      contentSha256: sha256Hex(entry.bytes),
      sizeBytes: entry.bytes.byteLength,
      executable: Boolean(entry.executable),
    })),
    totalBytes: entries.reduce((total, entry) => total + entry.bytes.byteLength, 0),
  };
}

/** @deprecated Releases promote a verified build; use createAppBuildManifest. */
export const createAppReleaseManifest = createAppBuildManifest;
