import {
  acknowledgeScheduledTaskScheduleReconciliation,
  deferScheduledTaskScheduleReconciliation,
  listExhaustedScheduledTasks,
  listScheduledTaskScheduleReconciliations,
  retireExhaustedScheduledTask,
  type Database,
} from "@opengeni/db";
import type { ScheduledTask } from "@opengeni/contracts";
import type { Observability } from "@opengeni/observability";

type Dependencies = {
  db: Database;
  sync(task: Pick<ScheduledTask, "id" | "workspaceId" | "temporalScheduleId">): Promise<void>;
  observability?: Pick<Observability, "error">;
};

export async function reconcileExhaustedScheduledTasks(deps: Dependencies): Promise<void> {
  for (const candidate of await listExhaustedScheduledTasks(deps.db)) {
    await retireExhaustedScheduledTask(deps.db, candidate.workspace_id, candidate.id);
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
