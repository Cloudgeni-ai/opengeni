import type { FileAsset } from "@opengeni/contracts";

type FileSourceReference = {
  accountId: string;
  workspaceId: string;
  fileId: string;
  sessionId: string | null;
  audienceExplicit: boolean;
};

// Internal provenance for a File object that has already passed an ordinary
// File read or a scoped, human-accepted session attachment read. A WeakMap
// keeps source IDs out of serialized File responses.
const authorizedFileSources = new WeakMap<FileAsset, FileSourceReference>();

export function attachFileSourceReference<T extends FileAsset>(
  file: T,
  source: FileSourceReference,
): T {
  authorizedFileSources.set(file, source);
  return file;
}

export function authorizedFileSourceReference(file: FileAsset): FileSourceReference | null {
  return authorizedFileSources.get(file) ?? null;
}
