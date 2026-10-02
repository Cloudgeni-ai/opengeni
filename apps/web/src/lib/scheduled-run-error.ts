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
