import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION,
  decodeNativeSnapshotRef,
  parseWorkspaceArchiveDescriptor,
  parseWorkspaceArchiveObjectRef,
  type NativeSnapshotDescriptor,
  type NativeSnapshotRef,
  type TarWorkspaceArchiveDescriptor,
  type WorkspaceArchiveDescriptor,
  type WorkspaceTreeFingerprint,
} from "@opengeni/contracts";
import { withSandboxProviderCapture } from "./provider-operation-gate";
import {
  escapeWorkspaceGlobPattern,
  workspaceTarExcludeArgs,
  workspaceTopLevelExcludeGlobs,
} from "./workspace-tar-excludes";
import type { VerifiedHostWorkspaceArchive } from "./archive-spool";
import {
  captureHostWorkspaceArchive,
  fingerprintHostWorkspace,
  type HostWorkspaceRootIdentity,
} from "./host-archive-spool";

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

export type VerifiedWorkspaceArchivePayload =
  | VerifiedWorkspaceArchive
  | VerifiedHostWorkspaceArchive;

/** Host-backed portable archives can go directly to object storage without an
 * intermediate whole-document string or buffer. Existing inline/provider APIs
 * retain their compatibility path when disk-backed publication is unavailable. */
export async function captureWorkspaceArchiveForStorage(
  session: unknown,
  capturedAtMs: number,
  options: WorkspaceArchiveCaptureOptions,
  objectStorageAvailable: boolean,
): Promise<VerifiedWorkspaceArchivePayload> {
  const target = session as WorkspaceSession;
  await target.assertWorkspaceCaptureAuthority?.();
  const root = hostBackedWorkspaceRoot(target);
  if (
    process.platform !== "linux" ||
    !root ||
    !objectStorageAvailable ||
    options.strategy === "portable_tar" ||
    (options.omitPaths?.length ?? 0) > 0
  ) {
    return await captureVerifiedWorkspaceArchive(session, capturedAtMs, options);
  }
  return await withSandboxProviderCapture(
    session,
    async () => {
      const { spool, workspace } = await captureHostWorkspaceArchive(
        root,
        workspaceFingerprintExcludes(target),
        target.workspaceCaptureRootIdentity,
        options.signal,
      );
      return {
        kind: "host_spool" as const,
        spool,
        descriptor: {
          version: 1 as const,
          revision: `wa1:${String(capturedAtMs).padStart(13, "0")}:${spool.sha256}`,
          archiveSha256: spool.sha256,
          archiveBytes: spool.byteSize,
          capturedAt: new Date(capturedAtMs).toISOString(),
          workspace,
        },
      };
    },
    options.signal,
  );
}

export async function disposeWorkspaceArchive(
  archive: VerifiedWorkspaceArchivePayload | undefined,
): Promise<void> {
  if (archive?.kind === "host_spool") await archive.spool.dispose();
}

export type WorkspaceArchiveIntegrityCode =
  | "archive_metadata_missing"
  | "archive_metadata_invalid"
  | "archive_base64_invalid"
  | "archive_hash_mismatch"
  | "archive_hydration_failed"
  /** The referenced archive object does not exist (deleted, wrong bucket or
   * account). Never proof that the checkpoint content is corrupt. */
  | "archive_object_missing"
  /** This process has no archive object storage configured. */
  | "archive_storage_unavailable"
  | "workspace_fingerprint_unavailable"
  | "workspace_changed_during_capture"
  | "workspace_fingerprint_mismatch"
  | "native_snapshot_reference_invalid"
  | "native_snapshot_fallback_unverified"
  /** A reduced save (paths left out) did not finish within its hard bound. */
  | "workspace_capture_timeout";

export class WorkspaceArchiveIntegrityError extends Error {
  readonly name = "WorkspaceArchiveIntegrityError";
  readonly retryable: boolean;

  constructor(
    public readonly code: WorkspaceArchiveIntegrityCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = options.retryable ?? false;
  }
}

