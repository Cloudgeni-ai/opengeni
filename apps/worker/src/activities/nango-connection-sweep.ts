import { Context } from "@temporalio/activity";
import { sweepNangoConnections } from "@opengeni/core";
import type { ControlActivityServices } from "./types";

export type SweepNangoConnectionsActivityResult = {
  skipped: boolean;
  listed: number;
  deleted: number;
  repointed: number;
  /** Rows whose Nango connection was gone, now asking to reconnect. */
  markedMissing: number;
  skippedPeople: number;
  deferredPeople: number;
  orphanBreakerTripped: boolean;
};

function heartbeat(): void {
  try {
    Context.current().heartbeat();
  } catch {
    // Called outside a Temporal activity (tests, embedded calls).
  }
}

/**
 * The automatic Nango cleanup (docs/nango.md): deletes Nango connections no
 * live Opengeni row stands for, duplicates of one account, and connections
 * Nango can no longer refresh, so nothing stays billed. A no-op when the
 * deployment has no Nango secret key.
 */
export function createNangoConnectionSweepActivities(
  services: () => Promise<ControlActivityServices>,
  options: { sweep?: typeof sweepNangoConnections } = {},
) {
  const sweep = options.sweep ?? sweepNangoConnections;
  return {
    async sweepUnusedNangoConnections(): Promise<SweepNangoConnectionsActivityResult> {
      const { db, settings, observability } = await services();
      let result: Awaited<ReturnType<typeof sweep>> = null;
      try {
        result = settings.nangoSecretKey
          ? await sweep({ db, settings }, { onProgress: heartbeat })
          : null;
      } catch (error) {
        // Nango or the database was unreachable: the next run retries.
        observability.warn("Nango connection sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!result)
        return {
          skipped: true,
          listed: 0,
          deleted: 0,
          repointed: 0,
          markedMissing: 0,
          skippedPeople: 0,
          deferredPeople: 0,
          orphanBreakerTripped: false,
        };
      const summary = {
        skipped: false,
        listed: result.listed,
        deleted:
          result.deletedOrphans.length +
          result.deletedDuplicates.length +
          result.deletedBroken.length,
        repointed: result.repointed,
        markedMissing: result.markedMissing,
        skippedPeople: result.skippedPeople,
        deferredPeople: result.deferredPeople,
        orphanBreakerTripped: result.orphanBreakerTripped,
      };
      // People whose rows could not all be read keep their connections; say so.
      if (summary.skippedPeople > 0 || summary.deferredPeople > 0)
        observability.warn("Nango connection sweep left people for a later pass", {
          skippedPeople: summary.skippedPeople,
          deferredPeople: summary.deferredPeople,
        });
      if (
        summary.deleted > 0 ||
        summary.repointed > 0 ||
        summary.markedMissing > 0 ||
        summary.orphanBreakerTripped
      )
        observability.info("Nango connection sweep", {
          ...summary,
          deletedOrphans: result.deletedOrphans.length,
          deletedDuplicates: result.deletedDuplicates.length,
          deletedBroken: result.deletedBroken.length,
        });
      return summary;
    },
  };
}
