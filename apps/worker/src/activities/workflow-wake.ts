import type { ActivityServices } from "./types";
import { reconcilePendingSessionWorkflowWakes } from "./parent-wake";

const BATCH_SIZE = 1_000;
const MAX_DELIVERIES_PER_ACTIVITY = 10_000;

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
export function createWorkflowWakeActivities(services: () => Promise<ActivityServices>) {
  return {
    async dispatchSessionWorkflowWakes(): Promise<DispatchSessionWorkflowWakesResult> {
      const service = await services();
      let claimed = 0;
      let delivered = 0;
      let failed = 0;
      for (;;) {
        const remaining = MAX_DELIVERIES_PER_ACTIVITY - claimed;
        if (remaining <= 0) {
          return { claimed, delivered, failed, exhaustedBatchLimit: true };
        }
        const batch = await reconcilePendingSessionWorkflowWakes(
          service,
          Math.min(BATCH_SIZE, remaining),
        );
        claimed += batch.claimed;
        delivered += batch.delivered;
        failed += batch.failed;
        if (batch.claimed < Math.min(BATCH_SIZE, remaining)) {
          return { claimed, delivered, failed, exhaustedBatchLimit: false };
        }
      }
    },
  };
}
