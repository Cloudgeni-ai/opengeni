import {
  claimBrowserStateArtifactCleanup,
  claimBrowserStateUploadCleanup,
  completeBrowserStateArtifactCleanup,
  completeBrowserStateUploadCleanup,
  type BrowserStateArtifactCleanupClaim,
  type BrowserStateUploadCleanupClaim,
} from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import type { ControlActivityServices } from "./types";

export const BROWSER_STATE_ARTIFACT_CLAIM_TIMEOUT_MS = 10 * 60 * 1_000;
export const BROWSER_STATE_ARTIFACT_CLEANUP_BATCH_SIZE = 100;

const SAFE_PROVIDER_ERROR_CODES = new Set([
  "aborted",
  "conflict",
  "network",
  "not_found",
  "permission_denied",
  "provider",
  "timeout",
  "unavailable",
]);

export type MaintainBrowserStateArtifactsResult = {
  claimed: number;
  deleted: number;
  retryable: number;
};

export type BrowserStateArtifactMaintenanceOptions = {
  claimTimeoutMs?: number;
  batchSize?: number;
  claimArtifacts?: typeof claimBrowserStateArtifactCleanup;
  completeArtifact?: typeof completeBrowserStateArtifactCleanup;
  claimUploads?: typeof claimBrowserStateUploadCleanup;
  completeUpload?: typeof completeBrowserStateUploadCleanup;
  /** Failure-injection seam; production uses the configured provider delete. */
  deleteObject?: (storage: ObjectStorage, key: string) => Promise<void>;
};

/**
 * Reap retired encrypted private browser checkpoints. Provider deletion happens
 * before terminal settlement; a crash or provider failure leaves the durable
 * claim reclaimable and an already-deleted provider key is safe to retry.
 */
export function createBrowserStateArtifactMaintenanceActivities(
  services: () => Promise<ControlActivityServices>,
  options: BrowserStateArtifactMaintenanceOptions = {},
) {
  const claimTimeoutMs = options.claimTimeoutMs ?? BROWSER_STATE_ARTIFACT_CLAIM_TIMEOUT_MS;
  const batchSize = options.batchSize ?? BROWSER_STATE_ARTIFACT_CLEANUP_BATCH_SIZE;
  const claimArtifacts = options.claimArtifacts ?? claimBrowserStateArtifactCleanup;
  const completeArtifact = options.completeArtifact ?? completeBrowserStateArtifactCleanup;
  const claimUploads = options.claimUploads ?? claimBrowserStateUploadCleanup;
  const completeUpload = options.completeUpload ?? completeBrowserStateUploadCleanup;
  const deleteObject = options.deleteObject ?? ((storage, key) => storage.deleteObject(key));

  async function maintainBrowserStateArtifacts(): Promise<MaintainBrowserStateArtifactsResult> {
    const { db, objectStorage, observability } = await services();
    if (!objectStorage) return { claimed: 0, deleted: 0, retryable: 0 };

    const [artifactClaims, uploadClaims] = await Promise.all([
      claimArtifacts(db, { claimTimeoutMs, limit: batchSize }),
      claimUploads(db, { claimTimeoutMs, limit: batchSize }),
    ]);
    const result: MaintainBrowserStateArtifactsResult = {
      claimed: artifactClaims.length + uploadClaims.length,
      deleted: 0,
      retryable: 0,
    };
    for (const cleanup of artifactClaims) {
      try {
        await deleteObject(objectStorage, cleanup.objectKey);
        if (!(await completeArtifact(db, cleanup))) {
          throw new Error("browser state artifact cleanup claim was superseded");
        }
        result.deleted += 1;
      } catch (error) {
        result.retryable += 1;
        observability.warn("browser state artifact cleanup failed; claim remains reclaimable", {
          workspaceId: cleanup.workspaceId,
          artifactId: cleanup.artifactId,
          errorCategory: cleanupErrorCategory(error),
        });
      }
    }
    for (const cleanup of uploadClaims) {
      try {
        await deleteObject(objectStorage, cleanup.objectKey);
        if (!(await completeUpload(db, cleanup))) {
          throw new Error("browser state upload cleanup claim was superseded");
        }
        result.deleted += 1;
      } catch (error) {
        result.retryable += 1;
        observability.warn("browser state upload cleanup failed; claim remains reclaimable", {
          workspaceId: cleanup.workspaceId,
          uploadId: cleanup.uploadId,
          errorCategory: cleanupErrorCategory(error),
        });
      }
    }
    if (result.claimed > 0) {
      observability.info("browser state artifact maintenance swept", result);
    }
    return result;
  }

  return { maintainBrowserStateArtifacts };
}

function cleanupErrorCategory(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SAFE_PROVIDER_ERROR_CODES.has(code) ? code : "unknown";
}

export type { BrowserStateArtifactCleanupClaim, BrowserStateUploadCleanupClaim };
