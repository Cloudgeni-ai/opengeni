import type { SessionListPageOptions } from "@opengeni/sdk";

import {
  nodeIsActive,
  recencyGroupFor,
  sessionActivityTime,
  type SessionBrowseDateField,
  type SessionBrowseDateRange,
  type SessionRecencyGroup,
} from "@/lib/sessions-group";
import type { Session } from "@/types";

type CreatorIdentity = Pick<Session["createdBy"], "kind" | "subjectId">;

export type SessionPaginationGroup =
  | {
      key: string;
      label: string;
      kind: "channel";
      channelId: string | null;
    }
  | {
      key: string;
      label: string;
      kind: "activity";
      group: "active" | SessionRecencyGroup;
    }
  | {
      key: string;
      label: string;
      kind: "created";
      group: SessionRecencyGroup;
    }
  | {
      key: string;
      label: string;
      kind: "creator";
      creator: CreatorIdentity;
    }
  | {
      key: string;
      label: string;
      kind: "creatorDiscovery";
      knownCreators: readonly CreatorIdentity[];
    }
  | {
      key: string;
      label: string;
      kind: "results";
    }
  | {
      key: string;
      label: string;
      kind: "archived";
    };

export type SessionPaginationBrowseFilter = {
  creator: CreatorIdentity | null;
  dateField: SessionBrowseDateField;
  dateRange: SessionBrowseDateRange;
};

type SessionPaginationGroupQuery = Pick<
  SessionListPageOptions,
  | "channelId"
  | "createdBy"
  | "updatedFrom"
  | "updatedBefore"
  | "createdFrom"
  | "createdBefore"
  | "archivedOnly"
>;

type TimeBounds = { from?: number; before?: number };

const DAY_MS = 24 * 60 * 60 * 1_000;

function mergeBounds(current: TimeBounds, incoming: TimeBounds): TimeBounds {
  return {
    ...(current.from !== undefined || incoming.from !== undefined
      ? {
          from: Math.max(
            current.from ?? Number.NEGATIVE_INFINITY,
            incoming.from ?? Number.NEGATIVE_INFINITY,
          ),
        }
      : {}),
    ...(current.before !== undefined || incoming.before !== undefined
      ? {
          before: Math.min(
            current.before ?? Number.POSITIVE_INFINITY,
            incoming.before ?? Number.POSITIVE_INFINITY,
          ),
        }
      : {}),
  };
}

function startOfToday(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function recencyBounds(group: SessionRecencyGroup, now: Date): TimeBounds {
  const today = startOfToday(now);
  const yesterday = today - DAY_MS;
  const week = today - 7 * DAY_MS;
  switch (group) {
    case "today":
      return { from: today };
    case "yesterday":
      return { from: yesterday, before: today };
    case "previous7":
      return { from: week, before: yesterday };
    case "older":
      return { before: week };
  }
}

function browseDateBounds(range: SessionBrowseDateRange, now: Date): TimeBounds {
  const today = startOfToday(now);
  switch (range) {
    case "any":
      return {};
    case "today":
      return { from: today };
    case "week":
      return { from: today - 6 * DAY_MS };
    case "month":
      return { from: today - 29 * DAY_MS };
  }
}

function assignBounds(
  target: Pick<
    SessionListPageOptions,
    "updatedFrom" | "updatedBefore" | "createdFrom" | "createdBefore"
  >,
  field: SessionBrowseDateField,
  bounds: TimeBounds,
): void {
  if (field === "activity") {
    if (bounds.from !== undefined) target.updatedFrom = new Date(bounds.from).toISOString();
    if (bounds.before !== undefined) target.updatedBefore = new Date(bounds.before).toISOString();
    return;
  }
  if (bounds.from !== undefined) target.createdFrom = new Date(bounds.from).toISOString();
  if (bounds.before !== undefined) target.createdBefore = new Date(bounds.before).toISOString();
}

/** Exact server filters for one independently paged visible rail group. */
export function sessionPaginationGroupQuery(
  group: SessionPaginationGroup,
  browse: SessionPaginationBrowseFilter,
  now: Date = new Date(),
): SessionPaginationGroupQuery | null {
  if (group.kind === "archived") return { archivedOnly: true };
  const query: SessionPaginationGroupQuery = {};
  let activityBounds: TimeBounds = {};
  let createdBounds: TimeBounds = {};

  if (group.kind === "channel") query.channelId = group.channelId;
  if (group.kind === "creator") query.createdBy = group.creator;
  if (group.kind === "activity" && group.group !== "active") {
    activityBounds = mergeBounds(activityBounds, recencyBounds(group.group, now));
  }
  if (group.kind === "created") {
    createdBounds = mergeBounds(createdBounds, recencyBounds(group.group, now));
  }

  if (browse.creator && group.kind !== "creator") query.createdBy = browse.creator;
  const browseBounds = browseDateBounds(browse.dateRange, now);
  if (browse.dateField === "activity") {
    activityBounds = mergeBounds(activityBounds, browseBounds);
  } else {
    createdBounds = mergeBounds(createdBounds, browseBounds);
  }
  if (
    (activityBounds.from !== undefined &&
      activityBounds.before !== undefined &&
      activityBounds.from >= activityBounds.before) ||
    (createdBounds.from !== undefined &&
      createdBounds.before !== undefined &&
      createdBounds.from >= createdBounds.before)
  ) {
    return null;
  }
  assignBounds(query, "activity", activityBounds);
  assignBounds(query, "created", createdBounds);
  return query;
}

/** Client-side exact group check for filters the list API cannot derive cheaply. */
export function sessionMatchesPaginationGroup(
  session: Session,
  group: SessionPaginationGroup,
  now: Date = new Date(),
): boolean {
  const active = nodeIsActive({ session, children: [], hasActiveDescendant: false });
  switch (group.kind) {
    case "channel":
      return (session.channelId ?? null) === group.channelId;
    case "activity":
      return group.group === "active"
        ? active
        : !active && recencyGroupFor(sessionActivityTime(session), now) === group.group;
    case "created": {
      const createdAt = Date.parse(session.createdAt);
      return (
        !active && recencyGroupFor(Number.isNaN(createdAt) ? 0 : createdAt, now) === group.group
      );
    }
    case "creator":
      return (
        !active &&
        session.createdBy.kind === group.creator.kind &&
        session.createdBy.subjectId === group.creator.subjectId
      );
    case "creatorDiscovery":
      return (
        !active &&
        !group.knownCreators.some(
          (creator) =>
            creator.kind === session.createdBy.kind &&
            creator.subjectId === session.createdBy.subjectId,
        )
      );
    case "results":
    case "archived":
      return true;
  }
}

/** The group-bound cursor generation rotates when the browser's local day changes. */
export function sessionPaginationLocalDateKey(now: Date = new Date()): string {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].join("-");
}
