import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";

export const TRUSTED_RIG_PLATFORM_RUNTIME_MANIFEST_VERSION = 1 as const;

export type TrustedRigPlatformRuntimeManifestEntry = Readonly<{
  path: string;
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
  return entries.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 }));
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

/**
 * Capture deployment-owned helper/runtime bytes without invoking candidate
 * shell code. Provider adapters supply the exact-instance file reader.
 */
export async function captureTrustedRigPlatformRuntimeManifest(input: {
  settings: Settings;
  readBytes(path: string): Promise<Uint8Array>;
  signal?: AbortSignal;
}): Promise<TrustedRigPlatformRuntimeManifest> {
  const paths = configuredRuntimePaths(input.settings);
  const contents = new Map<string, Uint8Array>();
  let totalBytes = 0;

  const read = async (path: string): Promise<Uint8Array> => {
    input.signal?.throwIfAborted();
    const bytes = await input.readBytes(path);
    input.signal?.throwIfAborted();
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`trusted Rig platform reader returned non-bytes for ${path}`);
    }
    if (bytes.byteLength > MAX_RUNTIME_FILE_BYTES) {
      throw new Error(`trusted Rig platform runtime file is too large: ${path}`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RUNTIME_MANIFEST_BYTES) {
      throw new Error("trusted Rig platform runtime manifest exceeds its byte budget");
    }
    contents.set(path, bytes);
    return bytes;
  };

  for (const path of paths) await read(path);
  const enginePath = browserEnginePath(contents.get("/etc/opengeni/browser-engine")!);
  if (!contents.has(enginePath)) await read(enginePath);

  const entries = [...contents.entries()]
    .map(([path, bytes]) => ({
      path,
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
        !before || !after || before.sizeBytes !== after.sizeBytes || before.sha256 !== after.sha256
      );
    });
  throw new Error(
    `trusted Rig platform runtime integrity mismatch${changedPath ? ` at ${changedPath}` : ""}; derived provider image changed deployment-owned helper/runtime bytes`,
  );
}