type WorkspaceSession = {
  /** Present only on the reaper's restricted Docker capture attachment. */
  assertWorkspaceCaptureAuthority?: () => Promise<void>;
  workspaceCaptureRootIdentity?: HostWorkspaceRootIdentity;
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
   * primitive on the concrete JS instance. Opengeni uses it only through an
   * explicit provider policy to bypass replacing/unledgered native capture. */
  persistWorkspaceTar?: () => Promise<Uint8Array | undefined>;
  /** Top-level globs the session's own archive leaves out beyond the
   * manifest's ephemeral paths (compute and OpenSandbox: their restore
   * staging and backup folders). */
  workspaceArchiveExcludedGlobs?: () => readonly unknown[];
  state?: {
    workspacePersistence?: unknown;
    workspaceRootPath?: unknown;
    manifest?: {
      root?: unknown;
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
  /**
   * Hard provider-side timeout for this capture, where the provider has one
   * (Modal native snapshots). Only a zero-holder drain sets it, so its
   * snapshot may outlive the caller's wait and publish late; every other
   * capture keeps the provider session's configured timeout.
   */
  providerTimeoutMs?: number;
  /**
   * Workspace-relative directories to leave out of this capture: the drain's
   * reduced save, after full snapshots kept failing. A native snapshot cannot
   * leave paths out, so these force the session's portable tar path (with the
   * same paths left out of the archive and of its fingerprint), and the
   * descriptor records them as `omittedPaths`.
   */
  omitPaths?: readonly string[];
  /**
   * Abandons the capture while it still waits for the provider operation gate,
   * and stops a host-backed spool capture mid-read. A provider-native persist
   * call that already started is not interrupted: its own settlement remains
   * authoritative.
   */
  signal?: AbortSignal;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Decode canonical padded base64 in one pass. Workspace archives reach
 * hundreds of MB, so the decoded bytes are returned as a view over the
 * decoder's own buffer rather than copied, and canonical form is proven
 * without re-encoding the whole payload: the alphabet/padding shape is
 * checked up front, the decoded length must match the padding, and only the
 * final quantum (the one place non-zero pad bits can hide) is re-encoded.
 */
function decodeBase64Strict(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (decoded.length !== (value.length / 4) * 3 - padding) return null;
  const lastQuantumStart = (value.length / 4 - 1) * 3;
  if (decoded.subarray(lastQuantumStart).toString("base64") !== value.slice(-4)) return null;
  // A plain Uint8Array view, not the Buffer subclass: callers compare and
  // serialize it as ordinary bytes.
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.length);
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
  const descriptor = requireWorkspaceArchiveDescriptor(metadata);
  const bytes = decodeBase64Strict(base64);
  if (!bytes) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_base64_invalid",
      `workspace archive revision ${descriptor.revision} has invalid base64 bytes`,
    );
  }
  return verifyDecodedWorkspaceArchive(bytes, base64, descriptor);
}

function requireWorkspaceArchiveDescriptor(metadata: unknown): WorkspaceArchiveDescriptor {
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
  return descriptor;
}

