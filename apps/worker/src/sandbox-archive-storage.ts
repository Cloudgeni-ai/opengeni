import { uploadWorkspaceArchiveSpool, type ObjectStorage } from "@opengeni/storage";
import { randomUUID } from "node:crypto";
import type { VerifiedHostWorkspaceArchive } from "@opengeni/runtime/sandbox";
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
  archive:
    | { bytes: Uint8Array; descriptor: WorkspaceArchiveDescriptor }
    | VerifiedHostWorkspaceArchive;
}): Promise<WorkspaceArchiveObjectRef> {
  // Snapshot caller-owned metadata before any provider callback can mutate it.
  const descriptor = structuredClone(input.archive.descriptor);
  if (descriptor.version !== 1) {
    throw new Error("Object-storage workspace archives are portable tar only");
  }
  const key = workspaceArchiveObjectKey({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    revision: descriptor.revision,
    uploadId: randomUUID(),
  });
  const archive = input.archive;
  if ("spool" in archive) {
    if (
      archive.spool.byteSize !== descriptor.archiveBytes ||
      archive.spool.sha256 !== descriptor.archiveSha256
    ) {
      throw new Error("Workspace archive spool does not match its verified descriptor");
    }
  }
  const source =
    "spool" in archive
      ? archive.spool
      : {
          path: "",
          byteSize: archive.bytes.byteLength,
          sha256: descriptor.archiveSha256,
          async *open() {
            for (let offset = 0; offset < archive.bytes.length; offset += 1024 * 1024)
              yield archive.bytes.subarray(offset, offset + 1024 * 1024);
          },
          async dispose() {},
        };
  try {
    await uploadWorkspaceArchiveSpool(input.objectStorage, key, {
      ...source,
      byteSize: descriptor.archiveBytes,
      sha256: descriptor.archiveSha256,
      open: source.open.bind(source),
    });
  } catch (error) {
    // This fresh locator has never been offered to database publication. An
    // ambiguous provider upload can leave an orphan, never overwrite a retained
    // archive or justify deleting another attempt's object.
    await input.objectStorage.deleteObject(key).catch(() => undefined);
    throw error;
  }
  return {
    schema: "sandbox_archive_object_v1",
    key,
    sha256: descriptor.archiveSha256,
    bytes: descriptor.archiveBytes,
    backend: input.objectStorage.backend,
  };
}

/** The caller owns a fresh candidate returned by this module. A thrown or lost
 * database response is UNKNOWN: it may have committed, so never delete on catch.
 * Only the transaction's exact candidate disposition can authorize cleanup. */
export async function persistWorkspaceArchiveCandidate<
  T extends {
    wrote: boolean;
    candidateDisposition?: "adopted" | "already_referenced" | "unused";
  },
>(input: {
  objectStorage?: ObjectStorage | null;
  ref?: WorkspaceArchiveObjectRef;
  persist: () => Promise<T>;
}): Promise<T> {
  const objectStorage = input.objectStorage;
  const ref = input.ref ? { ...input.ref } : undefined;
  const result = await input.persist();
  if (objectStorage && ref && result.candidateDisposition === "unused") {
    await deleteUnpublishedWorkspaceArchiveObject(objectStorage, ref);
  }
  return result;
}

export async function putVersion1TarArchiveOrInline(input: {
  backend: string;
  objectStorage?: ObjectStorage | null | undefined;
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  archive:
    | VerifiedHostWorkspaceArchive
    | {
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
    if ("spool" in input.archive) throw new Error("Native snapshots cannot use a portable spool");
    return { workspaceArchive: input.archive.base64 };
  }
  if (input.backend === "opensandbox" && !input.objectStorage) {
    throw new WorkspaceArchiveObjectStorageRequiredError("opensandbox");
  }
  if (!input.objectStorage) {
    if ("spool" in input.archive)
      throw new WorkspaceArchiveObjectStorageRequiredError(input.backend);
    return { workspaceArchive: input.archive.base64 };
  }
  try {
    const workspaceArchiveRef = await putTarWorkspaceArchiveObject({
      objectStorage: input.objectStorage,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      archive: input.archive,
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
