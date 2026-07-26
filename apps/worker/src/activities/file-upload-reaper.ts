import { claimExpiredFileUploadCleanup, completeExpiredFileUploadCleanup } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import type { ActivityServices } from "./types";

export const FILE_UPLOAD_CLEANUP_GRACE_MS = 60 * 60 * 1_000;
export const FILE_UPLOAD_CLEANUP_CLAIM_TIMEOUT_MS = 10 * 60 * 1_000;
export const FILE_UPLOAD_CLEANUP_BATCH_SIZE = 100;

export type ReapExpiredFileUploadsResult = {
  claimed: number;
  deleted: number;
  failed: number;
};

export type FileUploadReaperActivityOptions = {
  graceMs?: number;
  claimTimeoutMs?: number;
  batchSize?: number;
  /** Failure-injection seam; production uses the configured provider delete. */
  deleteObject?: (storage: ObjectStorage, key: string) => Promise<void>;
};

/**
 * Build the provider-neutral expired direct-upload reaper. Claims are durable
 * and reclaimable; object deletion is idempotent; only a successful delete is
 * settled terminally. One provider failure never aborts the rest of the batch.
 */
export function createFileUploadReaperActivities(
  services: () => Promise<ActivityServices>,
  options: FileUploadReaperActivityOptions = {},
) {
  const graceMs = options.graceMs ?? FILE_UPLOAD_CLEANUP_GRACE_MS;
  const claimTimeoutMs = options.claimTimeoutMs ?? FILE_UPLOAD_CLEANUP_CLAIM_TIMEOUT_MS;
  const batchSize = options.batchSize ?? FILE_UPLOAD_CLEANUP_BATCH_SIZE;
  const deleteObject = options.deleteObject ?? (async (storage, key) => storage.deleteObject(key));

  async function reapExpiredFileUploads(): Promise<ReapExpiredFileUploadsResult> {
    const { db, objectStorage, observability } = await services();
    if (!objectStorage) {
      return { claimed: 0, deleted: 0, failed: 0 };
    }

    const claims = await claimExpiredFileUploadCleanup(db, {
      graceMs,
      claimTimeoutMs,
      limit: batchSize,
    });
    let deleted = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        await deleteObject(objectStorage, claim.objectKey);
        const settled = await completeExpiredFileUploadCleanup(db, claim);
        if (!settled) {
          throw new Error("cleanup claim no longer owns a reclaimable upload");
        }
        deleted += 1;
      } catch (error) {
        failed += 1;
        observability.warn("expired file upload cleanup failed; claim remains reclaimable", {
          workspaceId: claim.workspaceId,
          uploadId: claim.uploadId,
          fileId: claim.fileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (claims.length > 0) {
      observability.info("expired file upload cleanup swept", {
        claimed: claims.length,
        deleted,
        failed,
      });
    }
    return { claimed: claims.length, deleted, failed };
  }

  return { reapExpiredFileUploads };
}