function verifyDecodedWorkspaceArchive(
  bytes: Uint8Array,
  base64: string,
  descriptor: WorkspaceArchiveDescriptor,
): VerifiedWorkspaceArchive {
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

/** Fetch object-storage tar bytes into the in-memory restore envelope. Legacy
 * inline base64 is left unchanged. Both payloads must agree when both exist. */
export async function inlineWorkspaceArchiveForRestore(
  sessionState: Record<string, unknown>,
  getObjectBytes: (key: string) => Promise<{ bytes: Uint8Array } | null>,
): Promise<Record<string, unknown>> {
  const ref = parseWorkspaceArchiveObjectRef(sessionState.workspaceArchiveRef);
  if (!ref) return sessionState;
  const object = await getObjectBytes(ref.key);
  if (!object) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_object_missing",
      `workspace archive object ${ref.key} is missing`,
    );
  }
  const actualHash = sha256(object.bytes);
  if (object.bytes.length !== ref.bytes || actualHash !== ref.sha256) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_hash_mismatch",
      `workspace archive object ${ref.key} failed SHA-256/size verification`,
    );
  }
  const descriptor = requireWorkspaceArchiveDescriptor(sessionState.workspaceArchiveMeta);
  const base64 = Buffer.from(
    object.bytes.buffer,
    object.bytes.byteOffset,
    object.bytes.byteLength,
  ).toString("base64");
  const inline = sessionState.workspaceArchive;
  if (typeof inline === "string" && inline.length > 0 && inline !== base64) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_hash_mismatch",
      "inline workspace archive and object-storage ref disagree",
    );
  }
  // The fetched bytes are already in hand: verify them directly rather than
  // decoding the base64 copy that was just made.
  verifyDecodedWorkspaceArchive(object.bytes, base64, descriptor);
  return { ...sessionState, workspaceArchive: base64 };
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
  const result = value as {
    exitCode?: unknown;
    status?: unknown;
    stderr?: unknown;
  };
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
  const result = value as {
    exitCode?: unknown;
    status?: unknown;
    stderr?: unknown;
  };
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

/** Top-level globs the session's archive leaves out (see
 * `WorkspaceSession.workspaceArchiveExcludedGlobs`). Every remote fingerprint,
 * content manifest and size walk leaves out the same ones, checked by the
 * same `workspaceTopLevelExcludeGlobs` as the archive: a folder the archive
 * skips but the fingerprint counts makes a restore unverifiable. */
function workspaceFingerprintExcludeGlobs(session: WorkspaceSession): string[] {
  const globs = session.workspaceArchiveExcludedGlobs?.();
  return globs === undefined ? [] : workspaceTopLevelExcludeGlobs(globs);
}

/** Workspace-relative paths a session never persists (its manifest's
 * ephemeral paths). Archives and fingerprints leave them out. */
export function workspaceArchiveExcludedPaths(session: unknown): string[] {
  return workspaceFingerprintExcludes(session as WorkspaceSession);
}

/** A literal path as a glob pattern; the archive's tar exclusions escape
 * paths the same way, so the fingerprint leaves out exactly what the archive
 * leaves out. */
const escapeGlobPattern = escapeWorkspaceGlobPattern;

