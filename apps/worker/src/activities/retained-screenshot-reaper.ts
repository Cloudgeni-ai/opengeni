import type { FileAsset } from "@opengeni/contracts";
import {
  claimRetainedScreenshotMaintenance,
  completeRetainedScreenshotMaintenance,
  promoteRetainedScreenshotMaintenanceCleanup,
  type RetainedScreenshotMaintenanceClaim,
} from "@opengeni/db";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";
import type { ControlActivityServices } from "./types";

export const RETAINED_SCREENSHOT_PENDING_GRACE_MS = 15 * 60 * 1_000;
export const RETAINED_SCREENSHOT_CLAIM_TIMEOUT_MS = 10 * 60 * 1_000;
export const RETAINED_SCREENSHOT_MAINTENANCE_BATCH_SIZE = 100;

export type MaintainRetainedScreenshotsResult = {
  claimed: number;
  ready: number;
  deleted: number;
  failed: number;
  retryable: number;
};

export type RetainedScreenshotMaintenanceActivityOptions = {
  pendingGraceMs?: number;
  claimTimeoutMs?: number;
  batchSize?: number;
  /** Provider seams used by deterministic unit tests. */
  fileExists?: (storage: ObjectStorage, file: FileAsset) => Promise<boolean>;
  headFile?: (storage: ObjectStorage, file: FileAsset) => Promise<ObjectHead>;
  deleteObject?: (storage: ObjectStorage, key: string) => Promise<void>;
};

/**
 * Reconcile interrupted screenshot writes and reap expired screenshot objects.
 * Claims move rows out of the readable `ready`/writable `pending` states before
 * provider access. Provider failures leave the durable claim reclaimable; DB
 * completion happens only after exact metadata verification or an idempotent
 * object delete.
 */
