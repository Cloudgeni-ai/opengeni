import {
  claimDueTranscriptionRecordingObjectCleanup,
  claimExpiredFileUploadCleanup,
  completeDueTranscriptionRecordingObjectCleanup,
  completeExpiredFileUploadCleanup,
  purgeExpiredTranscriptionRecordings,
} from "@opengeni/db";
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
  claimFileUploads?: typeof claimExpiredFileUploadCleanup;
  completeFileUpload?: typeof completeExpiredFileUploadCleanup;
  claimTranscriptionObjects?: typeof claimDueTranscriptionRecordingObjectCleanup;
  completeTranscriptionObject?: typeof completeDueTranscriptionRecordingObjectCleanup;
  purgeTranscriptionRecordings?: typeof purgeExpiredTranscriptionRecordings;
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
  const claimFileUploads = options.claimFileUploads ?? claimExpiredFileUploadCleanup;
  const completeFileUpload = options.completeFileUpload ?? completeExpiredFileUploadCleanup;
  const claimTranscriptionObjects =
    options.claimTranscriptionObjects ?? claimDueTranscriptionRecordingObjectCleanup;
  const completeTranscriptionObject =
    options.completeTranscriptionObject ?? completeDueTranscriptionRecordingObjectCleanup;
  const purgeTranscriptionRecordings =
    options.purgeTranscriptionRecordings ?? purgeExpiredTranscriptionRecordings;

  async function reapExpiredFileUploads(): Promise<ReapExpiredFileUploadsResult> {
    const { db, objectStorage, observability } = await services();
    if (!objectStorage) {
      try {
        await purgeTranscriptionRecordings(db, { graceMs, limit: batchSize });
      } catch (error) {
        observability.warn("expired transcription recording metadata purge failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { claimed: 0, deleted: 0, failed: 0 };
    }

    const claims = await claimFileUploads(db, {
      graceMs,
      claimTimeoutMs,
      limit: batchSize,
    });
    let deleted = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        await deleteObject(objectStorage, claim.objectKey);
        const settled = await completeFileUpload(db, claim);
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
    const recordingClaims = await claimTranscriptionObjects(db, {
      graceMs,
      claimTimeoutMs,
      limit: batchSize,
    });
    for (const claim of recordingClaims) {
      try {
        await deleteObject(objectStorage, claim.objectKey);
        const settled = await completeTranscriptionObject(db, claim);
        if (!settled) {
          throw new Error("cleanup claim no longer owns a transcription recording object");
        }
        deleted += 1;
      } catch (error) {
        failed += 1;
        observability.warn(
          "expired transcription recording object cleanup failed; claim remains reclaimable",
          {
            workspaceId: claim.workspaceId,
            recordingId: claim.recordingId,
            objectKey: claim.objectKey,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    let transcriptionRecordingsPurged = 0;
    try {
      transcriptionRecordingsPurged = await purgeTranscriptionRecordings(db, {
        graceMs,
        limit: batchSize,
      });
    } catch (error) {
      observability.warn("expired transcription recording metadata purge failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const claimed = claims.length + recordingClaims.length;
    if (claimed > 0 || transcriptionRecordingsPurged > 0) {
      observability.info("expired file upload cleanup swept", {
        claimed,
        deleted,
        failed,
        fileUploads: claims.length,
        transcriptionRecordingObjects: recordingClaims.length,
        transcriptionRecordingsPurged,
      });
    }
    return { claimed, deleted, failed };
  }

  return { reapExpiredFileUploads };
}
