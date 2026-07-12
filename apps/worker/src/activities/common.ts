import type {
  ResourceRef,
  ScheduledTask,
  Session,
  SessionStatus,
  ToolRef,
} from "@opengeni/contracts";

export {
  mergeResourceRefs,
  mergeToolRefs,
  reasoningEffortForMetadata as reasoningEffortForSession,
} from "@opengeni/contracts";

/**
 * Refuse to revive a terminal reusable session on a scheduled fire. Mirrors the
 * API-level guard in apps/api/src/domain/sessions.ts (post a user message ->
 * 409 when cancelled): "cancelled" is the one terminal state, an explicit user
 * act, so a recurring task must NOT silently resurrect and re-bill it. Failed
 * and idle sessions stay revivable (talking to a session is how it resumes), so
 * only "cancelled" is rejected. Throwing inside the FOR UPDATE locked-update
 * callback aborts the whole append+enqueue transaction atomically, and the
 * dispatch catch marks the scheduled_task_run "failed" rather than dispatched.
 */
export function assertReusableSessionRevivable(status: SessionStatus): void {
  if (status === "cancelled") {
    throw new Error("reusable session is cancelled; refusing to revive on scheduled fire");
  }
}

/** Re-check targeted-session attachment invariants at fire time. */
export function assertScheduledTaskTargetCompatible(
  session: Session,
  task: Pick<ScheduledTask, "variableSetId" | "rigId" | "agentConfig">,
): void {
  if ((session.variableSetId ?? null) !== (task.variableSetId ?? null)) {
    throw new Error("scheduled task variableSet attachment does not match its target session");
  }
  if (task.rigId && task.rigId !== session.rigId) {
    throw new Error("scheduled task rig does not match its target session");
  }
  if (
    task.agentConfig.sandboxBackend !== undefined &&
    task.agentConfig.sandboxBackend !== session.sandboxBackend
  ) {
    throw new Error("scheduled task sandbox backend does not match its target session");
  }
}

export function scheduledUserMessagePayload(
  prompt: string,
  resources: ResourceRef[],
  tools: ToolRef[],
  taskId: string,
  runId: string,
): Record<string, unknown> {
  return {
    text: prompt,
    scheduledTaskId: taskId,
    scheduledTaskRunId: runId,
    ...(resources.length ? { resources } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

export function workflowIdForSession(sessionId: string): string {
  return `session-${sessionId}`;
}
