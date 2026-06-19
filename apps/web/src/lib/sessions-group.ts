// Pure helpers behind the rail's session list: relative-time labels, recency
// bucketing (Today / Yesterday / Previous 7 days / Older), and the ordering
// rule — RUNNING sessions pinned to the very top, then most-recent activity
// first within each recency group.
import type { Session, SessionStatus } from "@/types";

export type SessionRecencyGroup = "today" | "yesterday" | "previous7" | "older";

export const SESSION_GROUP_LABELS: Record<SessionRecencyGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  previous7: "Previous 7 days",
  older: "Older",
};

/** The render order of recency groups, top → bottom. */
export const SESSION_GROUP_ORDER: SessionRecencyGroup[] = ["today", "yesterday", "previous7", "older"];

/** Live states that earn the pinned-to-top, breathing-dot treatment. */
const RUNNING_STATUSES = new Set<SessionStatus>(["running", "queued", "requires_action"]);

export function isRunningStatus(status: SessionStatus): boolean {
  return RUNNING_STATUSES.has(status);
}

/** Most-recent activity timestamp for a session (updatedAt, then createdAt). */
export function sessionActivityTime(session: Session): number {
  const updated = Date.parse(session.updatedAt);
  if (!Number.isNaN(updated)) {
    return updated;
  }
  const created = Date.parse(session.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

/**
 * Which recency bucket a timestamp falls into, relative to `now`. "Today" and
 * "Yesterday" are calendar-local; "Previous 7 days" is the rest of the trailing
 * week; everything earlier is "Older".
 */
export function recencyGroupFor(timestampMs: number, now: Date = new Date()): SessionRecencyGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeekWindow = startOfToday - 7 * 24 * 60 * 60 * 1000;
  if (timestampMs >= startOfToday) {
    return "today";
  }
  if (timestampMs >= startOfYesterday) {
    return "yesterday";
  }
  if (timestampMs >= startOfWeekWindow) {
    return "previous7";
  }
  return "older";
}

export type SessionRecencyBucket = {
  group: SessionRecencyGroup;
  label: string;
  sessions: Session[];
};

export type GroupedSessions = {
  /** Running sessions, pinned above every recency group, most-recent first. */
  running: Session[];
  /** Non-running sessions bucketed by recency (empty buckets dropped). */
  grouped: SessionRecencyBucket[];
};

/**
 * Order + bucket the sessions for the rail. Running sessions are lifted into a
 * synthetic, always-first position regardless of recency (rendered with a
 * "running" marker); the remainder are bucketed by recency, most-recent first
 * within each bucket. Empty groups are dropped.
 */
export function groupSessionsForRail(sessions: Session[], now: Date = new Date()): GroupedSessions {
  const running = sessions
    .filter((session) => isRunningStatus(session.status))
    .sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a));
  const rest = sessions
    .filter((session) => !isRunningStatus(session.status))
    .sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a));

  const buckets = new Map<SessionRecencyGroup, Session[]>();
  for (const session of rest) {
    const group = recencyGroupFor(sessionActivityTime(session), now);
    const list = buckets.get(group) ?? [];
    list.push(session);
    buckets.set(group, list);
  }

  const grouped: SessionRecencyBucket[] = [];
  for (const group of SESSION_GROUP_ORDER) {
    const list = buckets.get(group);
    if (list && list.length > 0) {
      grouped.push({ group, label: SESSION_GROUP_LABELS[group], sessions: list });
    }
  }
  return { running, grouped };
}

/** Compact relative-time label, e.g. "now", "5m", "3h", "2d", "Mar 4". */
export function relativeTimeLabel(value: string, now: Date = new Date()): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  const diffSeconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  if (diffSeconds < 45) {
    return "now";
  }
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