function findPruneExpression(
  excludedPaths: readonly string[],
  topLevelGlobs: readonly string[] = [],
): string {
  const findExcludes = [
    ...excludedPaths.map((path) => `./${escapeGlobPattern(path)}`),
    ...topLevelGlobs.map((glob) => `./${glob}`),
  ].flatMap((pattern) => [`-path ${shellQuote(pattern)}`, `-path ${shellQuote(`${pattern}/*`)}`]);
  return findExcludes.length === 0 ? "" : `\\( ${findExcludes.join(" -o ")} \\) -prune -o `;
}

function workspaceFingerprintCommand(
  excludedPaths: readonly string[],
  topLevelGlobs: readonly string[] = [],
): string {
  // Exactly the SDK's archive exclusions (`workspaceTarExcludeArgs`): one
  // escaped pattern anchored at `./`. A bare `--exclude=<name>` would also
  // match the same name deeper in the tree (`docs/target` for a top-level
  // `target`), which the archive keeps, so a restore could never verify.
  const tarExcludes = workspaceTarExcludeArgs(excludedPaths, topLevelGlobs);
  const findPrefix = findPruneExpression(excludedPaths, topLevelGlobs);
  const script = String.raw`set -eu
cd /workspace
digest=$(LC_ALL=C tar ${tarExcludes.join(" ")} --sort=name --mtime="@0" --owner=0 --group=0 --numeric-owner --hard-dereference --format=gnu -cf - . | sha256sum | awk "{print \$1}")
entries=$(find . -xdev -mindepth 1 ${findPrefix}! \( -type s -o -type p -o -type b -o -type c \) -printf x | wc -c | tr -d " ")
files=$(find . -xdev ${findPrefix}-type f -printf x | wc -c | tr -d " ")
bytes=$(find . -xdev ${findPrefix}-type f -printf "%s\n" | awk "{s+=\$1} END {printf \"%.0f\", s+0}")
printf "OPENGENI_WORKSPACE_FINGERPRINT_V1 %s %s %s %s\n" "$digest" "$entries" "$files" "$bytes"`;
  return `bash -o pipefail -c ${shellQuote(script)}`;
}

const SDK_LOCAL_ARCHIVE_PROJECTION = "sdk_local_archive_v1" as const;

export type WorkspaceSizeProbe = { fileCount: number; totalFileBytes: number };

/** Default bound for the size probe's own `timeout`; the caller's wait adds
 * a small margin for the provider's exec round trip. */
export const WORKSPACE_SIZE_PROBE_TIMEOUT_SECONDS = 15;

/**
 * Count regular files and their bytes under /workspace on a live remote box,
 * for observability only. The walk is bounded by `timeout` inside the box and
 * by a wall-clock race here; a walk that does not finish, a session that
 * cannot exec, or any error yields null rather than a partial count.
 */
export async function probeRemoteWorkspaceSize(
  session: unknown,
  timeoutSeconds = WORKSPACE_SIZE_PROBE_TIMEOUT_SECONDS,
): Promise<WorkspaceSizeProbe | null> {
  const target = session as WorkspaceSession | null | undefined;
  const run = target?.exec ?? target?.execCommand;
  if (!target || !run) return null;
  const seconds = Math.max(1, Math.floor(timeoutSeconds));
  // Same exclusions as the archive and its fingerprint, so a failed
  // snapshot's size compares with a captured one. An unreadable folder makes
  // find exit 1 with the rest counted, which still measures the workspace;
  // only a timeout (124) or a missing tool discards the walk.
  let prune: string;
  try {
    prune = findPruneExpression(
      workspaceFingerprintExcludes(target),
      workspaceFingerprintExcludeGlobs(target),
    );
  } catch {
    return null;
  }
  const script = String.raw`set -u
cd /workspace 2>/dev/null || exit 0
out=$(timeout ${seconds} find . -xdev ${prune}-type f -printf "%s\n" 2>/dev/null | awk "{n+=1; s+=\$1} END {printf \"%d %.0f\", n, s}")
rc=$?
[ "$rc" -le 1 ] || exit 0
# A find that cannot run this walk at all (BusyBox has no -printf) also
# exits 1, with nothing counted: that is no measurement, not an empty tree.
case "$rc $out" in "1 0 "*) exit 0 ;; esac
printf "OPENGENI_WORKSPACE_SIZE_V1 %s\n" "$out"`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run.call(target, {
        cmd: `bash -o pipefail -c ${shellQuote(script)}`,
        yieldTimeMs: (seconds + 5) * 1_000,
        maxOutputTokens: 1_000,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), (seconds + 10) * 1_000);
      }),
    ]);
    const match = stdoutFromExecResult(result)
      .trim()
      .match(/^OPENGENI_WORKSPACE_SIZE_V1 ([0-9]+) ([0-9]+)$/m);
    if (!match) return null;
    const fileCount = Number(match[1]);
    const totalFileBytes = Number(match[2]);
    return Number.isSafeInteger(fileCount) && Number.isFinite(totalFileBytes)
      ? { fileCount, totalFileBytes }
      : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The tree size a portable archive already measured, or null for provider
 * snapshots, which carry no tree fingerprint. */
export function workspaceSizeFromArchiveDescriptor(
  descriptor: WorkspaceArchiveDescriptor | undefined,
): WorkspaceSizeProbe | null {
  if (!descriptor || !("workspace" in descriptor) || !descriptor.workspace) return null;
  const { fileCount, totalFileBytes } = descriptor.workspace;
  return Number.isFinite(fileCount) && Number.isFinite(totalFileBytes)
    ? { fileCount, totalFileBytes }
    : null;
}

