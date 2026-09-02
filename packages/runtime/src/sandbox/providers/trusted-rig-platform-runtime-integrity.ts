import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Settings } from "@opengeni/config";

export const TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION = 3 as const;

export type TrustedRigPlatformRuntimePathType =
  | "missing"
  | "file"
  | "directory"
  | "symlink"
  | "other";

export type TrustedRigPlatformRuntimePathMetadata = Readonly<{
  path: string;
  type: TrustedRigPlatformRuntimePathType;
  sizeBytes: number;
  mode: number;
  symlinkTarget: string | null;
}>;

export type TrustedRigPlatformRuntimeManifestEntry = Readonly<{
  path: string;
  resolvedPath: string;
  fileType: "regular";
  mode: number;
  sizeBytes: number;
  sha256: string;
}>;

export type TrustedRigPlatformRuntimeDirectoryInventory = Readonly<{
  path: string;
  entries: readonly string[];
}>;

export type TrustedRigPlatformRuntimeManifest = Readonly<{
  version: typeof TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION;
  digest: string;
  entries: readonly TrustedRigPlatformRuntimeManifestEntry[];
  absentPaths: readonly string[];
  directoryInventories: readonly TrustedRigPlatformRuntimeDirectoryInventory[];
}>;

type ElfRuntimeDependencies = Readonly<{
  machine: number;
  interpreter: string | null;
  needed: readonly string[];
  rpath: readonly string[];
  runpath: readonly string[];
}>;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u;
const SAFE_DIRECTORY_PATH = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+\/?$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._+-]+$/u;
const SAFE_LIBRARY_NAME = /^[A-Za-z0-9._+-]+$/u;
const RUNTIME_PATH_TYPES = new Set<TrustedRigPlatformRuntimePathType>([
  "missing",
  "file",
  "directory",
  "symlink",
  "other",
]);
const MAX_RUNTIME_FILE_BYTES = 512 * 1024 * 1024;
const MAX_RUNTIME_MANIFEST_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RUNTIME_MANIFEST_ENTRIES = 8_192;
const MAX_DIRECTORY_INVENTORY_ENTRIES = 2_048;
const MAX_SYMLINK_DEPTH = 32;
const MAX_ELF_PROGRAM_HEADERS = 1_024;
const MAX_ELF_DYNAMIC_ENTRIES = 65_536;
const MAX_ELF_STRING_BYTES = 1024 * 1024;
const MAX_LOADER_CACHE_ENTRIES = 65_536;
const GLIBC_LOADER_CACHE_MAGIC = new TextEncoder().encode("glibc-ld.so.cache1.1");
const GLIBC_LOADER_CACHE_HEADER_BYTES = 48;
const GLIBC_LOADER_CACHE_ENTRY_BYTES = 24;

const COMMON_RUNTIME_PATHS = Object.freeze([
  "/bin/bash",
  "/bin/sh",
  "/etc/opengeni/browser-engine",
  "/usr/bin/cat",
  "/usr/bin/chmod",
  "/usr/bin/curl",
  "/usr/bin/env",
  "/usr/bin/flock",
  "/usr/bin/id",
  "/usr/bin/install",
  "/usr/bin/mkdir",
  "/usr/bin/setsid",
  "/usr/bin/sleep",
  "/usr/local/bin/opengeni-browserd",
  "/usr/local/bin/opengeni-browserd-down",
  "/usr/local/bin/opengeni-browserd-up",
  "/usr/local/lib/opengeni/agent-browser",
  "/usr/local/lib/opengeni/lightpanda",
  "/usr/local/lib/opengeni/opengeni-computer-native",
] as const);

const TERMINAL_RUNTIME_PATHS = Object.freeze([
  "/usr/local/bin/bun",
  "/usr/local/bin/opengeni-terminal-down",
  "/usr/local/bin/opengeni-terminal-up",
  "/usr/local/bin/ttyd",
] as const);

const DESKTOP_RUNTIME_PATHS = Object.freeze([
  "/opt/noVNC/utils/novnc_proxy",
  "/usr/bin/Xvfb",
  "/usr/bin/dbus-launch",
  "/usr/bin/nc",
  "/usr/bin/scrot",
  "/usr/bin/setxkbmap",
  "/usr/bin/startxfce4",
  "/usr/bin/x11vnc",
  "/usr/bin/xdotool",
  "/usr/bin/xdpyinfo",
  "/usr/local/bin/opengeni-desktop-down",
  "/usr/local/bin/opengeni-desktop-up",
] as const);

const LOADER_CONTROL_FILES = Object.freeze([
  "/etc/ld.so.preload",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
] as const);
const LOADER_CONFIG_DIRECTORY = "/etc/ld.so.conf.d";

function sha256Digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalManifestEntries(entries: readonly TrustedRigPlatformRuntimeManifestEntry[]) {
  return entries.map(({ path, resolvedPath, fileType, mode, sizeBytes, sha256 }) => ({
    path,
    resolvedPath,
    fileType,
    mode,
    sizeBytes,
    sha256,
  }));
}

function canonicalDirectoryInventories(
  inventories: readonly TrustedRigPlatformRuntimeDirectoryInventory[],
) {
  return inventories.map(({ path, entries }) => ({ path, entries: [...entries] }));
}

