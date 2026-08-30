import { randomUUID } from "node:crypto";
import {
  claimAppObjectCleanups,
  reapAbandonedAppUploads,
  settleAppObjectCleanup,
  type AppObjectCleanupClaim,
  type Database,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import type { ObjectStorage } from "@opengeni/storage";

const CLEANUP_BATCH_SIZE = 32;
const CLEANUP_CLAIM_SECONDS = 15;
const CLEANUP_POLL_INTERVAL_MS = 1_000;
const ABANDONED_UPLOAD_REAP_INTERVAL_MS = 60_000;

type AppObjectCleanupDependencies = {
  db: Database;
  objectStorage: Pick<ObjectStorage, "deleteObject">;
  observability?: Pick<Observability, "info" | "warn" | "error">;
};

export type AppObjectCleanupBatchResult = {
  reaped: number;
  claimed: number;
  deleted: number;
  failed: number;
  stale: number;
};

function cleanupError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 2_000);
  return String(error).slice(0, 2_000);
}

export async function processAppObjectCleanupClaims(
  deps: AppObjectCleanupDependencies,
  claims: readonly AppObjectCleanupClaim[],
): Promise<Omit<AppObjectCleanupBatchResult, "reaped">> {
  const results = await Promise.all(
    claims.map(async (claim): Promise<"deleted" | "failed" | "stale"> => {
      try {
        await deps.objectStorage.deleteObject(claim.objectKey);
        const settled = await settleAppObjectCleanup(deps.db, {
          id: claim.id,
          claimId: claim.claimId,
        });
        return settled ? "deleted" : "stale";
      } catch (error) {
        const message = cleanupError(error);
        try {
          const settled = await settleAppObjectCleanup(deps.db, {
            id: claim.id,
            claimId: claim.claimId,
            error: message,
          });
          if (!settled) return "stale";
        } catch (settlementError) {
          deps.observability?.error("App object cleanup settlement failed", {
            cleanupId: claim.id,
            objectKey: claim.objectKey,
            reason: claim.reason,
            attemptCount: claim.attemptCount,
            error: cleanupError(settlementError),
          });
        }
        deps.observability?.warn("App object cleanup will retry", {
          cleanupId: claim.id,
          objectKey: claim.objectKey,
          reason: claim.reason,
          attemptCount: claim.attemptCount,
          error: message,
        });
        return "failed";
      }
    }),
  );
  return {
    claimed: claims.length,
    deleted: results.filter((result) => result === "deleted").length,
    failed: results.filter((result) => result === "failed").length,
    stale: results.filter((result) => result === "stale").length,
  };
}

export async function drainAppObjectCleanupOutbox(
  deps: AppObjectCleanupDependencies,
  options: { reapAbandoned?: boolean } = {},
): Promise<AppObjectCleanupBatchResult> {
  const reaped =
    options.reapAbandoned === false
      ? 0
      : await reapAbandonedAppUploads(deps.db, { limit: CLEANUP_BATCH_SIZE });
  const claims = await claimAppObjectCleanups(deps.db, {
    claimId: randomUUID(),
    limit: CLEANUP_BATCH_SIZE,
    claimSeconds: CLEANUP_CLAIM_SECONDS,
  });
  return {
    reaped,
    ...(await processAppObjectCleanupClaims(deps, claims)),
  };
}

export function startAppObjectCleanupPump(
  deps: AppObjectCleanupDependencies,
  options: { intervalMs?: number; reapIntervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = Math.max(100, options.intervalMs ?? CLEANUP_POLL_INTERVAL_MS);
  const reapIntervalMs = Math.max(
    intervalMs,
    options.reapIntervalMs ?? ABANDONED_UPLOAD_REAP_INTERVAL_MS,
  );
  let stopped = false;
  let running: Promise<void> | undefined;
  let nextReapAt = 0;

  const tick = (): void => {
    if (stopped || running) return;
    const now = Date.now();
    const reapAbandoned = now >= nextReapAt;
    if (reapAbandoned) nextReapAt = now + reapIntervalMs;
    running = drainAppObjectCleanupOutbox(deps, { reapAbandoned })
      .then((result) => {
        if (result.reaped > 0 || result.claimed > 0) {
          deps.observability?.info("App object cleanup batch settled", result);
        }
      })
      .catch((error: unknown) => {
        deps.observability?.error("App object cleanup claim failed", {
          error: cleanupError(error),
        });
      })
      .finally(() => {
        running = undefined;
      });
  };

  const timer = setInterval(tick, intervalMs);
  queueMicrotask(tick);

  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
