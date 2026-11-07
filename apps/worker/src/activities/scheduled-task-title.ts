import { normalizeAutomaticSessionTitle } from "@opengeni/contracts/session-titles";

/** A run is named after its task; a long task name keeps its existing shortening. */
export function scheduledTaskSessionTitle(taskName: string): string {
  return normalizeAutomaticSessionTitle(taskName, { shorten: true }) ?? "Scheduled run";
}