function manifestDigest(input: {
  entries: readonly TrustedRigPlatformRuntimeManifestEntry[];
  absentPaths: readonly string[];
  directoryInventories: readonly TrustedRigPlatformRuntimeDirectoryInventory[];
}): string {
  return sha256Digest(
    JSON.stringify({
      version: TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION,
      entries: canonicalManifestEntries(input.entries),
      absentPaths: [...input.absentPaths],
      directoryInventories: canonicalDirectoryInventories(input.directoryInventories),
    }),
  );
}

function freezeManifest(input: {
  entries: readonly TrustedRigPlatformRuntimeManifestEntry[];
  absentPaths: readonly string[];
  directoryInventories: readonly TrustedRigPlatformRuntimeDirectoryInventory[];
}): TrustedRigPlatformRuntimeManifest {
  const entries = Object.freeze(
    input.entries.map((entry) => Object.freeze({ ...entry })),
  ) as readonly TrustedRigPlatformRuntimeManifestEntry[];
  const absentPaths = Object.freeze([...input.absentPaths]);
  const directoryInventories = Object.freeze(
    input.directoryInventories.map((inventory) =>
      Object.freeze({ path: inventory.path, entries: Object.freeze([...inventory.entries]) }),
    ),
  ) as readonly TrustedRigPlatformRuntimeDirectoryInventory[];
  return Object.freeze({
    version: TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION,
    digest: manifestDigest({ entries, absentPaths, directoryInventories }),
    entries,
    absentPaths,
    directoryInventories,
  });
}

function browserEnginePath(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (!SAFE_ABSOLUTE_PATH.test(text) || text.includes("/../") || text.endsWith("/..")) {
    throw new Error("trusted Rig platform browser engine path is not a safe absolute file");
  }
  return text;
}

function configuredRuntimePaths(settings: Settings): string[] {
  return [
    ...COMMON_RUNTIME_PATHS,
    ...(settings.sandboxTerminalEnabled ? TERMINAL_RUNTIME_PATHS : []),
    ...(settings.sandboxDesktopEnabled ? DESKTOP_RUNTIME_PATHS : []),
  ];
}

