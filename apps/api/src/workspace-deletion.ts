import { deleteWorkspaceIfQuiescent, nestedPostgresSqlState } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";

import { processTemporalScheduleCleanupClaims } from "./temporal-schedule-cleanup";
import { workspaceDeleteObserver } from "./workspace-delete-observability";

export async function deleteWorkspaceForRequest(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    organizationAdministratorSubjectId?: string;
  },
): Promise<void> {
  const observer = workspaceDeleteObserver(deps.observability, input);
  let deleted;
  try {
    deleted = await deleteWorkspaceIfQuiescent(deps.db, {
      ...input,
      ...(observer ? { observer } : {}),
    });
  } catch (error) {
    const state = nestedPostgresSqlState(error);
    if (state === "42501") {
      throw new HTTPException(403, { message: "organization administration is not authorized" });
    }
    if (state === "P0002") {
      throw new HTTPException(404, { message: "workspace not found" });
    }
    throw error;
  }

  if (deleted.status === "not_found") {
    throw new HTTPException(404, { message: "workspace not found" });
  }
  const conflicts = {
    only_workspace: "cannot delete the account's only workspace",
    active_sessions: "stop the workspace's running sessions before deleting it",
    active_video_generations:
      "wait for the workspace's active video generations to finish before deleting it",
    active_background_commands:
      "pause or cancel the workspace's background commands before deleting it",
    live_sandboxes:
      "wait for the workspace's active sandboxes to finish draining before deleting it",
  } as const;
  if (deleted.status in conflicts) {
    throw new HTTPException(409, { message: conflicts[deleted.status as keyof typeof conflicts] });
  }
  if (deleted.status !== "deleted") {
    throw new Error(`Unhandled workspace deletion outcome: ${deleted.status}`);
  }

  await processTemporalScheduleCleanupClaims(
    {
      db: deps.db,
      deleteSchedule: async (temporalScheduleId) => {
        await deps.workflowClient.deleteScheduledTaskSchedule({ temporalScheduleId });
      },
      ...(deps.observability ? { observability: deps.observability } : {}),
    },
    deleted.temporalScheduleCleanups,
  );
}
