import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION,
  decodeNativeSnapshotRef,
  parseWorkspaceArchiveDescriptor,
  type NativeSnapshotDescriptor,
  type NativeSnapshotRef,
  type TarWorkspaceArchiveDescriptor,
  type WorkspaceArchiveDescriptor,
  type WorkspaceTreeFingerprint,
} from "@opengeni/contracts";
import { withSandboxProviderCapture } from "./provider-operation-gate";

export {
  WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION,
  decodeNativeSnapshotRef,
  encodeNativeSnapshotRef,
  parseWorkspaceArchiveDescriptor,
  type NativeSnapshotDescriptor,
  type NativeSnapshotProvider,
  type NativeSnapshotRef,
  type TarWorkspaceArchiveDescriptor,
  type WorkspaceArchiveDescriptor,
  type WorkspaceTreeFingerprint,
} from "@opengeni/contracts";

export type VerifiedWorkspaceArchive = {
  bytes: Uint8Array;
  base64: string;
  descriptor: WorkspaceArchiveDescriptor;
  kind: "tar" | "provider_snapshot";
  nativeSnapshot?: NativeSnapshotRef;
};

export type WorkspaceArchiveIntegrityCode =
  | "archive_metadata_missing"
  | "archive_metadata_invalid"
  | "archive_base64_invalid"
  | "archive_hash_mismatch"
  | "archive_hydration_failed"
  | "workspace_fingerprint_unavailable"
  | "workspace_changed_during_capture"
  | "workspace_fingerprint_mismatch"
  | "native_snapshot_reference_invalid"
  | "native_snapshot_fallback_unverified";

export class WorkspaceArchiveIntegrityError extends Error {
  readonly name = "WorkspaceArchiveIntegrityError";
  readonly retryable: boolean;

  constructor(
    public readonly code: WorkspaceArchiveIntegrityCode,
    message: string,
    options: { retryable?: boolean } = {},
  ) {
    super(message);
    this.retryable = options.retryable ?? false;
  }
}

