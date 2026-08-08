import { randomUUID } from "node:crypto";
import {
  claimTemporalScheduleCleanups,
  settleTemporalScheduleCleanup,
  type Database,
  type TemporalScheduleCleanupClaim,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

const CLEANUP_BATCH_SIZE = 32;
const CLEANUP_CLAIM_SECONDS = 15;
const CLEANUP_POLL_INTERVAL_MS = 1_000;

type TemporalScheduleCleanupDependencies = {
  db: Database;
  deleteSchedule: (temporalScheduleId: string) => Promise<void>;
  observability?: Pick<Observability, "info" | "warn" | "error">;
};

export type TemporalScheduleCleanupBatchResult = {
  claimed: number;
  deleted: number;
  failed: number;
  stale: number;
};

function cleanupError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 2000);
  }
  return String(error).slice(0, 2000);
}

/** Settle exact claims concurrently; every external delete is idempotent. */
export async function processTemporalScheduleCleanupClaims(
  deps: TemporalScheduleCleanupDependencies,
  claims: readonly TemporalScheduleCleanupClaim[],
): Promise<TemporalScheduleCleanupBatchResult> {
  const results = await Promise.all(
    claims.map(async (claim): Promise<"deleted" | "failed" | "stale"> => {
      try {
        await deps.deleteSchedule(claim.temporalScheduleId);
        const settled = await settleTemporalScheduleCleanup(deps.db, {
          id: claim.id,
          claimId: claim.claimId,
        });
        return settled ? "deleted" : "stale";
      } catch (error) {
        const message = cleanupError(error);
        try {
          const settled = await settleTemporalScheduleCleanup(deps.db, {
            id: claim.id,
            claimId: claim.claimId,
            error: message,
          });
          if (!settled) return "stale";
        } catch (settlementError) {
          deps.observability?.error("Temporal schedule cleanup settlement failed", {
            cleanupId: claim.id,
            temporalScheduleId: claim.temporalScheduleId,
            attemptCount: claim.attemptCount,
            error: cleanupError(settlementError),
          });
        }
        deps.observability?.warn("Temporal schedule cleanup will retry", {
          cleanupId: claim.id,
          temporalScheduleId: claim.temporalScheduleId,
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

/** Claim and process one globally bounded batch. */
export async function drainTemporalScheduleCleanupOutbox(
  deps: TemporalScheduleCleanupDependencies,
): Promise<TemporalScheduleCleanupBatchResult> {
  const claims = await claimTemporalScheduleCleanups(deps.db, {
    claimId: randomUUID(),
    limit: CLEANUP_BATCH_SIZE,
    claimSeconds: CLEANUP_CLAIM_SECONDS,
  });
  return await processTemporalScheduleCleanupClaims(deps, claims);
}

/**
 * Start one non-overlapping reconciliation loop. PostgreSQL claims coordinate
 * replicas; an API crash merely delays the exact row until its short claim
 * expires.
 */
export function startTemporalScheduleCleanupPump(
  deps: TemporalScheduleCleanupDependencies,
  options: { intervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = Math.max(100, options.intervalMs ?? CLEANUP_POLL_INTERVAL_MS);
  let stopped = false;
  let running: Promise<void> | undefined;

  const tick = (): void => {
    if (stopped || running) return;
    running = drainTemporalScheduleCleanupOutbox(deps)
      .then((result) => {
        if (result.claimed > 0) {
          deps.observability?.info("Temporal schedule cleanup batch settled", result);
        }
      })
      .catch((error: unknown) => {
        deps.observability?.error("Temporal schedule cleanup claim failed", {
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
