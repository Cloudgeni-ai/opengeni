import type {
  ResourceRef,
  SessionStatus,
  SessionSystemUpdatePayload,
  ToolRef,
} from "@opengeni/contracts";

export { mergeResourceRefs, mergeToolRefs } from "@opengeni/contracts";

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

export function scheduledUserMessagePayload(
  prompt: string,
  resources: ResourceRef[],
  tools: ToolRef[],
  taskId: string,
  runId: string,
  degradedAccounts: readonly { serverId: string }[] = [],
): Extract<SessionSystemUpdatePayload, { type: "scheduled_occurrence" }> {
  // Connectors this occurrence runs without because every account a person
  // pinned for them is unusable. A connector that kept a working pin still has
  // its tools and is not named.
  const unavailableConnectors = [
    ...new Set(
      degradedAccounts
        .map((account) => account.serverId)
        .filter((serverId) => !tools.some((tool) => tool.kind === "mcp" && tool.id === serverId)),
    ),
  ].sort();
  return {
    type: "scheduled_occurrence",
    text: prompt,
    scheduledTaskId: taskId,
    scheduledTaskRunId: runId,
    ...(resources.length ? { resources } : {}),
    ...(tools.length ? { tools } : {}),
    ...(unavailableConnectors.length ? { unavailableConnectors } : {}),
  };
}

export function workflowIdForSession(sessionId: string): string {
  return `session-${sessionId}`;
}
