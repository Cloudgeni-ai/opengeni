import type { AccessGrant, ScheduledTask as ScheduledTaskValue } from "@opengeni/contracts";
import {
  assertScheduledTaskMutationOwner,
  deleteScheduledTaskLifecycle,
  type ApiRouteDeps,
} from "@opengeni/core";
import { processTemporalScheduleCleanupClaims } from "./temporal-schedule-cleanup";

/** Shared HTTP/MCP domain operation: authorize, tombstone, persist, then accelerate cleanup. */
export async function deleteScheduledTaskWithDurableCleanup(
  deps: ApiRouteDeps,
  request: { grant: AccessGrant; taskId: string },
): Promise<{ task: ScheduledTaskValue; changed: boolean }> {
  const result = await deleteScheduledTaskLifecycle({
    db: deps.db,
    workspaceId: request.grant.workspaceId,
    taskId: request.taskId,
    subjectId: request.grant.subjectId,
    beforeDeleteCommit: (tx) => assertScheduledTaskMutationOwner(tx, request.grant, request.taskId),
    processCleanupClaims: async (claims) => {
      await processTemporalScheduleCleanupClaims(
        {
          db: deps.db,
          deleteSchedule: async (temporalScheduleId) =>
            await deps.workflowClient.deleteScheduledTaskSchedule({ temporalScheduleId }),
        },
        claims,
      );
    },
  });
  return { task: result.task, changed: result.changed };
}
