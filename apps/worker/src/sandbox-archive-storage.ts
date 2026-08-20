import {
  parseWorkspaceArchiveObjectRef,
  workspaceArchiveObjectKey,
  type WorkspaceArchiveDescriptor,
  type WorkspaceArchiveObjectRef,
} from "@opengeni/contracts";
import type { ObjectStorage } from "@opengeni/storage";

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

export async function deleteWorkspaceArchiveObjectKeys(
  objectStorage: ObjectStorage,
  keys: Iterable<string>,
): Promise<void> {
  for (const key of keys) {
    await objectStorage.deleteObject(key);
  }
}
