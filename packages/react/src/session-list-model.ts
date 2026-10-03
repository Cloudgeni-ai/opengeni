// Pure session-list presentation shared by the web app (rail and recent
// sessions) and native renderers: relative-time labels, recency bucketing
// (Today / Yesterday / Previous 7 days / Older), the running-first ordering
// rule, status tones and the compact row metadata. No DOM, no React.
import type { ClientModel, Session, SessionListEntry, SessionStatus } from "@opengeni/sdk";
import { modelDisplayName } from "@opengeni/sdk/model-display";
import { findPickerRow, type PickerModelRow } from "./model-policy";

/** A list row may be a compact page entry or a complete session response. */
export type SessionListRow = Session | SessionListEntry;

export type SessionRecencyGroup = "today" | "yesterday" | "previous7" | "older";

export const SESSION_GROUP_LABELS: Record<SessionRecencyGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  previous7: "Previous 7 days",
  older: "Older",
};

/** The render order of recency groups, top → bottom. */
export const SESSION_GROUP_ORDER: SessionRecencyGroup[] = [
  "today",
  "yesterday",
  "previous7",
  "older",
];

/** Live states that earn the pinned-to-top, breathing-dot treatment. */
const RUNNING_STATUSES = new Set<SessionStatus>([
  "running",
  "queued",
  "waiting_capacity",
  "recovering",
  "requires_action",
]);

export function isRunningStatus(status: SessionStatus): boolean {
  return RUNNING_STATUSES.has(status);
}

/** An idle session waiting on its own timer, while its control is active. */
export function sessionInputWait(
  session: Pick<SessionListRow, "status" | "effectiveControl" | "inputWait">,
) {
  return session.status === "idle" && session.effectiveControl?.state === "active"
    ? (session.inputWait ?? null)
    : null;
}

export function hasActiveEffectiveControl(session: SessionListRow): boolean {
  return (session.effectiveControl?.state ?? "active") === "active";
}

export function isEffectivelyRunning(session: SessionListRow): boolean {
  // Background commands have their own chat indicator, not agent working status.
  return (
    hasActiveEffectiveControl(session) &&
    (isRunningStatus(session.status) || Boolean(sessionInputWait(session)))
  );
}

