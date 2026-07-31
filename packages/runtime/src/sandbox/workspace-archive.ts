import { createHash } from "node:crypto";
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
  persistWorkspace?: () => Promise<Uint8Array | undefined>;
  state?: {
    workspacePersistence?: unknown;
    manifest?: {
      ephemeralPersistencePaths?: () => Set<unknown>;
    };
  };
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function workspaceFingerprintExcludes(session: WorkspaceSession): string[] {
  const paths = session.state?.manifest?.ephemeralPersistencePaths?.();
  if (!paths) return [];
  return [...paths]
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

/** Hashes names, kinds, modes, symlink targets and all file bytes through one
 * deterministic GNU tar stream. Hardlinks are dereferenced deliberately:
 * content-preserving providers may restore them as independent files, and inode
 * topology is not part of OpenGeni's workspace contract. Manifest paths that
 * the provider's tar persistence deliberately excludes are pruned from both the
 * digest and counters, so verification covers the exact persistent projection.
 * Only the aggregate is returned; paths and file contents never enter logs or
 * durable metadata. */
export async function fingerprintSandboxWorkspace(
  session: unknown,
): Promise<WorkspaceTreeFingerprint> {
  const target = session as WorkspaceSession;
  const run = target.exec ?? target.execCommand;
  if (!run) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "sandbox session cannot execute the workspace fingerprint probe",
    );
  }
  const result = await run.call(target, {
    cmd: workspaceFingerprintCommand(workspaceFingerprintExcludes(target)),
    yieldTimeMs: 120_000,
    maxOutputTokens: 1_000,
  });
  const match = stdoutFromExecResult(result)
    .trim()
    .match(/^OPENGENI_WORKSPACE_FINGERPRINT_V1 ([a-f0-9]{64}) ([0-9]+) ([0-9]+) ([0-9]+)$/);
  if (!match) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "sandbox workspace fingerprint probe returned no valid digest",
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

function fingerprintsEqual(a: WorkspaceTreeFingerprint, b: WorkspaceTreeFingerprint): boolean {
  return (
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
): Promise<VerifiedWorkspaceArchive> {
  return await withSandboxProviderCapture(session, async () => {
    return await captureVerifiedWorkspaceArchiveExclusive(session, capturedAtMs);
  });
}

async function captureVerifiedWorkspaceArchiveExclusive(
  session: unknown,
  capturedAtMs: number,
): Promise<VerifiedWorkspaceArchive> {
  const target = session as WorkspaceSession;
  if (typeof target.persistWorkspace !== "function") {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "sandbox session does not support workspace persistence",
    );
  }
  const configuredPersistence = target.state?.workspacePersistence;
  const configuredTarFallback = workspaceFingerprintExcludes(target).length > 0;
  const expectsNativeSnapshot =
    typeof configuredPersistence === "string" &&
    configuredPersistence !== "tar" &&
    !configuredTarFallback;
  const before = expectsNativeSnapshot ? null : await fingerprintSandboxWorkspace(target);
  const bytes = await target.persistWorkspace();
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
  if (!before || !fingerprintsEqual(before, after)) {
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
  const actual = await fingerprintSandboxWorkspace(session);
  if (!fingerprintsEqual(actual, descriptor.workspace)) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_mismatch",
      `restored workspace does not match selected archive revision ${descriptor.revision}`,
    );
  }
  return actual;
}