/**
 * Directory names a drain's reduced save leaves out: dependency installs,
 * build caches and tool caches that a project rebuilds from files the save
 * keeps. Deliberately conservative. Output folders such as `dist` or `build`
 * are kept, because some projects commit or hand-edit them, and `.git` is
 * never left out. `target` counts only next to a `Cargo.toml` (Rust build
 * output); elsewhere it is an ordinary folder.
 */
export const REBUILDABLE_WORKSPACE_DIRECTORY_NAMES = [
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".output",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
  ".gradle",
] as const;

function isRebuildableWorkspaceFolderName(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    name === "target" || (REBUILDABLE_WORKSPACE_DIRECTORY_NAMES as readonly string[]).includes(name)
  );
}

/** A workspace with more rebuildable folders than this is not reduced: the
 * walk could not size what the save keeps. */
export const REBUILDABLE_WORKSPACE_PATHS_MAX = 2048;

export type RebuildableWorkspacePaths = {
  /** Workspace-relative folders a reduced save can leave out, sorted. */
  paths: string[];
  /** Regular files and their bytes that a reduced save keeps. */
  kept: WorkspaceSizeProbe;
};

/**
 * Find the rebuildable folders under /workspace (see
 * `REBUILDABLE_WORKSPACE_DIRECTORY_NAMES`) and size what a save without them
 * keeps, in one walk that never descends into a found folder and never
 * matches inside `.git`. Bounded by `timeout` inside the box and by a
 * wall-clock race here; a timeout, a failure or more than
 * `REBUILDABLE_WORKSPACE_PATHS_MAX` folders yields null. An unreadable folder
 * (find exit 1) still sizes the rest: the save could not read it either.
 */
export async function findRebuildableWorkspacePaths(
  session: unknown,
  timeoutSeconds = WORKSPACE_SIZE_PROBE_TIMEOUT_SECONDS,
): Promise<RebuildableWorkspacePaths | null> {
  const target = session as WorkspaceSession | null | undefined;
  const run = target?.exec ?? target?.execCommand;
  if (!target || !run) return null;
  const seconds = Math.max(1, Math.floor(timeoutSeconds));
  const names = REBUILDABLE_WORKSPACE_DIRECTORY_NAMES.map((name) => `-name ${shellQuote(name)}`);
  // A name with a newline in it could forge a "D <path>" line, so any such
  // path is reported as unparseable (X) instead and the walk is unavailable.
  const script = String.raw`set -u
cd /workspace 2>/dev/null || exit 0
nl=$(printf '*\n*')
out=$(timeout ${seconds} find . -xdev \( -path "*/.git" -o -path "*/.git/*" \) \( -type f -printf "F %s\n" -o -true \) -o -path "$nl" -prune -printf "X\n" -o -type d \( ${names.join(" -o ")} \) -printf "D %P\n" -prune -o -type d -name target -execdir test -f Cargo.toml \; -printf "D %P\n" -prune -o -type f -printf "F %s\n" 2>/dev/null | awk '/^D / {d+=1; if (d <= ${REBUILDABLE_WORKSPACE_PATHS_MAX}) dl[d]=$0; next} /^F / {n+=1; s+=$2; next} {x+=1} END {printf "OPENGENI_REBUILDABLE_V1 %d %.0f %d %d\n", n, s, d, x; for (i = 1; i <= d && i <= ${REBUILDABLE_WORKSPACE_PATHS_MAX}; i++) print dl[i]}')
rc=$?
[ "$rc" -le 1 ] || exit 0
printf "%s\n" "$out"`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run.call(target, {
        cmd: `bash -o pipefail -c ${shellQuote(script)}`,
        yieldTimeMs: (seconds + 5) * 1_000,
        maxOutputTokens: 200_000,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), (seconds + 10) * 1_000);
      }),
    ]);
    const lines = stdoutFromExecResult(result).split(/\r?\n/u);
    const summary = lines
      .map((line) =>
        line.trim().match(/^OPENGENI_REBUILDABLE_V1 ([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+)$/u),
      )
      .find((match) => match !== null);
    if (!summary) return null;
    const fileCount = Number(summary[1]);
    const totalFileBytes = Number(summary[2]);
    const folderCount = Number(summary[3]);
    const unparseable = Number(summary[4]);
    if (
      !Number.isSafeInteger(fileCount) ||
      !Number.isFinite(totalFileBytes) ||
      !Number.isSafeInteger(folderCount) ||
      folderCount > REBUILDABLE_WORKSPACE_PATHS_MAX ||
      unparseable !== 0
    ) {
      return null;
    }
    const listed = lines.filter((line) => line.startsWith("D ")).map((line) => line.slice(2));
    const paths = normalizedOmitPaths(listed);
    // Every listed folder must be one the walk was asked for, and the list
    // must be complete (not cut off by the exec's output limit): the kept size
    // counts none of them, so a folder dropped here would be saved uncounted.
    if (
      listed.length !== folderCount ||
      paths.length !== folderCount ||
      !paths.every(isRebuildableWorkspaceFolderName)
    ) {
      return null;
    }
    return { paths, kept: { fileCount, totalFileBytes } };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
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
  const cmd = workspaceFingerprintCommand(
    workspaceFingerprintExcludes(target),
    workspaceFingerprintExcludeGlobs(target),
  );
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

/**
 * A projection-independent description of a workspace tree: every directory by
 * path and every regular file by path and content SHA-256. It verifies an
 * archive restored by a provider whose native fingerprint is not the archive's
 * own (for example a host-backed archive hydrated into a remote sandbox).
 */
export type WorkspaceContentManifest = {
  sha256: string;
  directoryCount: number;
  fileCount: number;
  totalFileBytes: number;
};

export type WorkspaceContentEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; sha256: string; byteSize: number };