function pathComponents(path: string): string[] {
  const segments = path.slice(1).split("/");
  return segments.map((_segment, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

function safeAbsolutePath(path: string, label: string): string {
  const normalized = posix.normalize(path);
  if (
    normalized !== path ||
    !SAFE_ABSOLUTE_PATH.test(path) ||
    path.includes("/../") ||
    path.endsWith("/..")
  ) {
    throw new Error(`trusted Rig platform ${label} is not a safe absolute path: ${path}`);
  }
  return path;
}

function assertPathMetadata(
  metadata: TrustedRigPlatformRuntimePathMetadata,
  expectedPath: string,
): void {
  if (
    !metadata ||
    metadata.path !== expectedPath ||
    !RUNTIME_PATH_TYPES.has(metadata.type) ||
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes < 0 ||
    !Number.isSafeInteger(metadata.mode) ||
    metadata.mode < 0 ||
    metadata.mode > 0xffff_ffff ||
    (metadata.symlinkTarget !== null && typeof metadata.symlinkTarget !== "string") ||
    (metadata.type === "symlink" ? !metadata.symlinkTarget : metadata.symlinkTarget !== null) ||
    (metadata.type === "missing" && (metadata.sizeBytes !== 0 || metadata.mode !== 0))
  ) {
    throw new Error(`trusted Rig platform provider returned invalid metadata for ${expectedPath}`);
  }
}

function samePathMetadata(
  left: TrustedRigPlatformRuntimePathMetadata,
  right: TrustedRigPlatformRuntimePathMetadata,
): boolean {
  return (
    left.path === right.path &&
    left.type === right.type &&
    left.sizeBytes === right.sizeBytes &&
    left.mode === right.mode &&
    left.symlinkTarget === right.symlinkTarget
  );
}

async function inspectRegularRuntimePath(input: {
  path: string;
  inspectPath(path: string): Promise<TrustedRigPlatformRuntimePathMetadata>;
  signal?: AbortSignal;
}): Promise<TrustedRigPlatformRuntimePathMetadata[]> {
  const components = pathComponents(input.path);
  const inspected: TrustedRigPlatformRuntimePathMetadata[] = [];
  for (const [index, component] of components.entries()) {
    input.signal?.throwIfAborted();
    const metadata = await input.inspectPath(component);
    input.signal?.throwIfAborted();
    assertPathMetadata(metadata, component);
    const leaf = index === components.length - 1;
    if (!leaf && metadata.type !== "directory") {
      throw new Error(
        `trusted Rig platform runtime path component must be a real directory: ${component}`,
      );
    }
    if (leaf && metadata.type !== "file") {
      throw new Error(
        `trusted Rig platform runtime path must be a regular non-symlink file: ${input.path}`,
      );
    }
    inspected.push(metadata);
  }
  return inspected;
}

async function inspectOptionalStrictPath(input: {
  path: string;
  expectedType: "file" | "directory";
  inspectPath(path: string): Promise<TrustedRigPlatformRuntimePathMetadata>;
  signal?: AbortSignal;
}): Promise<TrustedRigPlatformRuntimePathMetadata[] | null> {
  const components = pathComponents(input.path);
  const inspected: TrustedRigPlatformRuntimePathMetadata[] = [];
  for (const [index, component] of components.entries()) {
    input.signal?.throwIfAborted();
    const metadata = await input.inspectPath(component);
    input.signal?.throwIfAborted();
    assertPathMetadata(metadata, component);
    const leaf = index === components.length - 1;
    if (leaf && metadata.type === "missing") return null;
    if (!leaf && metadata.type !== "directory") {
      throw new Error(
        `trusted Rig platform runtime path component must be a real directory: ${component}`,
      );
    }
    if (leaf && metadata.type !== input.expectedType) {
      throw new Error(
        `trusted Rig platform loader input must be a regular non-symlink ${input.expectedType}: ${input.path}`,
      );
    }
    inspected.push(metadata);
  }
  return inspected;
}

function resolveSymlinkTarget(path: string, target: string): string {
  const resolved = target.startsWith("/")
    ? posix.normalize(target)
    : posix.resolve(posix.dirname(path), target);
  return safeAbsolutePath(resolved, "runtime symlink target");
}

async function inspectResolvedRegularRuntimePath(input: {
  path: string;
  inspectPath(path: string): Promise<TrustedRigPlatformRuntimePathMetadata>;
  signal?: AbortSignal;
}): Promise<{
  resolvedPath: string;
  inspected: TrustedRigPlatformRuntimePathMetadata[];
} | null> {
  safeAbsolutePath(input.path, "runtime dependency");
  let pending = pathComponents(input.path);
  const inspected: TrustedRigPlatformRuntimePathMetadata[] = [];
  const seenLinks = new Set<string>();
  let depth = 0;
  while (pending.length > 0) {
    const component = pending.shift()!;
    input.signal?.throwIfAborted();
    const metadata = await input.inspectPath(component);
    input.signal?.throwIfAborted();
    assertPathMetadata(metadata, component);
    if (metadata.type === "missing") return null;
    const leaf = pending.length === 0;
    if (metadata.type === "symlink") {
      if (seenLinks.has(component) || depth >= MAX_SYMLINK_DEPTH) {
        throw new Error(`trusted Rig platform runtime symlink cycle at ${component}`);
      }
      seenLinks.add(component);
      depth += 1;
      const target = resolveSymlinkTarget(component, metadata.symlinkTarget!);
      const suffix = pending.map((part) => part.slice(part.lastIndexOf("/") + 1));
      const combined = suffix.length > 0 ? posix.join(target, ...suffix) : target;
      pending = pathComponents(safeAbsolutePath(combined, "runtime symlink resolution"));
      inspected.push(metadata);
      continue;
    }
    if (!leaf && metadata.type !== "directory") {
      throw new Error(
        `trusted Rig platform runtime dependency component is not a directory: ${component}`,
      );
    }
    if (leaf && metadata.type !== "file") {
      throw new Error(
        `trusted Rig platform runtime dependency must resolve to a regular file: ${input.path}`,
      );
    }
    inspected.push(metadata);
    if (leaf) return { resolvedPath: component, inspected };
  }
  throw new Error(`trusted Rig platform runtime dependency did not resolve: ${input.path}`);
}

function readUnsigned(
  view: DataView,
  offset: number,
  size: 2 | 4 | 8,
  littleEndian: boolean,
): number {
  if (offset < 0 || offset + size > view.byteLength) throw new Error("ELF field is out of bounds");
  if (size === 2) return view.getUint16(offset, littleEndian);
  if (size === 4) return view.getUint32(offset, littleEndian);
  const value = view.getBigUint64(offset, littleEndian);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("ELF field exceeds safe integer range");
  return Number(value);
}

function readSignedTag(view: DataView, offset: number, size: 4 | 8, littleEndian: boolean): number {
  if (offset < 0 || offset + size > view.byteLength) throw new Error("ELF tag is out of bounds");
  if (size === 4) return view.getInt32(offset, littleEndian);
  const value = view.getBigInt64(offset, littleEndian);
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("ELF tag exceeds safe integer range");
  }
  return Number(value);
}

function boundedCString(bytes: Uint8Array, offset: number, limit: number): string {
  if (offset < 0 || offset >= bytes.byteLength || limit < 1) {
    throw new Error("ELF string offset is invalid");
  }
  const endLimit = Math.min(bytes.byteLength, offset + limit);
  let end = offset;
  while (end < endLimit && bytes[end] !== 0) end += 1;
  if (end === endLimit) throw new Error("ELF string is unterminated");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
}

export function parseTrustedRigPlatformElfDependencies(
  bytes: Uint8Array,
): ElfRuntimeDependencies | null {
  if (
    bytes.byteLength < 16 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46
  ) {
    return null;
  }
  const elfClass = bytes[4];
  const encoding = bytes[5];
  if ((elfClass !== 1 && elfClass !== 2) || (encoding !== 1 && encoding !== 2)) {
    throw new Error("trusted Rig platform runtime contains an unsupported ELF encoding");
  }
  const littleEndian = encoding === 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const is64 = elfClass === 2;
  const machine = readUnsigned(view, 18, 2, littleEndian);
  const programHeaderOffset = readUnsigned(view, is64 ? 32 : 28, is64 ? 8 : 4, littleEndian);
  const programHeaderEntrySize = readUnsigned(view, is64 ? 54 : 42, 2, littleEndian);
  const programHeaderCount = readUnsigned(view, is64 ? 56 : 44, 2, littleEndian);
  const minimumProgramHeaderSize = is64 ? 56 : 32;
  if (
    programHeaderEntrySize < minimumProgramHeaderSize ||
    programHeaderCount > MAX_ELF_PROGRAM_HEADERS ||
    programHeaderOffset + programHeaderEntrySize * programHeaderCount > bytes.byteLength
  ) {
    throw new Error("trusted Rig platform runtime contains malformed ELF program headers");
  }
  const loads: Array<{ offset: number; virtualAddress: number; fileSize: number }> = [];
  let interpreter: string | null = null;
  let dynamic: { offset: number; fileSize: number } | null = null;
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderEntrySize;
    const type = readUnsigned(view, offset, 4, littleEndian);
    const fileOffset = readUnsigned(view, offset + (is64 ? 8 : 4), is64 ? 8 : 4, littleEndian);
    const virtualAddress = readUnsigned(view, offset + (is64 ? 16 : 8), is64 ? 8 : 4, littleEndian);
    const fileSize = readUnsigned(view, offset + (is64 ? 32 : 16), is64 ? 8 : 4, littleEndian);
    if (fileOffset + fileSize > bytes.byteLength) {
      throw new Error("trusted Rig platform runtime contains an out-of-bounds ELF segment");
    }
    if (type === 1) loads.push({ offset: fileOffset, virtualAddress, fileSize });
    if (type === 2) dynamic = { offset: fileOffset, fileSize };
    if (type === 3) {
      if (fileSize < 2 || fileSize > 4096) {
        throw new Error("trusted Rig platform runtime contains an invalid ELF interpreter");
      }
      interpreter = boundedCString(bytes, fileOffset, fileSize);
      safeAbsolutePath(interpreter, "ELF interpreter");
    }
  }
  if (!dynamic) return { machine, interpreter, needed: [], rpath: [], runpath: [] };
  const dynamicEntrySize = is64 ? 16 : 8;
  if (dynamic.fileSize % dynamicEntrySize !== 0) {
    throw new Error("trusted Rig platform runtime contains a malformed ELF dynamic table");
  }
  const dynamicEntryCount = dynamic.fileSize / dynamicEntrySize;
  if (dynamicEntryCount > MAX_ELF_DYNAMIC_ENTRIES) {
    throw new Error("trusted Rig platform runtime ELF dynamic table is too large");
  }
  let stringTableAddress: number | null = null;
  let stringTableSize: number | null = null;
  const neededOffsets: number[] = [];
  const rpathOffsets: number[] = [];
  const runpathOffsets: number[] = [];
  for (let index = 0; index < dynamicEntryCount; index += 1) {
    const offset = dynamic.offset + index * dynamicEntrySize;
    const tag = readSignedTag(view, offset, is64 ? 8 : 4, littleEndian);
    const value = readUnsigned(view, offset + (is64 ? 8 : 4), is64 ? 8 : 4, littleEndian);
    if (tag === 0) break;
    if (
      tag === 1 ||
      tag === 0x6fff_fefb ||
      tag === 0x6fff_fefc ||
      tag === 0x7fff_fffd ||
      tag === 0x7fff_ffff
    ) {
      neededOffsets.push(value);
    } else if (tag === 5) stringTableAddress = value;
    else if (tag === 10) stringTableSize = value;
    else if (tag === 15) rpathOffsets.push(value);
    else if (tag === 29) runpathOffsets.push(value);
  }
  if (
    (neededOffsets.length > 0 || rpathOffsets.length > 0 || runpathOffsets.length > 0) &&
    (stringTableAddress === null || stringTableSize === null)
  ) {
    throw new Error("trusted Rig platform runtime ELF dynamic strings are missing");
  }
  if (stringTableAddress === null || stringTableSize === null) {
    return { machine, interpreter, needed: [], rpath: [], runpath: [] };
  }
  if (stringTableSize < 1 || stringTableSize > MAX_ELF_STRING_BYTES) {
    throw new Error("trusted Rig platform runtime ELF string table is invalid");
  }
  const load = loads.find(
    (segment) =>
      stringTableAddress! >= segment.virtualAddress &&
      stringTableAddress! + stringTableSize! <= segment.virtualAddress + segment.fileSize,
  );
  if (!load) throw new Error("trusted Rig platform runtime ELF string table is not file-backed");
  const stringTableOffset = load.offset + (stringTableAddress - load.virtualAddress);
  const strings = (offsets: readonly number[]): string[] =>
    offsets.map((offset) => {
      if (offset >= stringTableSize) throw new Error("ELF dynamic string is out of bounds");
      return boundedCString(bytes, stringTableOffset + offset, stringTableSize - offset);
    });
  const splitPaths = (offsets: readonly number[]): string[] =>
    strings(offsets).flatMap((value) => value.split(":"));
  const needed = strings(neededOffsets);
  if (needed.some((name) => !SAFE_LIBRARY_NAME.test(name) && !name.includes("/"))) {
    throw new Error("trusted Rig platform runtime ELF dependency name is invalid");
  }
  return {
    machine,
    interpreter,
    needed,
    rpath: splitPaths(rpathOffsets),
    runpath: splitPaths(runpathOffsets),
  };
}

function parseLoaderCache(bytes: Uint8Array): ReadonlyMap<string, readonly string[]> {
  if (
    bytes.byteLength < GLIBC_LOADER_CACHE_HEADER_BYTES ||
    GLIBC_LOADER_CACHE_MAGIC.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new Error("trusted Rig platform loader cache uses an unsupported format");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const layout = [true, false]
    .map((littleEndian) => {
      const entryCount = view.getUint32(20, littleEndian);
      const stringBytes = view.getUint32(24, littleEndian);
      const entriesEnd =
        GLIBC_LOADER_CACHE_HEADER_BYTES + entryCount * GLIBC_LOADER_CACHE_ENTRY_BYTES;
      const stringsEnd = entriesEnd + stringBytes;
      return { littleEndian, entryCount, entriesEnd, stringsEnd };
    })
    .find(
      ({ entryCount, entriesEnd, stringsEnd }) =>
        entryCount <= MAX_LOADER_CACHE_ENTRIES &&
        entriesEnd >= GLIBC_LOADER_CACHE_HEADER_BYTES &&
        entriesEnd <= bytes.byteLength &&
        stringsEnd >= entriesEnd &&
        stringsEnd <= bytes.byteLength,
    );
  if (!layout) throw new Error("trusted Rig platform loader cache is malformed");

  const paths = new Map<string, string[]>();
  for (let index = 0; index < layout.entryCount; index += 1) {
    const offset = GLIBC_LOADER_CACHE_HEADER_BYTES + index * GLIBC_LOADER_CACHE_ENTRY_BYTES;
    const keyOffset = view.getUint32(offset + 4, layout.littleEndian);
    const valueOffset = view.getUint32(offset + 8, layout.littleEndian);
    if (
      keyOffset < layout.entriesEnd ||
      keyOffset >= layout.stringsEnd ||
      valueOffset < layout.entriesEnd ||
      valueOffset >= layout.stringsEnd
    ) {
      throw new Error("trusted Rig platform loader cache contains an invalid string offset");
    }
    const key = boundedCString(bytes, keyOffset, layout.stringsEnd - keyOffset);
    const value = boundedCString(bytes, valueOffset, layout.stringsEnd - valueOffset);
    if (!SAFE_LIBRARY_NAME.test(key)) {
      throw new Error(`trusted Rig platform loader cache contains an invalid library name: ${key}`);
    }
    const path = safeAbsolutePath(value, "loader cache path");
    const existing = paths.get(key);
    if (existing) {
      if (!existing.includes(path)) existing.push(path);
    } else {
      paths.set(key, [path]);
    }
  }
  return paths;
}

function loaderArchitectureDirectories(machine: number): string[] {
  if (machine === 62)
    return ["/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib64", "/usr/lib64"];
  if (machine === 183)
    return ["/lib/aarch64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib64", "/usr/lib64"];
  if (machine === 3)
    return ["/lib/i386-linux-gnu", "/usr/lib/i386-linux-gnu", "/lib32", "/usr/lib32"];
  if (machine === 40) return ["/lib/arm-linux-gnueabihf", "/usr/lib/arm-linux-gnueabihf"];
  return [];
}

function parseLoaderConfiguration(path: string, bytes: Uint8Array): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`trusted Rig platform loader configuration is not UTF-8: ${path}`);
  }
  const directories: string[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*/u, "").trim();
    if (!line) continue;
    if (line.startsWith("include ")) {
      const pattern = line.slice("include ".length).trim();
      if (
        pattern !== `${LOADER_CONFIG_DIRECTORY}/*.conf` &&
        pattern !== `${LOADER_CONFIG_DIRECTORY}/*`
      ) {
        throw new Error(
          `trusted Rig platform loader configuration uses an unsupported include: ${pattern}`,
        );
      }
      continue;
    }
    if (!SAFE_DIRECTORY_PATH.test(line) || line.includes("/../") || line.endsWith("/..")) {
      throw new Error(
        `trusted Rig platform loader configuration contains an unsafe directory: ${line}`,
      );
    }
    directories.push(line.endsWith("/") ? line.slice(0, -1) : line);
  }
  return directories;
}