type WorkspaceSession = {
  exec?: (args: {
    cmd: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<unknown>;
  execCommand?: (args: {
    cmd: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<unknown>;
  persistWorkspace?: (options?: WorkspaceArchiveCaptureOptions) => Promise<Uint8Array | undefined>;
  /** Agents Extensions remote sessions expose this protected-at-type-level
   * primitive on the concrete JS instance. OpenGeni uses it only through an
   * explicit provider policy to bypass replacing/unledgered native capture. */
  persistWorkspaceTar?: () => Promise<Uint8Array | undefined>;
  state?: {
    workspacePersistence?: unknown;
    workspaceRootPath?: unknown;
    manifest?: {
      ephemeralPersistencePaths?: () => Set<unknown>;
    };
  };
};

type SdkLocalArchiveFile = { path: string; content: Uint8Array };

/**
 * Durable correlation identity for one logical provider capture. A provider
 * adapter may place it on its wire request, but callers must not infer replay
 * idempotency unless that provider contract explicitly guarantees it.
 */
export type WorkspaceArchiveCaptureOptions = {
  requestId: string;
  strategy?: "configured" | "portable_tar";
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeBase64Strict(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  return Buffer.from(bytes).toString("base64") === value ? bytes : null;
}

export function describeNativeSnapshotArchive(
  bytes: Uint8Array,
  capturedAtMs = Date.now(),
): NativeSnapshotDescriptor | null {
  const native = decodeNativeSnapshotRef(bytes);
  if (!native) return null;
  const archiveSha256 = sha256(bytes);
  return {
    version: WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION,
    kind: "provider_snapshot",
    revision: `wa2:${String(capturedAtMs).padStart(13, "0")}:${archiveSha256}`,
    archiveSha256,
    archiveBytes: bytes.length,
    capturedAt: new Date(capturedAtMs).toISOString(),
    provider: native.provider,
    snapshotId: native.snapshotId,
    ...(native.workspacePersistence ? { workspacePersistence: native.workspacePersistence } : {}),
  };
}

export function describeLegacyNativeSnapshotArchive(
  base64: unknown,
  observedAtMs = Date.now(),
): { archiveBase64: string; descriptor: NativeSnapshotDescriptor } | null {
  if (typeof base64 !== "string") return null;
  const bytes = decodeBase64Strict(base64);
  if (!bytes) return null;
  const descriptor = describeNativeSnapshotArchive(bytes, observedAtMs);
  return descriptor ? { archiveBase64: base64, descriptor } : null;
}

export function readVerifiedWorkspaceArchive(
  base64: unknown,
  metadata: unknown,
): VerifiedWorkspaceArchive | null {
  if (base64 === undefined || base64 === null || base64 === "") return null;
  if (typeof base64 !== "string") {
    throw new WorkspaceArchiveIntegrityError(
      "archive_base64_invalid",
      "selected workspace archive is not a base64 string",
    );
  }
  if (metadata === undefined || metadata === null) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_metadata_missing",
      "selected workspace archive has no durable revision/fingerprint metadata",
    );
  }
  const descriptor = parseWorkspaceArchiveDescriptor(metadata);
  if (!descriptor) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_metadata_invalid",
      "selected workspace archive metadata is invalid",
    );
  }
  const bytes = decodeBase64Strict(base64);
  if (!bytes) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_base64_invalid",
      `workspace archive revision ${descriptor.revision} has invalid base64 bytes`,
    );
  }
  const actualHash = sha256(bytes);
  if (bytes.length !== descriptor.archiveBytes || actualHash !== descriptor.archiveSha256) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_hash_mismatch",
      `workspace archive revision ${descriptor.revision} failed SHA-256/size verification`,
    );
  }
  const nativeSnapshot = decodeNativeSnapshotRef(bytes);
  if (descriptor.version === WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION) {
    if (
      !nativeSnapshot ||
      nativeSnapshot.provider !== descriptor.provider ||
      nativeSnapshot.snapshotId !== descriptor.snapshotId ||
      nativeSnapshot.workspacePersistence !== descriptor.workspacePersistence
    ) {
      throw new WorkspaceArchiveIntegrityError(
        "native_snapshot_reference_invalid",
        `native snapshot receipt does not match descriptor revision ${descriptor.revision}`,
      );
    }
  } else if (nativeSnapshot) {
    throw new WorkspaceArchiveIntegrityError(
      "native_snapshot_reference_invalid",
      `legacy native snapshot receipt ${descriptor.revision} was not durably upgraded to a v2 provider descriptor`,
    );
  }
  return {
    bytes,
    base64,
    descriptor,
    kind: descriptor.version === WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION ? "provider_snapshot" : "tar",
    ...(descriptor.version === WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION && nativeSnapshot
      ? { nativeSnapshot }
      : {}),
  };
}

function stdoutFromExecResult(value: unknown): string {
  if (typeof value === "string") {
    const delimiter = /\r?\nOutput:\r?\n/u.exec(value);
    return delimiter ? value.slice(delimiter.index + delimiter[0].length) : value;
  }
  if (!value || typeof value !== "object") return "";
  const output = value as { stdout?: unknown; output?: unknown };
  return typeof output.stdout === "string"
    ? output.stdout
    : typeof output.output === "string"
      ? output.output
      : "";
}

function execFailureDiagnostic(value: unknown): string {
  if (!value || typeof value !== "object") return "result=unstructured";
  const result = value as { exitCode?: unknown; status?: unknown; stderr?: unknown };
  const status =
    typeof result.exitCode === "number"
      ? `exitCode=${result.exitCode}`
      : typeof result.status === "number"
        ? `status=${result.status}`
        : "exitCode=unknown";
  const stderr =
    typeof result.stderr === "string"
      ? result.stderr.replace(/\s+/g, " ").trim().slice(0, 240)
      : "";
  return stderr.length > 0 ? `${status}, stderr=${stderr}` : status;
}

