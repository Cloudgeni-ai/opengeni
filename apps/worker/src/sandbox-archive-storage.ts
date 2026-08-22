import type { ObjectStorage } from "@opengeni/storage";
import {
  parseWorkspaceArchiveObjectRef,
  workspaceArchiveObjectKey,
  type WorkspaceArchiveDescriptor,
  type WorkspaceArchiveObjectRef,
} from "@opengeni/contracts";

export class WorkspaceArchiveObjectStorageRequiredError extends Error {
  readonly code = "workspace_archive_object_storage_required" as const;

  constructor(backend: string) {
    super(`${backend} workspace archives require object storage`);
    this.name = "WorkspaceArchiveObjectStorageRequiredError";
  }
}

export function collectWorkspaceArchiveObjectKeys(
  resumeState: Record<string, unknown> | null | undefined,
): Set<string> {
  const sessionState =
    resumeState?.sessionState && typeof resumeState.sessionState === "object"
      ? (resumeState.sessionState as Record<string, unknown>)
      : null;
  const keys = new Set<string>();
  for (const value of [sessionState?.workspaceArchiveRef, sessionState?.workspaceArchivePrevRef]) {
    const ref = parseWorkspaceArchiveObjectRef(value);
    if (ref) keys.add(ref.key);
  }
  return keys;
}

export async function putTarWorkspaceArchiveObject(input: {
  objectStorage: ObjectStorage;
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  archive: { bytes: Uint8Array; descriptor: WorkspaceArchiveDescriptor };
}): Promise<WorkspaceArchiveObjectRef> {
  if (input.archive.descriptor.version !== 1) {
    throw new Error("Object-storage workspace archives are portable tar only");
  }
  const key = workspaceArchiveObjectKey({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    revision: input.archive.descriptor.revision,
  });
  await input.objectStorage.putObject({
    key,
    contentType: "application/x-tar",
    body: input.archive.bytes,
    sha256: input.archive.descriptor.archiveSha256,
  });
  return {
    schema: "sandbox_archive_object_v1",
    key,
    sha256: input.archive.descriptor.archiveSha256,
    bytes: input.archive.descriptor.archiveBytes,
    backend: input.objectStorage.backend,
  };
}

export async function putVersion1TarArchiveOrInline(input: {
  backend: string;
  objectStorage?: ObjectStorage | null | undefined;
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  archive: {
    bytes: Uint8Array;
    descriptor: WorkspaceArchiveDescriptor;
    base64: string;
  };
  metrics?: {
    onWorkspaceArchiveObject?: (input: {
      outcome: "put" | "put_failed" | "deleted_unpublished";
      backend: string;
    }) => void;
  };
}): Promise<{
  workspaceArchive?: string;
  workspaceArchiveRef?: WorkspaceArchiveObjectRef;
}> {
  if (input.archive.descriptor.version !== 1) {
    return { workspaceArchive: input.archive.base64 };
  }
  if (input.backend === "opensandbox" && !input.objectStorage) {
    throw new WorkspaceArchiveObjectStorageRequiredError("opensandbox");
  }
  if (!input.objectStorage) {
    return { workspaceArchive: input.archive.base64 };
  }
  try {
    const workspaceArchiveRef = await putTarWorkspaceArchiveObject({
      objectStorage: input.objectStorage,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      archive: { bytes: input.archive.bytes, descriptor: input.archive.descriptor },
    });
    try {
      input.metrics?.onWorkspaceArchiveObject?.({
        outcome: "put",
        backend: input.objectStorage.backend,
      });
    } catch {
      /* metrics must not affect persist */
    }
    console.info("workspace archive object put", {
      key: workspaceArchiveRef.key,
      bytes: workspaceArchiveRef.bytes,
      sha256: workspaceArchiveRef.sha256,
    });
    return { workspaceArchiveRef };
  } catch (error) {
    try {
      input.metrics?.onWorkspaceArchiveObject?.({
        outcome: "put_failed",
        backend: input.objectStorage.backend,
      });
    } catch {
      /* metrics must not affect persist */
    }
    throw error;
  }
}

export async function deleteUnpublishedWorkspaceArchiveObject(
  objectStorage: ObjectStorage | null | undefined,
  ref: WorkspaceArchiveObjectRef | undefined,
  metrics?: {
    onWorkspaceArchiveObject?: (input: { outcome: "deleted_unpublished"; backend: string }) => void;
  },
): Promise<void> {
  if (!objectStorage || !ref) return;
  try {
    await objectStorage.deleteObject(ref.key);
    try {
      metrics?.onWorkspaceArchiveObject?.({
        outcome: "deleted_unpublished",
        backend: objectStorage.backend,
      });
    } catch {
      /* metrics must not affect persist */
    }
  } catch {
    console.error("unpublished workspace archive object delete failed", { key: ref.key });
  }
}

export async function deleteWorkspaceArchiveObjectKeys(
  objectStorage: ObjectStorage,
  keys: Iterable<string>,
): Promise<void> {
  for (const key of keys) {
    await objectStorage.deleteObject(key);
  }
}