/** Records are `d  <path>` or `<sha256>  <path>` (the `sha256sum` line shape),
 * NUL-terminated and ordered by their bytes, so a remote shell computes the
 * identical digest with find, sha256sum -z and `LC_ALL=C sort -z`. */
export function workspaceContentManifest(
  entries: Iterable<WorkspaceContentEntry>,
): WorkspaceContentManifest {
  const records: Buffer[] = [];
  let directoryCount = 0;
  let fileCount = 0;
  let totalFileBytes = 0;
  for (const entry of entries) {
    if (entry.kind === "directory") {
      directoryCount += 1;
      records.push(Buffer.from(`d  ${entry.path}`));
    } else {
      fileCount += 1;
      totalFileBytes += entry.byteSize;
      records.push(Buffer.from(`${entry.sha256}  ${entry.path}`));
    }
  }
  records.sort(Buffer.compare);
  const hash = createHash("sha256");
  for (const record of records) hash.update(record).update("\0");
  return { sha256: hash.digest("hex"), directoryCount, fileCount, totalFileBytes };
}

function workspaceRoot(target: WorkspaceSession): string {
  const root = target.state?.manifest?.root;
  return typeof root === "string" && isAbsolute(root) ? root : "/workspace";
}

function workspaceContentManifestCommand(
  root: string,
  excludedPaths: readonly string[],
  topLevelGlobs: readonly string[] = [],
): string {
  const prune = findPruneExpression(excludedPaths, topLevelGlobs);
  const script = String.raw`set -eu
cd ${shellQuote(root)}
digest=$( { find . -xdev -mindepth 1 ${prune}-type d -printf "d  %P\0"; find . -xdev -mindepth 1 ${prune}-type f -printf "%P\0" | xargs -0 -r sha256sum -z --; } | LC_ALL=C sort -z | sha256sum | awk "{print \$1}")
dirs=$(find . -xdev -mindepth 1 ${prune}-type d -printf x | wc -c | tr -d " ")
files=$(find . -xdev -mindepth 1 ${prune}-type f -printf x | wc -c | tr -d " ")
bytes=$(find . -xdev -mindepth 1 ${prune}-type f -printf "%s\n" | awk "{s+=\$1} END {printf \"%.0f\", s+0}")
printf "OPENGENI_WORKSPACE_CONTENTS_V1 %s %s %s %s\n" "$digest" "$dirs" "$files" "$bytes"`;
  return `bash -o pipefail -c ${shellQuote(script)}`;
}

