import {
  fireWorkspacePauseTimerInTransaction,
  listDueWorkspacePauseTimers,
  withWorkspaceSessionActivityRls,
  getSessionEvent,
  getWorkspaceControlEvent,
} from "@opengeni/db";
import { publishDurableWorkspaceControlEvent } from "@opengeni/events";
import { recordWorkflowWakeReconciliation } from "@opengeni/observability";
import type { ControlActivityServices } from "./types";
import { currentActivityContext } from "./streaming";
import { publishDurableSessionEvents } from "../session-event-fanout";
import {
  reconcileAutomaticSessionTitleFanout,
  reconcilePendingSessionWorkflowWakes,
  type WorkflowWakeReconciliationResult,
} from "./parent-wake";

const BATCH_SIZE = 1_000;
const MAX_DELIVERIES_PER_ACTIVITY = 10_000;
const MAX_TITLE_FANOUT_PER_ACTIVITY = 1_000;

export type DispatchSessionWorkflowWakesResult = WorkflowWakeReconciliationResult & {
  exhaustedBatchLimit: boolean;
};

/** Heartbeat only real progress, never an independent liveness timer. */
export function workflowWakeProgress(context = currentActivityContext()) {
  return (stage: string) => {
    context?.cancellationSignal.throwIfAborted();
    context?.heartbeat({ stage });
  };
}

/**
 * Drain committed session-workflow wake revisions through the same signal and
 * acknowledgement path used by immediate delivery. This is a repair path, not
 * an eligibility scan: producers have already decided what must be delivered.
 */
export function createWorkflowWakeActivities(services: () => Promise<ControlActivityServices>) {
  return {
    // A separate execution owns ancillary producers: they must not hold up
    // delivery of committed prompts while discovery or a broker is blocked.
    async maintainSessionWorkflowWakes(): Promise<void> {
      const service = await services();
      // Timer commits produce ordinary durable wakes for the dispatcher.
      const timers = await listDueWorkspacePauseTimers(service.db, 100);
      for (const timer of timers) {
        try {
          const result = await withWorkspaceSessionActivityRls(
            service.db,
            timer.workspace_id,
            (scoped) =>
              scoped.transaction((tx) =>
                fireWorkspacePauseTimerInTransaction(tx as unknown as typeof scoped, {
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
          // A timed Pause releases capacity waits: their events go out live too.
          const released = await Promise.all(
            (result?.affectedSessionEvents ?? []).flatMap((affected) =>
              affected.eventIds.map((eventId) =>
                getSessionEvent(service.db, timer.workspace_id, eventId),
              ),
            ),
          );
          await publishDurableSessionEvents(
            service.bus,
            timer.workspace_id,
            released.filter((event) => event !== null),
            (error) =>
              service.observability.warn("Workspace pause timer event fanout failed", {
                workspaceId: timer.workspace_id,
                error: String(error),
              }),
          );
        } catch (error) {
          service.observability.warn("Workspace pause timer will retry", {
            workspaceId: timer.workspace_id,
            error: String(error),
          });
        }
      }
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
    },

    async dispatchSessionWorkflowWakes(): Promise<DispatchSessionWorkflowWakesResult> {
      const progress = workflowWakeProgress();
      progress("services");
      const service = await services();
      let claimed = 0;
      let signaled = 0;
      let pendingAdmission = 0;
      let unconfirmed = 0;
      const pendingAdmissionBlockers: WorkflowWakeReconciliationResult["pendingAdmissionBlockers"] =
        {};
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
        const batch = await reconcilePendingSessionWorkflowWakes(service, limit, {}, progress);
        claimed += batch.claimed;
        signaled += batch.signaled;
        delivered += batch.delivered;
        pendingAdmission += batch.pendingAdmission;
        unconfirmed += batch.unconfirmed;
        for (const [blocker, count] of Object.entries(batch.pendingAdmissionBlockers)) {
          const key = blocker as keyof typeof pendingAdmissionBlockers;
          pendingAdmissionBlockers[key] = (pendingAdmissionBlockers[key] ?? 0) + count;
        }
        failed += batch.failed;
        if (batch.claimed < limit) break;
      }

      const result = {
        claimed,
        signaled,
        delivered,
        pendingAdmission,
        unconfirmed,
        failed,
        pendingAdmissionBlockers,
        exhaustedBatchLimit,
      };
      recordWorkflowWakeReconciliation(service.observability, result);
      return result;
    },
  };
}
