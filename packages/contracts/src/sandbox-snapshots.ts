export const WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION = 2 as const;

export type WorkspaceTreeFingerprint = {
  algorithm: "sha256";
  sha256: string;
  entryCount: number;
  fileCount: number;
  totalFileBytes: number;
  /**
   * Absent means the original deterministic GNU-tar projection used by remote
   * sandboxes. Host-backed Local/Docker sessions use the Agents SDK's portable
   * archive projection, which intentionally contains directories and regular
   * files only. Keeping the discriminator in the descriptor makes restores
   * stable when a Docker image changes and preserves old descriptor behavior.
   */
  projection?: "sdk_local_archive_v1";
};

export type TarWorkspaceArchiveDescriptor = {
  version: 1;
  revision: string;
  archiveSha256: string;
  archiveBytes: number;
  capturedAt: string;
  workspace: WorkspaceTreeFingerprint;
};

export type NativeSnapshotProvider =
  | "e2b"
  | "modal_snapshot_directory"
  | "modal_snapshot_filesystem"
  | "runloop"
  | "vercel";

export type NativeSnapshotRef = {
  provider: NativeSnapshotProvider;
  snapshotId: string;
  workspacePersistence?: string;
};

export type NativeSnapshotDescriptor = {
  version: typeof WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION;
  kind: "provider_snapshot";
  revision: string;
  archiveSha256: string;
  archiveBytes: number;
  capturedAt: string;
  provider: NativeSnapshotProvider;
  snapshotId: string;
  workspacePersistence?: string;
};

export type WorkspaceArchiveDescriptor = TarWorkspaceArchiveDescriptor | NativeSnapshotDescriptor;

export const NATIVE_SNAPSHOT_PREFIXES: ReadonlyArray<{
  provider: NativeSnapshotProvider;
  prefix: string;
}> = [
  { provider: "e2b", prefix: "E2B_SANDBOX_SNAPSHOT_V1\n" },
  { provider: "modal_snapshot_directory", prefix: "MODAL_SANDBOX_DIR_SNAPSHOT_V1\n" },
  { provider: "modal_snapshot_filesystem", prefix: "MODAL_SANDBOX_FS_SNAPSHOT_V1\n" },
  { provider: "runloop", prefix: "RUNLOOP_SANDBOX_SNAPSHOT_V1\n" },
  { provider: "vercel", prefix: "UC_VERCEL_SNAPSHOT_V1\n" },
];

const SHA256 = /^[a-f0-9]{64}$/;
const TAR_REVISION = /^wa1:([0-9]{13}):([a-f0-9]{64})$/;
const NATIVE_REVISION = /^wa2:([0-9]{13}):([a-f0-9]{64})$/;

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function commonDescriptorFieldsValid(
  candidate: Partial<WorkspaceArchiveDescriptor>,
): candidate is Partial<WorkspaceArchiveDescriptor> & {
  revision: string;
  archiveSha256: string;
  archiveBytes: number;
  capturedAt: string;
} {
  return (
    typeof candidate.revision === "string" &&
    typeof candidate.archiveSha256 === "string" &&
    SHA256.test(candidate.archiveSha256) &&
    nonnegativeInteger(candidate.archiveBytes) &&
    candidate.archiveBytes > 0 &&
    typeof candidate.capturedAt === "string" &&
    Number.isFinite(Date.parse(candidate.capturedAt))
  );
}

function revisionMatchesDescriptor(
  revision: string,
  archiveSha256: string,
  capturedAt: string,
  pattern: RegExp,
): boolean {
  const match = revision.match(pattern);
  return Boolean(
    match && match[2] === archiveSha256 && Number(match[1]) === Date.parse(capturedAt),
  );
}

export function parseWorkspaceArchiveDescriptor(value: unknown): WorkspaceArchiveDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WorkspaceArchiveDescriptor>;
  if (!commonDescriptorFieldsValid(candidate)) return null;

  if (candidate.version === 1) {
    const tar = candidate as Partial<TarWorkspaceArchiveDescriptor>;
    const workspace = tar.workspace as Partial<WorkspaceTreeFingerprint> | undefined;
    if (
      !revisionMatchesDescriptor(
        candidate.revision,
        candidate.archiveSha256,
        candidate.capturedAt,
        TAR_REVISION,
      ) ||
      workspace?.algorithm !== "sha256" ||
      typeof workspace.sha256 !== "string" ||
      !SHA256.test(workspace.sha256) ||
      !nonnegativeInteger(workspace.entryCount) ||
      !nonnegativeInteger(workspace.fileCount) ||
      !nonnegativeInteger(workspace.totalFileBytes) ||
      (workspace.projection !== undefined && workspace.projection !== "sdk_local_archive_v1")
    ) {
      return null;
    }
    return tar as TarWorkspaceArchiveDescriptor;
  }

  if (candidate.version === WORKSPACE_ARCHIVE_DESCRIPTOR_VERSION) {
    const native = candidate as Partial<NativeSnapshotDescriptor>;
    if (
      native.kind !== "provider_snapshot" ||
      !revisionMatchesDescriptor(
        candidate.revision,
        candidate.archiveSha256,
        candidate.capturedAt,
        NATIVE_REVISION,
      ) ||
      !NATIVE_SNAPSHOT_PREFIXES.some((entry) => entry.provider === native.provider) ||
      typeof native.snapshotId !== "string" ||
      native.snapshotId.length === 0 ||
      (native.workspacePersistence !== undefined && typeof native.workspacePersistence !== "string")
    ) {
      return null;
    }
    return native as NativeSnapshotDescriptor;
  }

  return null;
}

export function decodeNativeSnapshotRef(bytes: Uint8Array): NativeSnapshotRef | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  for (const entry of NATIVE_SNAPSHOT_PREFIXES) {
    if (!text.startsWith(entry.prefix)) continue;
    try {
      const payload = JSON.parse(text.slice(entry.prefix.length)) as {
        snapshot_id?: unknown;
        workspace_persistence?: unknown;
      };
      if (typeof payload.snapshot_id !== "string" || payload.snapshot_id.length === 0) {
        return null;
      }
      if (
        payload.workspace_persistence !== undefined &&
        typeof payload.workspace_persistence !== "string"
      ) {
        return null;
      }
      return {
        provider: entry.provider,
        snapshotId: payload.snapshot_id,
        ...(typeof payload.workspace_persistence === "string"
          ? { workspacePersistence: payload.workspace_persistence }
          : {}),
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function backendForNativeSnapshotProvider(provider: NativeSnapshotProvider): string {
  return provider === "modal_snapshot_directory" || provider === "modal_snapshot_filesystem"
    ? "modal"
    : provider;
}