function isTransientRootDirectoryFingerprintRace(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as { exitCode?: unknown; status?: unknown; stderr?: unknown };
  const exitCode =
    typeof result.exitCode === "number"
      ? result.exitCode
      : typeof result.status === "number"
        ? result.status
        : null;
  if (exitCode !== 1 || typeof result.stderr !== "string") return false;
  return result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === "tar: .: file changed as we read it");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function workspaceFingerprintExcludes(session: WorkspaceSession): string[] {
  return [...(session.state?.manifest?.ephemeralPersistencePaths?.() ?? [])]
    .filter((path): path is string => typeof path === "string" && path.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function workspaceFingerprintCommand(excludedPaths: readonly string[]): string {
  const tarExcludes = excludedPaths.flatMap((path) => [
    shellQuote(`--exclude=${path}`),
    shellQuote(`--exclude=./${path}`),
  ]);
  const findExcludes = excludedPaths.flatMap((path) => [
    `-path ${shellQuote(`./${path}`)}`,
    `-path ${shellQuote(`./${path}/*`)}`,
  ]);
  const findPrefix =
    findExcludes.length === 0 ? "" : `\\( ${findExcludes.join(" -o ")} \\) -prune -o `;
  const script = String.raw`set -eu
cd /workspace
digest=$(LC_ALL=C tar ${tarExcludes.join(" ")} --sort=name --mtime="@0" --owner=0 --group=0 --numeric-owner --hard-dereference --format=gnu -cf - . | sha256sum | awk "{print \$1}")
entries=$(find . -xdev -mindepth 1 ${findPrefix}-printf x | wc -c | tr -d " ")
files=$(find . -xdev ${findPrefix}-type f -printf x | wc -c | tr -d " ")
bytes=$(find . -xdev ${findPrefix}-type f -printf "%s\n" | awk "{s+=\$1} END {printf \"%.0f\", s+0}")
printf "OPENGENI_WORKSPACE_FINGERPRINT_V1 %s %s %s %s\n" "$digest" "$entries" "$files" "$bytes"`;
  return `bash -o pipefail -c ${shellQuote(script)}`;
}

const SDK_LOCAL_ARCHIVE_PROJECTION = "sdk_local_archive_v1" as const;
const HOST_FINGERPRINT_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

function hostBackedWorkspaceRoot(session: WorkspaceSession): string | null {
  const root = session.state?.workspaceRootPath;
  return typeof root === "string" && isAbsolute(root) ? root : null;
}

function appendFingerprintFrame(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string,
): void {
  hash.update(label);
  hash.update("\0");
  hash.update(String(Buffer.byteLength(value)));
  hash.update("\0");
  hash.update(value);
  hash.update("\0");
}

function stableLogicalPathCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fingerprintSdkLocalProjection(
  directoryInput: readonly string[],
  fileInput: readonly SdkLocalArchiveFile[],
): WorkspaceTreeFingerprint {
  const directories = [...directoryInput].sort(stableLogicalPathCompare);
  const files = [...fileInput].sort((left, right) =>
    stableLogicalPathCompare(left.path, right.path),
  );
  const paths = new Set<string>();
  const hash = createHash("sha256");
  appendFingerprintFrame(hash, "projection", SDK_LOCAL_ARCHIVE_PROJECTION);
  for (const directory of directories) {
    if (paths.has(directory)) {
      throw new WorkspaceArchiveIntegrityError(
        "workspace_fingerprint_unavailable",
        "host-backed sandbox archive contains a duplicate logical path",
        { retryable: true },
      );
    }
    paths.add(directory);
    appendFingerprintFrame(hash, "dir", directory);
  }
  let totalFileBytes = 0;
  for (const file of files) {
    if (paths.has(file.path)) {
      throw new WorkspaceArchiveIntegrityError(
        "workspace_fingerprint_unavailable",
        "host-backed sandbox archive contains a duplicate logical path",
        { retryable: true },
      );
    }
    paths.add(file.path);
    totalFileBytes += file.content.byteLength;
    if (!Number.isSafeInteger(totalFileBytes)) {
      throw new WorkspaceArchiveIntegrityError(
        "workspace_fingerprint_unavailable",
        "host-backed sandbox workspace exceeds the supported fingerprint byte range",
      );
    }
    appendFingerprintFrame(hash, "file", file.path);
    appendFingerprintFrame(hash, "bytes", String(file.content.byteLength));
    hash.update(file.content);
  }
  return {
    algorithm: "sha256",
    sha256: hash.digest("hex"),
    entryCount: directories.length + files.length,
    fileCount: files.length,
    totalFileBytes,
    projection: SDK_LOCAL_ARCHIVE_PROJECTION,
  };
}

function sdkArchivePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function decodeSdkArchiveFile(value: unknown): Uint8Array | null {
  if (value === "") return new Uint8Array();
  return typeof value === "string" ? decodeBase64Strict(value) : null;
}

/** Parse only the portable JSON shape emitted by Agents SDK Local/Docker
 * persistWorkspace(). This lets capture prove that the bytes themselves—not
 * merely two live-directory observations—contain the exact fenced projection. */
function fingerprintSdkLocalArchive(bytes: Uint8Array): WorkspaceTreeFingerprint {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "host-backed sandbox persistence returned an invalid SDK archive",
      { retryable: true },
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "host-backed sandbox persistence returned an invalid SDK archive",
      { retryable: true },
    );
  }
  const archive = decoded as {
    version?: unknown;
    directories?: unknown;
    files?: unknown;
  };
  if (
    archive.version !== 1 ||
    !Array.isArray(archive.directories) ||
    !archive.directories.every(sdkArchivePath) ||
    !Array.isArray(archive.files)
  ) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "host-backed sandbox persistence returned an invalid SDK archive",
      { retryable: true },
    );
  }
  const files: SdkLocalArchiveFile[] = [];
  for (const candidate of archive.files) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new WorkspaceArchiveIntegrityError(
        "workspace_fingerprint_unavailable",
        "host-backed sandbox persistence returned an invalid SDK archive",
        { retryable: true },
      );
    }
    const file = candidate as { path?: unknown; data?: unknown };
    const content = decodeSdkArchiveFile(file.data);
    if (!sdkArchivePath(file.path) || !content) {
      throw new WorkspaceArchiveIntegrityError(
        "workspace_fingerprint_unavailable",
        "host-backed sandbox persistence returned an invalid SDK archive",
        { retryable: true },
      );
    }
    files.push({ path: file.path, content });
  }
  return fingerprintSdkLocalProjection(archive.directories, files);
}