function parseLoaderPreload(bytes: Uint8Array): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("trusted Rig platform loader preload configuration is not UTF-8");
  }
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/#.*/u, ""))
    .join(" ")
    .split(/\s+/u)
    .filter(Boolean);
}

function expandLoaderPath(value: string, origin: string, machine: number): string {
  const lib = machine === 62 || machine === 183 ? "lib64" : "lib";
  const expanded = value
    .replaceAll("${ORIGIN}", origin)
    .replaceAll("$ORIGIN", origin)
    .replaceAll("${LIB}", lib)
    .replaceAll("$LIB", lib);
  if (expanded.includes("$")) {
    throw new Error(`trusted Rig platform ELF loader path uses an unsupported token: ${value}`);
  }
  if (!expanded.startsWith("/")) {
    throw new Error(
      `trusted Rig platform ELF loader path depends on the process working directory: ${value}`,
    );
  }
  return safeAbsolutePath(posix.normalize(expanded), "ELF loader search path");
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Capture deployment-owned helper/runtime bytes and the loader inputs that can
 * change how those exact bytes execute, without invoking candidate code. The
 * selected platform entrypoints remain strict regular files with real
 * directory parents. ELF interpreter/dependency symlinks are instead resolved
 * through provider metadata and bound to their exact regular target.
 */
export async function captureTrustedRigPlatformRuntimeManifest(input: {
  settings: Settings;
  inspectPath(path: string): Promise<TrustedRigPlatformRuntimePathMetadata>;
  readBytes(path: string): Promise<Uint8Array>;
  listDirectory?(path: string): Promise<readonly string[]>;
  signal?: AbortSignal;
}): Promise<TrustedRigPlatformRuntimeManifest> {
  const contents = new Map<
    string,
    {
      bytes: Uint8Array;
      metadata: TrustedRigPlatformRuntimePathMetadata;
      resolvedPath: string;
    }
  >();
  const absentPaths = new Set<string>();
  const directoryInventories = new Map<string, readonly string[]>();
  let totalBytes = 0;

  const retain = (
    path: string,
    resolvedPath: string,
    metadata: TrustedRigPlatformRuntimePathMetadata,
    bytes: Uint8Array,
  ): Uint8Array => {
    if (bytes.byteLength !== metadata.sizeBytes) {
      throw new Error(`trusted Rig platform runtime path changed while it was read: ${path}`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RUNTIME_MANIFEST_BYTES) {
      throw new Error("trusted Rig platform runtime manifest exceeds its byte budget");
    }
    contents.set(path, { bytes, metadata, resolvedPath });
    if (contents.size > MAX_RUNTIME_MANIFEST_ENTRIES) {
      throw new Error("trusted Rig platform runtime manifest has too many entries");
    }
    return bytes;
  };

  const readStrict = async (path: string): Promise<Uint8Array> => {
    const existing = contents.get(path);
    if (existing) return existing.bytes;
    input.signal?.throwIfAborted();
    const before = await inspectRegularRuntimePath({
      path,
      inspectPath: input.inspectPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const leaf = before.at(-1)!;
    if (leaf.sizeBytes > MAX_RUNTIME_FILE_BYTES) {
      throw new Error(`trusted Rig platform runtime file is too large: ${path}`);
    }
    const bytes = await input.readBytes(path);
    input.signal?.throwIfAborted();
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`trusted Rig platform reader returned non-bytes for ${path}`);
    }
    const after = await inspectRegularRuntimePath({
      path,
      inspectPath: input.inspectPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      before.length !== after.length ||
      before.some((metadata, index) => !samePathMetadata(metadata, after[index]!))
    ) {
      throw new Error(`trusted Rig platform runtime path changed while it was read: ${path}`);
    }
    return retain(path, path, leaf, bytes);
  };

  const readOptionalStrict = async (path: string): Promise<Uint8Array | null> => {
    const before = await inspectOptionalStrictPath({
      path,
      expectedType: "file",
      inspectPath: input.inspectPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!before) {
      absentPaths.add(path);
      return null;
    }
    const leaf = before.at(-1)!;
    if (leaf.sizeBytes > MAX_RUNTIME_FILE_BYTES) {
      throw new Error(`trusted Rig platform runtime file is too large: ${path}`);
    }
    const bytes = await input.readBytes(path);
    input.signal?.throwIfAborted();
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`trusted Rig platform reader returned non-bytes for ${path}`);
    }
    const after = await inspectOptionalStrictPath({
      path,
      expectedType: "file",
      inspectPath: input.inspectPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      !after ||
      before.length !== after.length ||
      before.some((metadata, index) => !samePathMetadata(metadata, after[index]!))
    ) {
      throw new Error(`trusted Rig platform runtime path changed while it was read: ${path}`);
    }
    return retain(path, path, leaf, bytes);
  };

  const readResolved = async (path: string): Promise<Uint8Array | null> => {
    const existing = contents.get(path);
    if (existing) return existing.bytes;
    const before = await inspectResolvedRegularRuntimePath({
      path,
      inspectPath: input.inspectPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!before) return null;
    const leaf = before.inspected.at(-1)!;
    if (leaf.sizeBytes > MAX_RUNTIME_FILE_BYTES) {
      throw new Error(`trusted Rig platform runtime file is too large: ${path}`);
    }
    const bytes = await input.readBytes(before.resolvedPath);
    input.signal?.throwIfAborted();
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`trusted Rig platform reader returned non-bytes for ${path}`);
    }
    const after = await inspectResolvedRegularRuntimePath({
      path,
      inspectPath: input.inspectPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      !after ||
      before.resolvedPath !== after.resolvedPath ||
      before.inspected.length !== after.inspected.length ||
      before.inspected.some(
        (metadata, index) => !samePathMetadata(metadata, after.inspected[index]!),
      )
    ) {
      throw new Error(`trusted Rig platform runtime dependency changed while it was read: ${path}`);
    }
    return retain(path, before.resolvedPath, leaf, bytes);
  };

  const inventoryDirectory = async (path: string): Promise<readonly string[] | null> => {
    const before = await inspectOptionalStrictPath({
      path,
      expectedType: "directory",
      inspectPath: input.inspectPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!before) {
      absentPaths.add(path);
      return null;
    }
    if (!input.listDirectory) {
      throw new Error(`trusted Rig platform provider cannot inventory loader directory ${path}`);
    }
    const listed = await input.listDirectory(path);
    input.signal?.throwIfAborted();
    if (!Array.isArray(listed) || listed.length > MAX_DIRECTORY_INVENTORY_ENTRIES) {
      throw new Error(
        `trusted Rig platform provider returned an invalid directory inventory for ${path}`,
      );
    }
    const entries = [...listed];
    if (
      entries.some((entry) => typeof entry !== "string" || !SAFE_PATH_SEGMENT.test(entry)) ||
      new Set(entries).size !== entries.length
    ) {
      throw new Error(
        `trusted Rig platform provider returned an invalid directory inventory for ${path}`,
      );
    }
    entries.sort();
    const after = await inspectOptionalStrictPath({
      path,
      expectedType: "directory",
      inspectPath: input.inspectPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      !after ||
      before.length !== after.length ||
      before.some((metadata, index) => !samePathMetadata(metadata, after[index]!))
    ) {
      throw new Error(`trusted Rig platform loader directory changed while it was listed: ${path}`);
    }
    directoryInventories.set(path, Object.freeze(entries));
    return entries;
  };

  for (const path of configuredRuntimePaths(input.settings)) await readStrict(path);
  const enginePath = browserEnginePath(contents.get("/etc/opengeni/browser-engine")!.bytes);
  if (!contents.has(enginePath)) await readStrict(enginePath);

  const loaderControlBytes = new Map<string, Uint8Array>();
  for (const path of LOADER_CONTROL_FILES) {
    const bytes = await readOptionalStrict(path);
    if (bytes) loaderControlBytes.set(path, bytes);
  }
  const loaderConfigPaths: string[] = [];
  const loaderConfigNames = await inventoryDirectory(LOADER_CONFIG_DIRECTORY);
  for (const name of loaderConfigNames ?? []) {
    const path = `${LOADER_CONFIG_DIRECTORY}/${name}`;
    const bytes = await readStrict(path);
    loaderControlBytes.set(path, bytes);
    loaderConfigPaths.push(path);
  }

  const configuredLoaderDirectories = uniquePaths(
    [...loaderControlBytes.entries()]
      .filter(([path]) => path === "/etc/ld.so.conf" || loaderConfigPaths.includes(path))
      .flatMap(([path, bytes]) => parseLoaderConfiguration(path, bytes)),
  );
  const preloadEntries = loaderControlBytes.has("/etc/ld.so.preload")
    ? parseLoaderPreload(loaderControlBytes.get("/etc/ld.so.preload")!)
    : [];
  const loaderCache = loaderControlBytes.has("/etc/ld.so.cache")
    ? parseLoaderCache(loaderControlBytes.get("/etc/ld.so.cache")!)
    : new Map<string, readonly string[]>();

  const queue: string[] = [...contents.keys()];
  const queued = new Set(queue);
  for (const preload of preloadEntries) {
    if (preload.startsWith("/")) {
      const path = safeAbsolutePath(posix.normalize(preload), "loader preload path");
      if (!queued.has(path)) {
        queued.add(path);
        queue.push(path);
      }
    } else if (!SAFE_LIBRARY_NAME.test(preload)) {
      throw new Error(`trusted Rig platform loader preload entry is invalid: ${preload}`);
    }
  }

  const parsedResolvedPaths = new Set<string>();
  const resolvedNamedPreloads = new Set<string>();
  const enqueueExistingDependency = async (path: string): Promise<boolean> => {
    const resolved = await inspectResolvedRegularRuntimePath({
      path,
      inspectPath: input.inspectPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!resolved) return false;
    if (!queued.has(path)) {
      queued.add(path);
      queue.push(path);
    }
    return true;
  };
  const enqueueFirstExistingDependency = async (
    directories: readonly string[],
    name: string,
    label: string,
  ): Promise<boolean> => {
    for (const directory of uniquePaths(directories)) {
      const candidate = safeAbsolutePath(posix.join(directory, name), label);
      if (await enqueueExistingDependency(candidate)) return true;
    }
    return false;
  };
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index]!;
    let stored = contents.get(path);
    if (!stored) {
      const bytes = await readResolved(path);
      if (!bytes) throw new Error(`trusted Rig platform runtime dependency is missing: ${path}`);
      stored = contents.get(path)!;
    }
    if (parsedResolvedPaths.has(stored.resolvedPath)) continue;
    parsedResolvedPaths.add(stored.resolvedPath);
    const elf = parseTrustedRigPlatformElfDependencies(stored.bytes);
    if (!elf) continue;
    if (elf.interpreter && !queued.has(elf.interpreter)) {
      queued.add(elf.interpreter);
      queue.push(elf.interpreter);
    }
    const origin = posix.dirname(stored.resolvedPath);
    const objectDirectories = (elf.runpath.length > 0 ? elf.runpath : elf.rpath).map((entry) =>
      expandLoaderPath(entry, origin, elf.machine),
    );
    const fallbackDirectories = [
      ...configuredLoaderDirectories,
      ...loaderArchitectureDirectories(elf.machine),
      "/lib",
      "/usr/lib",
    ];
    for (const needed of elf.needed) {
      if (needed.includes("/")) {
        if (!needed.startsWith("/")) {
          throw new Error(
            `trusted Rig platform ELF dependency depends on the process working directory: ${needed}`,
          );
        }
        const directPath = safeAbsolutePath(posix.normalize(needed), "ELF dependency path");
        if (!queued.has(directPath)) {
          queued.add(directPath);
          queue.push(directPath);
        }
        continue;
      }
      let found = await enqueueFirstExistingDependency(
        objectDirectories,
        needed,
        "ELF dependency path",
      );
      if (!found) {
        for (const cachePath of loaderCache.get(needed) ?? []) {
          found = (await enqueueExistingDependency(cachePath)) || found;
        }
      }
      if (!found) {
        found = await enqueueFirstExistingDependency(
          fallbackDirectories,
          needed,
          "ELF dependency path",
        );
      }
      if (!found) {
        throw new Error(`trusted Rig platform ELF dependency could not be resolved: ${needed}`);
      }
    }
    for (const preload of preloadEntries) {
      const preloadMachineKey = `${elf.machine}:${preload}`;
      if (preload.startsWith("/") || resolvedNamedPreloads.has(preloadMachineKey)) continue;
      let found = false;
      for (const cachePath of loaderCache.get(preload) ?? []) {
        found = (await enqueueExistingDependency(cachePath)) || found;
      }
      if (!found) {
        found = await enqueueFirstExistingDependency(
          fallbackDirectories,
          preload,
          "loader preload path",
        );
      }
      if (!found) {
        throw new Error(`trusted Rig platform loader preload dependency is missing: ${preload}`);
      }
      resolvedNamedPreloads.add(preloadMachineKey);
    }
  }

  for (const [path, expectedEntries] of directoryInventories) {
    input.signal?.throwIfAborted();
    const listed = await input.listDirectory!(path);
    input.signal?.throwIfAborted();
    if (!Array.isArray(listed) || listed.length > MAX_DIRECTORY_INVENTORY_ENTRIES) {
      throw new Error(
        `trusted Rig platform provider returned an invalid directory inventory for ${path}`,
      );
    }
    const actualEntries = [...listed].sort();
    if (
      actualEntries.some((entry) => typeof entry !== "string" || !SAFE_PATH_SEGMENT.test(entry)) ||
      new Set(actualEntries).size !== actualEntries.length ||
      actualEntries.length !== expectedEntries.length ||
      actualEntries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      throw new Error(
        `trusted Rig platform loader directory changed while it was captured: ${path}`,
      );
    }
  }

  const entries = [...contents.entries()]
    .map(([path, { bytes, metadata, resolvedPath }]) => ({
      path,
      resolvedPath,
      fileType: "regular" as const,
      mode: metadata.mode,
      sizeBytes: bytes.byteLength,
      sha256: sha256Digest(bytes),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return freezeManifest({
    entries,
    absentPaths: [...absentPaths].sort(),
    directoryInventories: [...directoryInventories.entries()]
      .map(([path, inventoryEntries]) => ({ path, entries: inventoryEntries }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  });
}

export function assertTrustedRigPlatformRuntimeManifest(
  manifest: TrustedRigPlatformRuntimeManifest,
): void {
  if (
    manifest.version !== TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION ||
    !SHA256.test(manifest.digest) ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    !Array.isArray(manifest.absentPaths) ||
    !Array.isArray(manifest.directoryInventories)
  ) {
    throw new Error("trusted Rig platform runtime manifest is invalid");
  }
  let previousPath = "";
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    if (
      !SAFE_ABSOLUTE_PATH.test(entry.path) ||
      entry.path <= previousPath ||
      !SAFE_ABSOLUTE_PATH.test(entry.resolvedPath) ||
      entry.fileType !== "regular" ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0xffff_ffff ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      entry.sizeBytes > MAX_RUNTIME_FILE_BYTES ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error("trusted Rig platform runtime manifest is invalid");
    }
    previousPath = entry.path;
    totalBytes += entry.sizeBytes;
  }
  previousPath = "";
  const entryPaths = new Set(manifest.entries.map((entry) => entry.path));
  for (const path of manifest.absentPaths) {
    if (!SAFE_ABSOLUTE_PATH.test(path) || path <= previousPath || entryPaths.has(path)) {
      throw new Error("trusted Rig platform runtime manifest is invalid");
    }
    previousPath = path;
  }
  previousPath = "";
  for (const inventory of manifest.directoryInventories) {
    if (
      !SAFE_ABSOLUTE_PATH.test(inventory.path) ||
      inventory.path <= previousPath ||
      !Array.isArray(inventory.entries) ||
      inventory.entries.length > MAX_DIRECTORY_INVENTORY_ENTRIES ||
      inventory.entries.some(
        (entry: string, index: number) =>
          !SAFE_PATH_SEGMENT.test(entry) || (index > 0 && entry <= inventory.entries[index - 1]!),
      )
    ) {
      throw new Error("trusted Rig platform runtime manifest is invalid");
    }
    previousPath = inventory.path;
  }
  if (
    manifest.entries.length > MAX_RUNTIME_MANIFEST_ENTRIES ||
    totalBytes > MAX_RUNTIME_MANIFEST_BYTES ||
    manifestDigest(manifest) !== manifest.digest
  ) {
    throw new Error("trusted Rig platform runtime manifest is invalid");
  }
}

function runtimeManifestFactMap(manifest: TrustedRigPlatformRuntimeManifest): Map<string, string> {
  return new Map([
    ...manifest.entries.map(
      (entry) =>
        [
          entry.path,
          JSON.stringify({
            resolvedPath: entry.resolvedPath,
            fileType: entry.fileType,
            mode: entry.mode,
            sizeBytes: entry.sizeBytes,
            sha256: entry.sha256,
          }),
        ] as const,
    ),
    ...manifest.absentPaths.map((path) => [path, "absent"] as const),
    ...manifest.directoryInventories.map(
      (inventory) =>
        [inventory.path, JSON.stringify({ directoryEntries: inventory.entries })] as const,
    ),
  ]);
}

export function assertTrustedRigPlatformRuntimeMatches(
  expected: TrustedRigPlatformRuntimeManifest,
  actual: TrustedRigPlatformRuntimeManifest,
): void {
  assertTrustedRigPlatformRuntimeManifest(expected);
  assertTrustedRigPlatformRuntimeManifest(actual);
  if (expected.digest === actual.digest) return;

  const expectedFacts = runtimeManifestFactMap(expected);
  const actualFacts = runtimeManifestFactMap(actual);
  const changedPath = [...new Set([...expectedFacts.keys(), ...actualFacts.keys()])]
    .sort()
    .find((path) => expectedFacts.get(path) !== actualFacts.get(path));
  throw new Error(
    `trusted Rig platform runtime integrity mismatch${changedPath ? ` at ${changedPath}` : ""}; derived provider image changed deployment-owned helper/runtime or loader-closure bytes`,
  );
}
