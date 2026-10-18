import {
  acknowledgeScheduledTaskScheduleReconciliation,
  deferScheduledTaskScheduleReconciliation,
  listExhaustedScheduledTasks,
  listScheduledTaskScheduleReconciliations,
  retireExhaustedScheduledTask,
  type Database,
} from "@opengeni/db";
import type { ScheduledTask } from "@opengeni/contracts";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { reviewScheduledTaskBlockerInventory } from "./scheduled-task-blockers";

type Dependencies = {
  db: Database;
  sync(task: Pick<ScheduledTask, "id" | "workspaceId" | "temporalScheduleId">): Promise<void>;
  /** Enables blocked-schedule review: self-pause and the owner notice it posts. */
  bus?: EventBus;
  observability?: Pick<Observability, "error">;
};

export async function reconcileExhaustedScheduledTasks(deps: Dependencies): Promise<void> {
  for (const candidate of await listExhaustedScheduledTasks(deps.db)) {
    await retireExhaustedScheduledTask(deps.db, candidate.workspace_id, candidate.id);
  }
  // Before Temporal reconciliation, so a schedule that paused itself stops
  // firing in the same pass.
  if (deps.bus) {
    await reviewScheduledTaskBlockerInventory({
      db: deps.db,
      bus: deps.bus,
      observability: deps.observability,
    });
  }
  for (const pending of await listScheduledTaskScheduleReconciliations(deps.db)) {
    try {
      // The synchronizer takes the shared external-write lock and rereads the
      // current task, including edits/deletion committed since retirement.
      await deps.sync({
        id: pending.task_id,
        workspaceId: pending.workspace_id,
        temporalScheduleId: pending.temporal_schedule_id,
      });
      await acknowledgeScheduledTaskScheduleReconciliation(
        deps.db,
        pending.workspace_id,
        pending.id,
      );
    } catch (error) {
      await deferScheduledTaskScheduleReconciliation(deps.db, pending.workspace_id, pending.id);
      deps.observability?.error("Exhausted schedule reconciliation will retry", {
        taskId: pending.task_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function startScheduledTaskLifecyclePump(
  deps: Dependencies,
  intervalMs = 30_000,
): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = reconcileExhaustedScheduledTasks(deps)
      .catch((error: unknown) => {
        deps.observability?.error("Exhausted schedule inventory failed", {
          error: error instanceof Error ? error.message : String(error),
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
