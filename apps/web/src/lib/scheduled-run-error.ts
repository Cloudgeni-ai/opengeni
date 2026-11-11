import { t } from "@opengeni/react/app/lib/console-text";
import { automationRunErrorText } from "@opengeni/react/automations";

/**
 * Plain run-history text for a recorded run error, in the same words as the
 * embeddable Automations panel: a known reason code reads as a sentence that
 * names the fix where there is one, and an unknown code never shows as code.
 */
export function scheduledRunErrorText(error: string): string {
  return automationRunErrorText(t, error);
}

/** A recorded skip, not a claim about the chat's live control state. */
export function scheduledRunSkippedForPausedChat(
  run: { status: string; error?: string | null } | null | undefined,
): boolean {
  return run?.status === "skipped" && run.error === "scheduled_session_paused";
}
