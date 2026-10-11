import type {
  AccessGrant,
  PrivateScheduledTaskSummary,
  ScheduledTask,
  SessionVisibility,
} from "@opengeni/contracts";
import {
  getPrivateSessionCreatePolicy,
  getScheduledTask,
  getVisibleSessionTenancyVisibility,
  listPrivateScheduledTaskSummaries,
  pausePrivateScheduledTask,
  scheduledTaskViewerSubject,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { hasPermission } from "../access";
import { creationInitiatorForGrant } from "./sessions";

/**
 * Who is reading schedules: the person (or the person an agent acts for), and
 * whether they administer the workspace.
 */
export type ScheduledTaskViewer = { subjectId: string | null; admin: boolean };

/**
 * `full`: everything. `summary`: an admin's view of someone else's Only me
 * schedule (owner, cadence, cost) and pause. `none`: indistinguishable from a
 * schedule that does not exist.
 */
export type ScheduledTaskAccess = "full" | "summary" | "none";

export async function scheduledTaskViewerForGrant(
  db: Database,
  grant: AccessGrant,
): Promise<ScheduledTaskViewer> {
  const creator = creationInitiatorForGrant(grant);
  const subjectId = await scheduledTaskViewerSubject(db, {
    workspaceId: grant.workspaceId,
    ...(creator.initiator ? { createdBy: creator.initiator } : {}),
    ...(creator.context ? { createdByContext: creator.context } : {}),
    createdByActor: creator.actor ?? null,
  });
  return {
    subjectId,
    admin: hasPermission(grant.permissions, "workspace:admin", grant.permissionMode),
  };
}

export function scheduledTaskAccess(
  viewer: ScheduledTaskViewer,
  task: Pick<ScheduledTask, "visibility" | "ownerSubjectId">,
): ScheduledTaskAccess {
  if (task.visibility !== "private") return "full";
  if (viewer.subjectId !== null && task.ownerSubjectId === viewer.subjectId) return "full";
  return viewer.admin ? "summary" : "none";
}

function scheduledTaskNotFound(): HTTPException {
  return new HTTPException(404, { message: "scheduled task not found" });
}

/** A schedule this caller may see in full; anything else is a plain 404. */
export async function requireVisibleScheduledTask(
  db: Database,
  grant: AccessGrant,
  taskId: string,
  viewer?: ScheduledTaskViewer,
): Promise<ScheduledTask> {
  const task = await getScheduledTask(db, grant.workspaceId, taskId);
  if (!task) throw scheduledTaskNotFound();
  const resolved = viewer ?? (await scheduledTaskViewerForGrant(db, grant));
  if (scheduledTaskAccess(resolved, task) !== "full") throw scheduledTaskNotFound();
  return task;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An admin's summary of someone else's Only me schedule, or null. */
export async function privateScheduledTaskSummaryForAdmin(
  db: Database,
  grant: AccessGrant,
  taskId: string,
  viewer: ScheduledTaskViewer,
): Promise<PrivateScheduledTaskSummary | null> {
  if (!viewer.admin || !UUID_PATTERN.test(taskId)) return null;
  const [summary] = await listPrivateScheduledTaskSummaries(db, {
    workspaceId: grant.workspaceId,
    excludeOwnerSubjectId: viewer.subjectId,
    taskId,
  });
  return summary ?? null;
}

/**
 * A schedule this caller may pause: one they see in full, or, for an admin,
 * someone else's Only me schedule, which they only ever see as a summary. That
 * schedule often posts into a chat the admin cannot see, so it is read through
 * the summary and never loaded in full.
 */
export async function requirePausableScheduledTask(
  db: Database,
  grant: AccessGrant,
  taskId: string,
  viewer?: ScheduledTaskViewer,
): Promise<
  | { access: "full"; task: ScheduledTask }
  | { access: "summary"; summary: PrivateScheduledTaskSummary }
> {
  const resolved = viewer ?? (await scheduledTaskViewerForGrant(db, grant));
  const task = await getScheduledTask(db, grant.workspaceId, taskId);
  if (task && scheduledTaskAccess(resolved, task) === "full") return { access: "full", task };
  const summary = await privateScheduledTaskSummaryForAdmin(db, grant, taskId, resolved);
  if (!summary) throw scheduledTaskNotFound();
  return { access: "summary", summary };
}

/**
 * Pause someone else's Only me schedule as a workspace admin and return its
 * refreshed summary. Only its owner can change, run or resume it.
 */
export async function pausePrivateScheduledTaskAsAdmin(
  db: Database,
  grant: AccessGrant,
  taskId: string,
  viewer: ScheduledTaskViewer,
): Promise<PrivateScheduledTaskSummary> {
  if (!viewer.admin) throw scheduledTaskNotFound();
  const paused = await pausePrivateScheduledTask(db, {
    workspaceId: grant.workspaceId,
    taskId,
    excludeOwnerSubjectId: viewer.subjectId,
  });
  const summary = paused
    ? await privateScheduledTaskSummaryForAdmin(db, grant, taskId, viewer)
    : null;
  if (!summary) throw scheduledTaskNotFound();
  return summary;
}

export const SCHEDULED_TASK_PRIVATE_TARGET_MESSAGE =
  "This schedule posts into an Only me chat, so it is Only me too.";
export const SCHEDULED_TASK_PRIVATE_OWNER_MESSAGE = "Only a person can have an Only me schedule.";
export const SCHEDULED_TASK_PRIVATE_DISABLED_MESSAGE =
  "Only me schedules are turned off for this organization.";

/**
 * The audience to store for a created or edited schedule. A schedule that
 * posts into an Only me chat, or writes to its owner's personal knowledge, is
 * always Only me. Choosing Only me needs a human owner who may create Only me
 * chats in this workspace.
 */
export async function resolveScheduledTaskVisibility(input: {
  db: Database;
  grant: AccessGrant;
  requested: SessionVisibility | undefined;
  current: Pick<ScheduledTask, "visibility"> | null;
  targetSessionId: string | null;
  personalKnowledge: boolean;
  ownerSubjectId: string | null;
}): Promise<"user_private" | "workspace_shared"> {
  const targetPrivate =
    input.targetSessionId !== null &&
    (await getVisibleSessionTenancyVisibility(
      input.db,
      input.grant.workspaceId,
      input.targetSessionId,
    )) === "user_private";
  const forced = targetPrivate || input.personalKnowledge;
  if (forced && input.requested === "workspace")
    throw new HTTPException(422, {
      message: targetPrivate
        ? SCHEDULED_TASK_PRIVATE_TARGET_MESSAGE
        : "This schedule saves to your personal knowledge, so it is Only me.",
    });
  const wanted = forced ? "private" : (input.requested ?? input.current?.visibility ?? "workspace");
  if (wanted === "workspace") return "workspace_shared";
  if (!input.ownerSubjectId)
    throw new HTTPException(422, { message: SCHEDULED_TASK_PRIVATE_OWNER_MESSAGE });
  // Narrowing an existing Only me schedule never needs a fresh permission; a
  // newly private one needs the organization to allow Only me.
  if (input.current?.visibility !== "private" && !forced) {
    const policy = await getPrivateSessionCreatePolicy(input.db, {
      workspaceId: input.grant.workspaceId,
      actorSubjectId: input.ownerSubjectId,
    }).catch(() => null);
    const allowed = policy
      ? policy.personalWorkspace
        ? policy.platformAvailable
        : policy.organizationEnabled
      : false;
    if (!allowed)
      throw new HTTPException(403, { message: SCHEDULED_TASK_PRIVATE_DISABLED_MESSAGE });
  }
  return "user_private";
}