function sameFilesystemEntry(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hostPathChanged(): WorkspaceArchiveIntegrityError {
  return new WorkspaceArchiveIntegrityError(
    "workspace_fingerprint_unavailable",
    "host-backed sandbox workspace changed while fingerprinting",
    { retryable: true },
  );
}

async function readStableHostFile(
  path: string,
  expected: Awaited<ReturnType<typeof lstat>>,
): Promise<Buffer> {
  const before = await lstat(path).catch(() => {
    throw hostPathChanged();
  });
  if (!before.isFile() || !sameFilesystemEntry(before, expected)) {
    throw hostPathChanged();
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, HOST_FINGERPRINT_READ_FLAGS);
  } catch {
    throw hostPathChanged();
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFilesystemEntry(opened, before)) {
      throw hostPathChanged();
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      !after.isFile() ||
      !sameFilesystemEntry(after, opened) ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw hostPathChanged();
    }
    return content;
  } finally {
    await handle.close();
  }
}

function shouldSkipHostArchivePath(path: string, excludedPaths: ReadonlySet<string>): boolean {
  for (const excluded of excludedPaths) {
    if (excluded === "" || path === excluded || path.startsWith(`${excluded}/`)) return true;
  }
  return false;
}

/** Mirrors Agents SDK 0.13.x createWorkspaceArchive(): its Local/Docker
 * persistence is a provider-agnostic JSON archive containing directories and
 * regular files, not an in-container tar stream. Fingerprinting the same host
 * projection removes all image-tool dependencies (including Alpine's lack of
 * bash) and makes the descriptor match what cold restore can actually rebuild. */