export function createRetainedScreenshotMaintenanceActivities(
  services: () => Promise<ControlActivityServices>,
  options: RetainedScreenshotMaintenanceActivityOptions = {},
) {
  const pendingGraceMs = options.pendingGraceMs ?? RETAINED_SCREENSHOT_PENDING_GRACE_MS;
  const claimTimeoutMs = options.claimTimeoutMs ?? RETAINED_SCREENSHOT_CLAIM_TIMEOUT_MS;
  const batchSize = options.batchSize ?? RETAINED_SCREENSHOT_MAINTENANCE_BATCH_SIZE;
  const fileExists = options.fileExists ?? ((storage, file) => storage.fileExists(file));
  const headFile = options.headFile ?? ((storage, file) => storage.headFile(file));
  const deleteObject = options.deleteObject ?? ((storage, key) => storage.deleteObject(key));

  async function maintainRetainedScreenshots(): Promise<MaintainRetainedScreenshotsResult> {
    const { db, objectStorage, observability } = await services();
    if (!objectStorage) {
      return { claimed: 0, ready: 0, deleted: 0, failed: 0, retryable: 0 };
    }

    const claims = await claimRetainedScreenshotMaintenance(db, {
      pendingGraceMs,
      claimTimeoutMs,
      limit: batchSize,
    });
    const result: MaintainRetainedScreenshotsResult = {
      claimed: claims.length,
      ready: 0,
      deleted: 0,
      failed: 0,
      retryable: 0,
    };

    for (const claim of claims) {
      try {
        if (claim.action === "reconcile") {
          const outcome = await reconcileClaim(db, objectStorage, claim, {
            fileExists,
            headFile,
            deleteObject,
          });
          if (outcome === "ready") {
            result.ready += 1;
          } else {
            result.failed += 1;
          }
          continue;
        }

        await deleteObject(objectStorage, claim.objectKey);
        const outcome = terminalDeleteOutcome(claim.cleanupReason);
        const settled = await completeRetainedScreenshotMaintenance(db, {
          accountId: claim.accountId,
          workspaceId: claim.workspaceId,
          artifactId: claim.artifactId,
          claimId: claim.claimId,
          outcome,
        });
        if (!settled) throw new Error("retained screenshot cleanup claim was superseded");
        result.deleted += 1;
      } catch (error) {
        result.retryable += 1;
        observability.warn("retained screenshot maintenance failed; claim remains reclaimable", {
          workspaceId: claim.workspaceId,
          sessionId: claim.sessionId,
          artifactId: claim.artifactId,
          action: claim.action,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (claims.length > 0) {
      observability.info("retained screenshot maintenance swept", result);
    }
    return result;
  }

  return { maintainRetainedScreenshots };
}

async function reconcileClaim(
  db: Parameters<typeof completeRetainedScreenshotMaintenance>[0],
  storage: ObjectStorage,
  claim: RetainedScreenshotMaintenanceClaim,
  provider: Required<
    Pick<RetainedScreenshotMaintenanceActivityOptions, "fileExists" | "headFile" | "deleteObject">
  >,
): Promise<"ready" | "failed"> {
  const observation = await observeClaimObject(storage, claim, provider);
  if (observation === "matches") {
    const settled = await completeRetainedScreenshotMaintenance(db, {
      accountId: claim.accountId,
      workspaceId: claim.workspaceId,
      artifactId: claim.artifactId,
      claimId: claim.claimId,
      outcome: "ready",
    });
    if (!settled) throw new Error("retained screenshot reconcile claim was superseded");
    return "ready";
  }

  // A mismatch/missing observation cannot authorize provider deletion while
  // the artifact is still eligible for a concurrent ready settlement. Promote
  // the exact claim first; a ready winner clears the claim and makes this stale.
  const promoted = await promoteRetainedScreenshotMaintenanceCleanup(db, {
    accountId: claim.accountId,
    workspaceId: claim.workspaceId,
    artifactId: claim.artifactId,
    claimId: claim.claimId,
    cleanupReason: "failed",
  });
  if (!promoted) throw new Error("retained screenshot reconcile claim was superseded");

  // Deletes are idempotent. Calling it for an authoritative missing observation
  // also closes a race with a late writer that began before cleanup ownership.
  await provider.deleteObject(storage, claim.objectKey);
  const settled = await completeRetainedScreenshotMaintenance(db, {
    accountId: claim.accountId,
    workspaceId: claim.workspaceId,
    artifactId: claim.artifactId,
    claimId: claim.claimId,
    outcome: "failed",
  });
  if (!settled) throw new Error("retained screenshot reconcile claim was superseded");
  return "failed";
}

async function observeClaimObject(
  storage: ObjectStorage,
  claim: RetainedScreenshotMaintenanceClaim,
  provider: Required<Pick<RetainedScreenshotMaintenanceActivityOptions, "fileExists" | "headFile">>,
): Promise<"matches" | "mismatch" | "missing"> {
  const file = claimFile(storage, claim);
  if (!(await provider.fileExists(storage, file))) return "missing";
  const head = await provider.headFile(storage, file);
  return head.ContentLength === claim.sizeBytes &&
    head.ContentType === claim.mediaType &&
    head.Metadata?.sha256 === claim.sha256
    ? "matches"
    : "mismatch";
}

function claimFile(storage: ObjectStorage, claim: RetainedScreenshotMaintenanceClaim): FileAsset {
  const timestamp = new Date(0).toISOString();
  return {
    id: claim.artifactId,
    workspaceId: claim.workspaceId,
    status: "pending_upload",
    filename: `computer-screenshot-${claim.artifactId}.png`,
    safeFilename: `computer-screenshot-${claim.artifactId}.png`,
    contentType: claim.mediaType,
    sizeBytes: claim.sizeBytes,
    sha256: claim.sha256,
    bucket: storage.bucket,
    objectKey: claim.objectKey,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function terminalDeleteOutcome(reason: string | null): "failed" | "expired" | "deleted" {
  if (reason === "expired") return "expired";
  if (reason === "failed") return "failed";
  return "deleted";
}
