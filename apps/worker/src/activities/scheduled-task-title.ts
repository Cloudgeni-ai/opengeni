import { normalizeAutomaticSessionTitle } from "@opengeni/contracts/session-titles";

export function scheduledTaskSessionTitle(taskName: string): string {
  return normalizeAutomaticSessionTitle(taskName) ?? "Scheduled run";
}