async function fingerprintHostBackedWorkspace(
  root: string,
  excludedPaths: readonly string[],
): Promise<WorkspaceTreeFingerprint> {
  const excluded = new Set(excludedPaths);
  const directories: string[] = [];
  const files: SdkLocalArchiveFile[] = [];

  const walk = async (
    currentRoot: string,
    relativeRoot = "",
    expected?: Awaited<ReturnType<typeof lstat>>,
  ): Promise<void> => {
    const before = await lstat(currentRoot).catch(() => {
      throw hostPathChanged();
    });
    if (!before.isDirectory() || (expected && !sameFilesystemEntry(before, expected))) {
      throw hostPathChanged();
    }
    const entries = await readdir(currentRoot, { withFileTypes: true });
    const afterRead = await lstat(currentRoot).catch(() => {
      throw hostPathChanged();
    });
    if (!afterRead.isDirectory() || !sameFilesystemEntry(afterRead, before)) {
      throw hostPathChanged();
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (shouldSkipHostArchivePath(relativePath, excluded)) continue;
      const entryPath = join(currentRoot, entry.name);
      const stats = await lstat(entryPath).catch(() => {
        throw hostPathChanged();
      });
      if (stats.isDirectory()) {
        directories.push(relativePath);
        await walk(entryPath, relativePath, stats);
        continue;
      }
      // This is deliberately identical to the SDK archive projection: symlinks,
      // sockets, devices and FIFOs are not serialized and therefore must not
      // influence the restore fingerprint either.
      if (!stats.isFile()) continue;
      const content = await readStableHostFile(entryPath, stats);
      files.push({ path: relativePath, content });
    }
    const afterWalk = await lstat(currentRoot).catch(() => {
      throw hostPathChanged();
    });
    if (!afterWalk.isDirectory() || !sameFilesystemEntry(afterWalk, before)) {
      throw hostPathChanged();
    }
  };

  await walk(root);
  return fingerprintSdkLocalProjection(directories, files);
}

async function fingerprintRemoteWorkspace(
  target: WorkspaceSession,
): Promise<WorkspaceTreeFingerprint> {
  const run = target.exec ?? target.execCommand;
  if (!run) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "sandbox session cannot execute the workspace fingerprint probe",
    );
  }
  const cmd = workspaceFingerprintCommand(workspaceFingerprintExcludes(target));
  let result: unknown;
  let match: RegExpMatchArray | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    result = await run.call(target, {
      cmd,
      yieldTimeMs: 120_000,
      maxOutputTokens: 1_000,
    });
    match = stdoutFromExecResult(result)
      .trim()
      .match(/^OPENGENI_WORKSPACE_FINGERPRINT_V1 ([a-f0-9]{64}) ([0-9]+) ([0-9]+) ([0-9]+)$/);
    if (match || !isTransientRootDirectoryFingerprintRace(result) || attempt === 3) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 25));
  }
  if (!match) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      `sandbox workspace fingerprint probe returned no valid digest (${execFailureDiagnostic(result)})`,
      { retryable: true },
    );
  }
  const entryCount = Number(match[2]);
  const fileCount = Number(match[3]);
  const totalFileBytes = Number(match[4]);
  if (![entryCount, fileCount, totalFileBytes].every(Number.isSafeInteger)) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "sandbox workspace fingerprint counters exceeded the supported range",
    );
  }
  return {
    algorithm: "sha256",
    sha256: match[1]!,
    entryCount,
    fileCount,
    totalFileBytes,
  };
}

/** Fingerprints the provider's exact persistent projection. Local/Docker use
 * the SDK's host-backed portable archive projection; remote tar providers use a
 * deterministic GNU-tar stream. Manifest-declared ephemeral paths are excluded
 * in both cases. Only the aggregate enters logs or durable metadata. */
export async function fingerprintSandboxWorkspace(
  session: unknown,
): Promise<WorkspaceTreeFingerprint> {
  const target = session as WorkspaceSession;
  const hostRoot = hostBackedWorkspaceRoot(target);
  return hostRoot
    ? await fingerprintHostBackedWorkspace(hostRoot, workspaceFingerprintExcludes(target))
    : await fingerprintRemoteWorkspace(target);
}

function fingerprintsEqual(a: WorkspaceTreeFingerprint, b: WorkspaceTreeFingerprint): boolean {
  return (
    (a.projection ?? "gnu_tar_v1") === (b.projection ?? "gnu_tar_v1") &&
    a.sha256 === b.sha256 &&
    a.entryCount === b.entryCount &&
    a.fileCount === b.fileCount &&
    a.totalFileBytes === b.totalFileBytes
  );
}

/** Provider-native persistence returns an opaque receipt and is accepted under
 * the provider/artifact publication fence. A real tar capture is accepted only
 * when the complete persistent tree is byte-identical immediately before and
 * after serialization; a concurrent mutation makes that candidate unusable. */
export async function captureVerifiedWorkspaceArchive(
  session: unknown,
  capturedAtMs = Date.now(),
  options?: WorkspaceArchiveCaptureOptions,
): Promise<VerifiedWorkspaceArchive> {
  return await withSandboxProviderCapture(session, async () => {
    return await captureVerifiedWorkspaceArchiveExclusive(session, capturedAtMs, options);
  });
}

