import { APP_PACKAGE_EXPORT_TTL_SECONDS } from "@opengeni/contracts";
import { errorMessage } from "@opengeni/contracts/values";
import {
  claimAppPackageExport,
  listDueAppPackageExports,
  recordAppPackageExport as recordExport,
  settleAppPackageExport,
  type Database,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

/**
 * Cleanup of package files `app_export` stores for agents to download
 * (docs/app-packages.md#export-file-cleanup). Each file is recorded with an
 * expiry before it is stored; the sweeper deletes each expired object and
 * then its record. A failed delete keeps the record and retries later.
 */

export async function recordAppPackageExport(
  db: Database,
  input: { accountId: string; workspaceId: string; objectKey: string },
): Promise<void> {
  await recordExport(db, {
    ...input,
    ttlSeconds: APP_PACKAGE_EXPORT_TTL_SECONDS,
  });
}

type SweepDeps = {
  db: Database;
  objectStorage: { deleteObject(key: string): Promise<unknown> } | null | undefined;
  observability?: Pick<Observability, "warn"> | undefined;
};

/** One pass: delete the due objects, then their records. */
export async function sweepAppPackageExports(
  deps: SweepDeps,
  options: { limit?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  const storage = deps.objectStorage;
  if (!storage) return { deleted: 0, failed: 0 };
  const due = await listDueAppPackageExports(deps.db, options.limit ?? 32);
  let deleted = 0;
  let failed = 0;
  for (const entry of due) {
    const claim = await claimAppPackageExport(deps.db, entry).catch(() => null);
    if (!claim) continue;
    try {
      // Deleting a missing object succeeds, so a retry after a lost settle is safe.
      await storage.deleteObject(claim.objectKey);
    } catch (error) {
      failed += 1;
      const message = errorMessage(error).slice(0, 2000) || "Delete failed";
      deps.observability?.warn?.("App package export delete failed; retrying later", {
        exportId: entry.id,
        attempts: claim.attempts,
        error: message,
      });
      await settleAppPackageExport(deps.db, {
        ...entry,
        attempts: claim.attempts,
        error: message,
      });
      continue;
    }
    await settleAppPackageExport(deps.db, {
      ...entry,
      attempts: claim.attempts,
    });
    deleted += 1;
  }
  return { deleted, failed };
}

/** One non-overlapping sweep loop per API replica; row claims coordinate replicas. */
export function startAppPackageExportSweepPump(
  deps: SweepDeps,
  options: { intervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = Math.max(1_000, options.intervalMs ?? 60_000);
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running || !deps.objectStorage) return;
    running = sweepAppPackageExports(deps)
      .then(() => undefined)
      .catch((error: unknown) => {
        deps.observability?.warn?.("App package export sweep failed", {
          error: errorMessage(error),
        });
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