/** Most-recent activity timestamp for a session (updatedAt, then createdAt). */
export function sessionActivityTime(session: SessionListRow): number {
  const updated = Date.parse(session.updatedAt);
  if (!Number.isNaN(updated)) {
    return updated;
  }
  const created = Date.parse(session.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

/** Deterministic newest-first ordering for every flat or forest session list. */
export function compareSessionActivity(left: SessionListRow, right: SessionListRow): number {
  return sessionActivityTime(right) - sessionActivityTime(left) || right.id.localeCompare(left.id);
}

/** Deterministic personal-pin order: newest pin first, then descending id. */
export function compareSessionPins(left: SessionListRow, right: SessionListRow): number {
  const leftPinnedAt = Date.parse(left.pinnedAt ?? "");
  const rightPinnedAt = Date.parse(right.pinnedAt ?? "");
  const leftTime = Number.isNaN(leftPinnedAt) ? 0 : leftPinnedAt;
  const rightTime = Number.isNaN(rightPinnedAt) ? 0 : rightPinnedAt;
  return rightTime - leftTime || right.id.localeCompare(left.id);
}

/** Split explicit personal pins from ordinary rows without changing the input. */
export function partitionPinnedSessions<T extends SessionListRow>(
  sessions: T[],
): {
  pinned: T[];
  ordinary: T[];
} {
  const pinned: T[] = [];
  const ordinary: T[] = [];
  for (const session of sessions) {
    (session.pinned ? pinned : ordinary).push(session);
  }
  return { pinned: pinned.sort(compareSessionPins), ordinary };
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

export type SessionRecencyBucket<T extends SessionListRow = SessionListRow> = {
  group: SessionRecencyGroup;
  label: string;
  sessions: T[];
};

export type GroupedSessions<T extends SessionListRow = SessionListRow> = {
  /** Running sessions, pinned above every recency group, most-recent first. */
  running: T[];
  /** Non-running sessions bucketed by recency (empty buckets dropped). */
  grouped: SessionRecencyBucket<T>[];
};

/**
 * Order + bucket the sessions for the rail. Running sessions are lifted into a
 * synthetic, always-first position regardless of recency (rendered with a
 * "running" marker); the remainder are bucketed by recency, most-recent first
 * within each bucket. Empty groups are dropped.
 */
export function groupSessionsForRail<T extends SessionListRow>(
  sessions: T[],
  now: Date = new Date(),
): GroupedSessions<T> {
  const running = sessions.filter(isEffectivelyRunning).sort(compareSessionActivity);
  const rest = sessions
    .filter((session) => !isEffectivelyRunning(session))
    .sort(compareSessionActivity);

  const buckets = new Map<SessionRecencyGroup, T[]>();
  for (const session of rest) {
    const group = recencyGroupFor(sessionActivityTime(session), now);
    const list = buckets.get(group) ?? [];
    list.push(session);
    buckets.set(group, list);
  }

  const grouped: SessionRecencyBucket<T>[] = [];
  for (const group of SESSION_GROUP_ORDER) {
    const list = buckets.get(group);
    if (list && list.length > 0) {
      grouped.push({
        group,
        label: SESSION_GROUP_LABELS[group],
        sessions: list,
      });
    }
  }
  return { running, grouped };
}

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
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Codex subscription product ids are prefixed `codex/`. */
export function isCodexProductModel(modelId: string): boolean {
  return modelId.startsWith("codex/");
}

export type SessionStatusTone = "queued" | "running" | "waiting" | "idle" | "failed" | "cancelled";

export const SESSION_STATUS_TONE: Record<SessionStatus, SessionStatusTone> = {
  queued: "queued",
  running: "running",
  recovering: "running",
  waiting_capacity: "waiting",
  requires_action: "waiting",
  idle: "idle",
  failed: "failed",
  cancelled: "cancelled",
};

/** The status dot of a recent-session row: a background command reads as running. */
export function recentSessionStatus(
  session: Pick<SessionListRow, "status" | "backgroundCommandActivity">,
): { tone: SessionStatusTone; pulse: boolean } {
  const hasBackgroundCommand = session.backgroundCommandActivity !== undefined;
  return {
    tone: hasBackgroundCommand ? "running" : SESSION_STATUS_TONE[session.status],
    pulse: hasBackgroundCommand || session.status === "running",
  };
}

/** A short `owner/repo` label from the session's first repository resource. */
export function sessionRepoLabel(session: Pick<Session, "resources">): string | null {
  const repo = session.resources.find((resource) => resource.kind === "repository");
  if (!repo || repo.kind !== "repository") {
    return null;
  }
  const parts = repo.uri
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : (parts.at(-1) ?? null);
}

export function recentSessionModelPresentation<TCatalog extends ClientModel>(
  modelId: string,
  catalogRows: readonly PickerModelRow<TCatalog>[],
): { label: string; billingClass: PickerModelRow["billingClass"] } {
  const row = findPickerRow([...catalogRows], modelId);
  return {
    label: row?.label ?? modelDisplayName(modelId),
    billingClass:
      row?.billingClass ??
      (isCodexProductModel(modelId) ? "codex_subscription" : "opengeni_credits"),
  };
}

/**
 * The home screen's recent sessions: server pins first, then running, then
 * recency buckets, capped. `sessions` keeps the all-visible-row contract, so
 * its pins are removed before recombining the explicit pinned section.
 */
export function recentSessionsForHome<T extends SessionListRow>(
  sessions: T[],
  pinned: T[],
  limit = 6,
  now: Date = new Date(),
): T[] {
  const ordinary = sessions.filter((session) => !session.pinned);
  const { running, grouped } = groupSessionsForRail(ordinary, now);
  return [...pinned, ...running, ...grouped.flatMap((bucket) => bucket.sessions)].slice(0, limit);
}

export { findPickerRow };
