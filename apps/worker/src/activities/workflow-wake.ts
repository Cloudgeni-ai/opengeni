import type { ControlActivityServices } from "./types";
import {
  reconcileAutomaticSessionTitleFanout,
  reconcilePendingSessionWorkflowWakes,
} from "./parent-wake";

const BATCH_SIZE = 1_000;
const MAX_DELIVERIES_PER_ACTIVITY = 10_000;
const MAX_TITLE_FANOUT_PER_ACTIVITY = 1_000;

export type DispatchSessionWorkflowWakesResult = {
  claimed: number;
  delivered: number;
  failed: number;
  exhaustedBatchLimit: boolean;
};

/**
 * Drain committed session-workflow wake revisions through the same signal and
 * acknowledgement path used by immediate delivery. This is a repair path, not
 * an eligibility scan: producers have already decided what must be delivered.
 */
export function createWorkflowWakeActivities(services: () => Promise<ControlActivityServices>) {
  return {
    async dispatchSessionWorkflowWakes(): Promise<DispatchSessionWorkflowWakesResult> {
      const service = await services();
      let claimed = 0;
      let delivered = 0;
      let failed = 0;
      let exhaustedBatchLimit = false;
      for (;;) {
        const remaining = MAX_DELIVERIES_PER_ACTIVITY - claimed;
        if (remaining <= 0) {
          exhaustedBatchLimit = true;
          break;
        }
        const limit = Math.min(BATCH_SIZE, remaining);
        const batch = await reconcilePendingSessionWorkflowWakes(service, limit);
        claimed += batch.claimed;
        delivered += batch.delivered;
        failed += batch.failed;
        if (batch.claimed < limit) break;
      }

      // Migration fanout is lower priority than ordinary workflow wakes and is
      // independently capped. Confirmed publishes run with bounded concurrency
      // in the reconciler, so a broker timeout cannot occupy the five-minute
      // activity budget once per quarantined session.
      const titleFanout = await reconcileAutomaticSessionTitleFanout(
        service,
        MAX_TITLE_FANOUT_PER_ACTIVITY,
      );
      if (titleFanout.claimed > 0) {
        service.observability.info("automatic-title migration event fanout reconciled", {
          claimed: titleFanout.claimed,
          delivered: titleFanout.delivered,
          failed: titleFanout.failed,
        });
      }
      return { claimed, delivered, failed, exhaustedBatchLimit };
    },
  };
}
