import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";

export const TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION = 2 as const;

export type TrustedRigPlatformRuntimePathType = "file" | "directory" | "symlink" | "other";

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

export type TrustedRigPlatformRuntimeManifest = Readonly<{
  version: typeof TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION;
  digest: string;
  entries: readonly TrustedRigPlatformRuntimeManifestEntry[];
}>;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u;
const RUNTIME_PATH_TYPES = new Set<TrustedRigPlatformRuntimePathType>([
  "file",
  "directory",
  "symlink",
  "other",
]);
const MAX_RUNTIME_FILE_BYTES = 512 * 1024 * 1024;
const MAX_RUNTIME_MANIFEST_BYTES = 2 * 1024 * 1024 * 1024;

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

function manifestDigest(entries: readonly TrustedRigPlatformRuntimeManifestEntry[]): string {
  return sha256Digest(
    JSON.stringify({
      version: TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION,
      entries: canonicalManifestEntries(entries),
    }),
  );
}

function freezeManifest(
  entries: readonly TrustedRigPlatformRuntimeManifestEntry[],
): TrustedRigPlatformRuntimeManifest {
  const frozenEntries = Object.freeze(
    entries.map((entry) => Object.freeze({ ...entry })),
  ) as readonly TrustedRigPlatformRuntimeManifestEntry[];
  return Object.freeze({
    version: TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION,
    digest: manifestDigest(frozenEntries),
    entries: frozenEntries,
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
    (metadata.type === "symlink" ? !metadata.symlinkTarget : metadata.symlinkTarget !== null)
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

/**
 * Capture deployment-owned helper/runtime bytes and provider-backed metadata
 * without invoking candidate shell code. Every path component is checked so a
 * symlinked parent cannot redirect a protected leaf into mutable workspace
 * state. Metadata is checked again after each read to fail closed on rebinding.
 */
export async function captureTrustedRigPlatformRuntimeManifest(input: {
  settings: Settings;
  inspectPath(path: string): Promise<TrustedRigPlatformRuntimePathMetadata>;
  readBytes(path: string): Promise<Uint8Array>;
  signal?: AbortSignal;
}): Promise<TrustedRigPlatformRuntimeManifest> {
  const paths = configuredRuntimePaths(input.settings);
  const contents = new Map<
    string,
    { bytes: Uint8Array; metadata: TrustedRigPlatformRuntimePathMetadata }
  >();
  let totalBytes = 0;

  const read = async (path: string): Promise<Uint8Array> => {
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
      bytes.byteLength !== leaf.sizeBytes ||
      before.length !== after.length ||
      before.some((metadata, index) => !samePathMetadata(metadata, after[index]!))
    ) {
      throw new Error(`trusted Rig platform runtime path changed while it was read: ${path}`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RUNTIME_MANIFEST_BYTES) {
      throw new Error("trusted Rig platform runtime manifest exceeds its byte budget");
    }
    contents.set(path, { bytes, metadata: leaf });
    return bytes;
  };

  for (const path of paths) await read(path);
  const enginePath = browserEnginePath(contents.get("/etc/opengeni/browser-engine")!.bytes);
  if (!contents.has(enginePath)) await read(enginePath);

  const entries = [...contents.entries()]
    .map(([path, { bytes, metadata }]) => ({
      path,
      resolvedPath: path,
      fileType: "regular" as const,
      mode: metadata.mode,
      sizeBytes: bytes.byteLength,
      sha256: sha256Digest(bytes),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return freezeManifest(entries);
}

export function assertTrustedRigPlatformRuntimeManifest(
  manifest: TrustedRigPlatformRuntimeManifest,
): void {
  if (
    manifest.version !== TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION ||
    !SHA256.test(manifest.digest) ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0
  ) {
    throw new Error("trusted Rig platform runtime manifest is invalid");
  }
  let previousPath = "";
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    if (
      !SAFE_ABSOLUTE_PATH.test(entry.path) ||
      entry.path <= previousPath ||
      entry.resolvedPath !== entry.path ||
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
  if (
    totalBytes > MAX_RUNTIME_MANIFEST_BYTES ||
    manifestDigest(manifest.entries) !== manifest.digest
  ) {
    throw new Error("trusted Rig platform runtime manifest is invalid");
  }
}

export function assertTrustedRigPlatformRuntimeMatches(
  expected: TrustedRigPlatformRuntimeManifest,
  actual: TrustedRigPlatformRuntimeManifest,
): void {
  assertTrustedRigPlatformRuntimeManifest(expected);
  assertTrustedRigPlatformRuntimeManifest(actual);
  if (expected.digest === actual.digest) return;

  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const changedPath = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])]
    .sort()
    .find((path) => {
      const before = expectedByPath.get(path);
      const after = actualByPath.get(path);
      return (
        !before ||
        !after ||
        before.resolvedPath !== after.resolvedPath ||
        before.fileType !== after.fileType ||
        before.mode !== after.mode ||
        before.sizeBytes !== after.sizeBytes ||
        before.sha256 !== after.sha256
      );
    });
  throw new Error(
    `trusted Rig platform runtime integrity mismatch${changedPath ? ` at ${changedPath}` : ""}; derived provider image changed deployment-owned helper/runtime bytes`,
  );
}