/** Reads the content manifest of a remote session's persistent workspace,
 * excluding its manifest-declared ephemeral paths. */
export async function readRemoteWorkspaceContentManifest(
  session: unknown,
): Promise<WorkspaceContentManifest> {
  const target = session as WorkspaceSession;
  const run = target.exec ?? target.execCommand;
  if (!run) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "sandbox session cannot execute the workspace content probe",
    );
  }
  const result = await run.call(target, {
    cmd: workspaceContentManifestCommand(
      workspaceRoot(target),
      workspaceFingerprintExcludes(target),
      workspaceFingerprintExcludeGlobs(target),
    ),
    yieldTimeMs: 300_000,
    maxOutputTokens: 1_000,
  });
  const match = stdoutFromExecResult(result)
    .trim()
    .match(/^OPENGENI_WORKSPACE_CONTENTS_V1 ([a-f0-9]{64}) ([0-9]+) ([0-9]+) ([0-9]+)$/);
  if (!match) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      `sandbox workspace content probe returned no valid digest (${execFailureDiagnostic(result)})`,
      { retryable: true },
    );
  }
  const directoryCount = Number(match[2]);
  const fileCount = Number(match[3]);
  const totalFileBytes = Number(match[4]);
  if (![directoryCount, fileCount, totalFileBytes].every(Number.isSafeInteger)) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "sandbox workspace content counters exceeded the supported range",
    );
  }
  return { sha256: match[1]!, directoryCount, fileCount, totalFileBytes };
}

/** Verifies that a remote session's workspace holds exactly `expected`. */
export async function verifyRestoredWorkspaceContents(
  session: unknown,
  expected: WorkspaceContentManifest,
  revision: string,
): Promise<void> {
  const actual = await readRemoteWorkspaceContentManifest(session);
  if (
    actual.sha256 !== expected.sha256 ||
    actual.directoryCount !== expected.directoryCount ||
    actual.fileCount !== expected.fileCount ||
    actual.totalFileBytes !== expected.totalFileBytes
  ) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_mismatch",
      `restored workspace does not match selected archive revision ${revision}`,
    );
  }
}

/** Fingerprints the provider's exact persistent projection. Local/Docker use
 * the SDK's host-backed portable archive projection; remote tar providers use a
 * deterministic GNU-tar stream. Manifest-declared ephemeral paths are excluded
 * in both cases. Only the aggregate enters logs or durable metadata. */
export async function fingerprintSandboxWorkspace(
  session: unknown,
): Promise<WorkspaceTreeFingerprint> {
  const target = session as WorkspaceSession;
  await target.assertWorkspaceCaptureAuthority?.();
  const hostRoot = hostBackedWorkspaceRoot(target);
  return hostRoot
    ? target.workspaceCaptureRootIdentity && process.platform === "linux"
      ? await fingerprintHostWorkspace(
          hostRoot,
          workspaceFingerprintExcludes(target),
          target.workspaceCaptureRootIdentity,
        )
      : await fingerprintHostBackedWorkspace(hostRoot, workspaceFingerprintExcludes(target))
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
  return await withSandboxProviderCapture(
    session,
    async () => await captureVerifiedWorkspaceArchiveExclusive(session, capturedAtMs, options),
    options?.signal,
  );
}

