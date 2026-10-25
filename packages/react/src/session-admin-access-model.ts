import type { SessionAdminAccess } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Full access for one session (named "admin access" in the API), shared by
   the web header and the phone app: the time limits offered and the words
   that say who gave it and when it ends.
   -------------------------------------------------------------------------- */

/** How long full access lasts, as offered in the apps. */
export type AdminAccessDuration = "1" | "8" | "24" | "none";

export const ADMIN_ACCESS_DURATIONS: ReadonlyArray<{
  value: AdminAccessDuration;
  label: string;
}> = [
  { value: "1", label: "1 hour" },
  { value: "8", label: "8 hours" },
  { value: "24", label: "1 day" },
  { value: "none", label: "No limit" },
];

/** The `durationHours` to send for a duration: null means no time limit. */
export function adminAccessDurationHours(duration: AdminAccessDuration): number | null {
  return duration === "none" ? null : Number(duration);
}

/** "Ends at 21:30", "Ends tomorrow at 09:00", "Ends Oct 14 at 09:00" or "No time limit". */
export function endsText(expiresAt: string | null, now: Date = new Date()): string {
  if (!expiresAt) return "No time limit";
  const end = new Date(expiresAt);
  if (Number.isNaN(end.getTime())) return "No time limit";
  const time = end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((day(end).getTime() - day(now).getTime()) / 86_400_000);
  if (days <= 0) return `Ends at ${time}`;
  if (days === 1) return `Ends tomorrow at ${time}`;
  const date = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Ends ${date} at ${time}`;
}

/** Who the agent acts as while full access is on. */
export function adminAccessGrantedByText(state: SessionAdminAccess): string {
  const name = state.grantedBy?.name;
  return name
    ? `This agent can do what ${name} can in the app, and acts as them.`
    : "This agent can do what the person who gave it access can in the app, and acts as them.";
}

/** What giving full access means, shown before it is given. */
export const ADMIN_ACCESS_GRANT_DESCRIPTION =
  "Its agent can then do what you can in the app: your chats, workspace settings, connections and anything else you manage. Everything it does runs as you, and never goes beyond your own access.";
