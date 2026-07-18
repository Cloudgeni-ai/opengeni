import { createHash } from "node:crypto";

export const WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION = 1 as const;

export type WorkspaceTreeFingerprint = {
  algorithm: "sha256";
  sha256: string;
  entryCount: number;
  fileCount: number;
  totalFileBytes: number;
};

export type WorkspaceArchiveDescriptor = {
  version: typeof WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION;
  revision: string;
  archiveSha256: string;
  archiveBytes: number;
  capturedAt: string;
  workspace: WorkspaceTreeFingerprint;
};

export type VerifiedWorkspaceArchive = {
  bytes: Uint8Array;
  base64: string;
  descriptor: WorkspaceArchiveDescriptor;
};

export type WorkspaceArchiveIntegrityCode =
  | "archive_metadata_missing"
  | "archive_metadata_invalid"
  | "archive_base64_invalid"
  | "archive_hash_mismatch"
  | "archive_hydration_failed"
  | "workspace_fingerprint_unavailable"
  | "workspace_changed_during_capture"
  | "workspace_fingerprint_mismatch";

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
};

const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^wa1:[0-9]{13}:[a-f0-9]{64}$/;
const FINGERPRINT_MARKER = "OPENGENI_WORKSPACE_FINGERPRINT_V1";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseWorkspaceArchiveDescriptor(value: unknown): WorkspaceArchiveDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WorkspaceArchiveDescriptor>;
  const workspace = candidate.workspace as Partial<WorkspaceTreeFingerprint> | undefined;
  if (
    candidate.version !== WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION ||
    typeof candidate.revision !== "string" ||
    !REVISION.test(candidate.revision) ||
    typeof candidate.archiveSha256 !== "string" ||
    !SHA256.test(candidate.archiveSha256) ||
    !nonnegativeInteger(candidate.archiveBytes) ||
    candidate.archiveBytes === 0 ||
    typeof candidate.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.capturedAt)) ||
    !workspace ||
    workspace.algorithm !== "sha256" ||
    typeof workspace.sha256 !== "string" ||
    !SHA256.test(workspace.sha256) ||
    !nonnegativeInteger(workspace.entryCount) ||
    !nonnegativeInteger(workspace.fileCount) ||
    !nonnegativeInteger(workspace.totalFileBytes)
  ) {
    return null;
  }
  return candidate as WorkspaceArchiveDescriptor;
}

function decodeBase64Strict(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  return Buffer.from(bytes).toString("base64") === value ? bytes : null;
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
  return { bytes, base64, descriptor };
}

function stdoutFromExecResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const output = value as { stdout?: unknown; output?: unknown };
  return typeof output.stdout === "string"
    ? output.stdout
    : typeof output.output === "string"
      ? output.output
      : "";
}

const WORKSPACE_FINGERPRINT_COMMAND = String.raw`bash -o pipefail -c '
set -eu
cd /workspace
digest=$(LC_ALL=C tar --sort=name --mtime="@0" --owner=0 --group=0 --numeric-owner --format=gnu -cf - . | sha256sum | awk "{print \$1}")
entries=$(find . -xdev -mindepth 1 -printf x | wc -c | tr -d " ")
files=$(find . -xdev -type f -printf x | wc -c | tr -d " ")
bytes=$(find . -xdev -type f -printf "%s\n" | awk "{s+=\$1} END {printf \"%.0f\", s+0}")
printf "OPENGENI_WORKSPACE_FINGERPRINT_V1 %s %s %s %s\n" "$digest" "$entries" "$files" "$bytes"
'`;

/** Hashes names, kinds, modes, symlink targets and all file bytes through one
 * deterministic GNU tar stream. Only the aggregate is returned; paths and file
 * contents never enter logs or durable metadata. */
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
    cmd: WORKSPACE_FINGERPRINT_COMMAND,
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

/** Capture is accepted only when the complete tree is byte-identical immediately
 * before and after the provider snapshot. A concurrent mutation makes the
 * candidate non-durable and it is never folded onto the lease. */
export async function captureVerifiedWorkspaceArchive(
  session: unknown,
  capturedAtMs = Date.now(),
): Promise<VerifiedWorkspaceArchive> {
  const target = session as WorkspaceSession;
  if (typeof target.persistWorkspace !== "function") {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_unavailable",
      "sandbox session does not support workspace persistence",
    );
  }
  const before = await fingerprintSandboxWorkspace(target);
  const bytes = await target.persistWorkspace();
  if (!bytes || bytes.length === 0) {
    throw new WorkspaceArchiveIntegrityError(
      "archive_base64_invalid",
      "sandbox workspace persistence returned an empty archive",
      { retryable: true },
    );
  }
  const after = await fingerprintSandboxWorkspace(target);
  if (!fingerprintsEqual(before, after)) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_changed_during_capture",
      "workspace changed while its durable archive was being captured",
      { retryable: true },
    );
  }
  const archiveSha256 = sha256(bytes);
  const descriptor: WorkspaceArchiveDescriptor = {
    version: WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION,
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
  };
}

export async function verifyRestoredWorkspace(
  session: unknown,
  descriptor: WorkspaceArchiveDescriptor,
): Promise<WorkspaceTreeFingerprint> {
  const actual = await fingerprintSandboxWorkspace(session);
  if (!fingerprintsEqual(actual, descriptor.workspace)) {
    throw new WorkspaceArchiveIntegrityError(
      "workspace_fingerprint_mismatch",
      `restored workspace does not match selected archive revision ${descriptor.revision}`,
    );
  }
  return actual;
}
