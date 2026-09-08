import {
  fireWorkspacePauseTimerInTransaction,
  listDueWorkspacePauseTimers,
  withWorkspaceRls,
  getWorkspaceControlEvent,
  type Database,
} from "@opengeni/db";
import { publishDurableWorkspaceControlEvent } from "@opengeni/events";
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
      // Timer commits produce ordinary durable wakes; drain those below in the same sweep.
      const timers = await listDueWorkspacePauseTimers(service.db, 100);
      for (const timer of timers) {
        try {
          const result = await withWorkspaceRls(service.db, timer.workspace_id, (scoped) =>
            scoped.transaction((tx) =>
              fireWorkspacePauseTimerInTransaction(tx as unknown as Database, {
                workspaceId: timer.workspace_id,
                timerId: timer.timer_id,
              }),
            ),
          );
          if (result?.workspaceControlEventId) {
            const event = await getWorkspaceControlEvent(
              service.db,
              timer.workspace_id,
              result.workspaceControlEventId,
            );
            if (event)
              await publishDurableWorkspaceControlEvent(service.bus, timer.workspace_id, event);
          }
        } catch (error) {
          service.observability.warn("Workspace pause timer will retry", {
            workspaceId: timer.workspace_id,
            error: String(error),
          });
        }
      }
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
      // independently capped. Delivery acknowledgements run with bounded
      // concurrency in the reconciler, so a broker timeout cannot occupy the
      // five-minute activity budget once per quarantined session. Managed NATS
      // uses its bounded confirmed publish; embedding buses use their required
      // publish promise.
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
