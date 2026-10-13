/** Run-history copy when a scheduled occurrence was refused for its model. */
export const SCHEDULED_RUN_MODEL_UNAVAILABLE_MESSAGE =
  "This task's model is no longer available. Edit the task and choose another model.";

/**
 * Plain run-history text for a recorded scheduled-run error. A refusal for an
 * unavailable model (the durable `scheduled_model_unavailable` reason or the
 * API's "model is not available" text) names the fix; other errors pass
 * through unchanged.
 */
export function scheduledRunErrorText(error: string): string {
  const trimmed = error.trim();
  if (trimmed === "scheduled_session_paused")
    return "This run was skipped because its chat was paused. Open the chat and resume it to allow future runs; skipped runs are not replayed.";
  if (trimmed === "scheduled_session_not_idle")
    return "This run was skipped because its chat was busy. The schedule will try again at its next scheduled time.";
  if (
    trimmed === "scheduled_model_unavailable" ||
    /^model is not available: /.test(trimmed) ||
    /^Turn execution policy model is (?:not present in the configured catalog|retired from new selection|no longer configured)$/.test(
      trimmed,
    )
  ) {
    return SCHEDULED_RUN_MODEL_UNAVAILABLE_MESSAGE;
  }
  return trimmed;
}

/** A recorded skip, not a claim about the chat's live control state. */
export function scheduledRunSkippedForPausedChat(
  run: { status: string; error?: string | null } | null | undefined,
): boolean {
  return run?.status === "skipped" && run.error === "scheduled_session_paused";
}