async function captureVerifiedWorkspaceArchiveExclusive(
  session: unknown,
  capturedAtMs: number,
  options?: WorkspaceArchiveCaptureOptions,
): Promise<VerifiedWorkspaceArchive> {
  const omitPaths = normalizedOmitPaths(options?.omitPaths);
  if (omitPaths.length === 0) {
    return await captureVerifiedWorkspaceArchiveWithManifestExclusions(
      session,
      capturedAtMs,
      options,
    );
  }
  // The SDK and the fingerprint both read the manifest's ephemeral paths, so
  // widening them for this one capture leaves the same paths out of the tar
  // and of the before/after comparison. Restored right after, so the live
  // session and its serialized state never keep the reduced exclusions.
  const manifest = (session as WorkspaceSession).state?.manifest;
  const configured = manifest?.ephemeralPersistencePaths;
  if (!manifest || typeof configured !== "function") {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "sandbox session cannot leave paths out of a workspace capture",
    );
  }
  const ownProperty = Object.hasOwn(manifest, "ephemeralPersistencePaths");
  manifest.ephemeralPersistencePaths = () =>
    new Set<unknown>([...configured.call(manifest), ...omitPaths]);
  // The SDK's tar has no provider-side timeout of its own. Bound the reduced
  // save by the caller's hard provider budget so it always settles: a drain
  // that waits on one that never ends could neither retry nor stop the box.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { omitPaths: _omitted, ...captureOptions } = options ?? { requestId: "" };
    const capture = captureVerifiedWorkspaceArchiveWithManifestExclusions(
      session,
      capturedAtMs,
      options ? captureOptions : undefined,
    );
    const boundMs = options?.providerTimeoutMs;
    const archive =
      boundMs !== undefined && Number.isFinite(boundMs) && boundMs > 0
        ? await Promise.race([
            capture,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                const error = new WorkspaceArchiveIntegrityError(
                  "workspace_capture_timeout",
                  `a workspace capture that leaves paths out did not finish within ${boundMs} ms`,
                );
                // The bound ends only the wait: the tar keeps reading inside
                // the box until its command returns. The caller keeps this
                // lease's capture slot until then, so a retry never starts a
                // second tar next to it.
                captureStillRunning.set(
                  error,
                  capture.then(
                    () => undefined,
                    () => undefined,
                  ),
                );
                reject(error);
              }, boundMs);
            }),
          ])
        : await capture;
    if (archive.kind !== "tar" || archive.descriptor.version !== 1) {
      throw new WorkspaceArchiveIntegrityError(
        "native_snapshot_fallback_unverified",
        "a workspace capture that leaves paths out returned a native snapshot",
      );
    }
    return { ...archive, descriptor: { ...archive.descriptor, omittedPaths: omitPaths } };
  } finally {
    if (timer) clearTimeout(timer);
    if (ownProperty) manifest.ephemeralPersistencePaths = configured;
    else delete manifest.ephemeralPersistencePaths;
  }
}

const captureStillRunning = new WeakMap<object, Promise<void>>();

/** For a capture rejected because its bound expired: settles once the
 * capture's own provider command has returned. Null for any other error,
 * whose capture has already settled. */
export function workspaceCaptureStillRunning(error: unknown): Promise<void> | null {
  return typeof error === "object" && error !== null
    ? (captureStillRunning.get(error) ?? null)
    : null;
}

/** Workspace-relative, normalized, de-duplicated and sorted. A path that
 * could name the workspace root or leave it is dropped, never widened. */
function normalizedOmitPaths(paths: readonly string[] | undefined): string[] {
  const accepted = new Set<string>();
  for (const raw of paths ?? []) {
    if (typeof raw !== "string") continue;
    const path = raw.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
    if (
      !path ||
      path.startsWith("/") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      continue;
    }
    accepted.add(path);
  }
  return [...accepted].sort((left, right) => left.localeCompare(right));
}

async function captureVerifiedWorkspaceArchiveWithManifestExclusions(
  session: unknown,
  capturedAtMs: number,
  options?: WorkspaceArchiveCaptureOptions,
): Promise<VerifiedWorkspaceArchive> {
  const target = session as WorkspaceSession;
  await target.assertWorkspaceCaptureAuthority?.();
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
          return process.platform === "linux"
            ? fingerprintHostWorkspace(root, workspaceFingerprintExcludes(target))
            : fingerprintHostBackedWorkspace(root, workspaceFingerprintExcludes(target));
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