async function captureVerifiedWorkspaceArchiveExclusive(
  session: unknown,
  capturedAtMs: number,
  options?: WorkspaceArchiveCaptureOptions,
): Promise<VerifiedWorkspaceArchive> {
  const target = session as WorkspaceSession;
  const portableTar = options?.strategy === "portable_tar";
  const persist = portableTar ? target.persistWorkspaceTar : target.persistWorkspace;
  if (typeof persist !== "function") {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      portableTar
        ? "sandbox provider policy requires portable tar capture but the session exposes no tar primitive"
        : "sandbox session does not support workspace persistence",
    );
  }
  const configuredPersistence = target.state?.workspacePersistence;
  const configuredTarFallback = workspaceFingerprintExcludes(target).length > 0;
  const expectsNativeSnapshot =
    !portableTar &&
    typeof configuredPersistence === "string" &&
    configuredPersistence !== "tar" &&
    !configuredTarFallback;
  const before = expectsNativeSnapshot ? null : await fingerprintSandboxWorkspace(target);
  const bytes = portableTar
    ? await target.persistWorkspaceTar!()
    : await target.persistWorkspace!(options);
  if (!bytes || bytes.length === 0) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_base64_invalid",
      "sandbox workspace persistence returned an empty archive",
      { retryable: true },
    );
  }
  const nativeSnapshot = decodeNativeSnapshotRef(bytes);
  if (nativeSnapshot) {
    const descriptor = describeNativeSnapshotArchive(bytes, capturedAtMs)!;
    return {
      bytes,
      base64: Buffer.from(bytes).toString("base64"),
      descriptor,
      kind: "provider_snapshot",
      nativeSnapshot,
    };
  }
  if (expectsNativeSnapshot) {
    throw new WorkspaceArchiveIntegrityError(
      "native_snapshot_fallback_unverified",
      `sandbox configured for ${String(configuredPersistence)} returned a tar archive instead of a native snapshot receipt`,
    );
  }
  const after = await fingerprintSandboxWorkspace(target);
  const capturedProjection =
    before?.projection === SDK_LOCAL_ARCHIVE_PROJECTION ? fingerprintSdkLocalArchive(bytes) : null;
  if (
    !before ||
    !fingerprintsEqual(before, after) ||
    (capturedProjection !== null && !fingerprintsEqual(before, capturedProjection))
  ) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_changed_during_capture",
      "workspace changed while its durable archive was being captured",
      { retryable: true },
    );
  }
  const archiveSha256 = sha256(bytes);
  const descriptor: TarWorkspaceArchiveDescriptor = {
    version: 1,
    revision: `wa1:${String(capturedAtMs).padStart(13, "0")}:${archiveSha256}`,
    archiveSha256,
    archiveBytes: bytes.length,
    capturedAt: new Date(capturedAtMs).toISOString(),
    workspace: before,
  };
  return {
    bytes,
    base64: Buffer.from(bytes).toString("base64"),
    descriptor,
    kind: "tar",
  };
}

export async function verifyRestoredWorkspace(
  session: unknown,
  descriptor: WorkspaceArchiveDescriptor,
): Promise<WorkspaceTreeFingerprint | null> {
  if (descriptor.version === WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION) {
    return null;
  }
  const target = session as WorkspaceSession;
  // Descriptors written before the projection discriminator always used the
  // in-sandbox GNU-tar probe, even for Local/Docker. Preserve that exact legacy
  // behavior; new host-backed descriptors remain independent of image tools.
  const actual =
    descriptor.workspace.projection === SDK_LOCAL_ARCHIVE_PROJECTION
      ? await (() => {
          const root = hostBackedWorkspaceRoot(target);
          if (!root) {
            throw new WorkspaceArchiveIntegrityError(
              "workspace_fingerprint_unavailable",
              "selected host-backed workspace archive was restored by a non-host-backed provider",
            );
          }
          return fingerprintHostBackedWorkspace(root, workspaceFingerprintExcludes(target));
        })()
      : await fingerprintRemoteWorkspace(target);
  if (!fingerprintsEqual(actual, descriptor.workspace)) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_mismatch",
      `restored workspace does not match selected archive revision ${descriptor.revision}`,
    );
  }
  return actual;
}
