// Pure presentation decisions for a timeline turn's work, shared by the web and native
// timelines. Every function here is extracted verbatim from the web MessageTimeline so both
// renderers decide identically what a turn shows (preparing, working, waiting, worked).
import { timelineGroupContainsPresentedImage } from "./presented-image";
import type { TurnSummaryStatus } from "./turn-summary-model";
import type { ActivityItem, TimelineGroup, ToolCallItem } from "./types";

export type ActivityGroup = Extract<TimelineGroup, { kind: "activity" }>;
export type TurnGroup = Extract<TimelineGroup, { kind: "turn" }>;

export function durationBetween(startedAt: string, endedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    return undefined;
  }
  return ended - started;
}

/** Compaction landmarks among a fold's groups (secondary summary facet). */
export function compactedLandmarkCount(groups: readonly TimelineGroup[]): number {
  return groups.filter(
    (group) =>
      group.kind === "item" &&
      group.item.kind === "context-compaction" &&
      group.item.phase === "compacted",
  ).length;
}

export function clusterIsSettled(group: ActivityGroup): boolean {
  return group.items.every((item) => {
    if (item.kind === "reasoning" || item.kind === "agent-message") {
      return !item.streaming;
    }
    // Memory writes and fleet observations are discrete, already-settled events.
    if (item.kind === "memory" || item.kind === "fleet-decision") {
      return true;
    }
    return item.status !== "running";
  });
}

export function flattenActivityItems(groups: readonly TimelineGroup[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const group of groups) {
    if (group.kind === "activity") {
      items.push(...flattenActivityItems(group.work?.details ?? []), ...group.items);
    } else if (group.kind === "turn") {
      items.push(...flattenActivityItems(group.groups));
    }
  }
  return items;
}

export type ReadableWorkOptions = {
  /** Host shows startup phases as ordinary details (web: startup-details context). */
  startupDetails: boolean;
  /** Startup chrome was dismissed by the reader. */
  startupDismissed: boolean;
};

/**
 * A readable turn whose only work so far is environment preparation renders as one quiet
 * preparation surface instead of a "Working" fold.
 */
export function isPreparingWork(group: ActivityGroup, options: ReadableWorkOptions): boolean {
  if (!group.work) return false;
  const phases = group.items.filter((item) => item.kind === "startup-phase");
  return (
    !options.startupDetails &&
    !options.startupDismissed &&
    !group.work.endedAt &&
    !group.work.waiting &&
    phases.length > 0 &&
    group.items.every(
      (item) =>
        item.kind === "startup-phase" || (item.kind === "reasoning" && !item.text.trim()),
    ) &&
    !phases.some((item) => item.status === "failed" || item.status === "cancelled")
  );
}

/** Status of a readable turn's work row, minus the host-rendered live preview. */
export function readableWorkStatus(
  group: ActivityGroup & { work: NonNullable<ActivityGroup["work"]> },
): Omit<TurnSummaryStatus, "preview"> {
  const end = group.work.endedAt;
  return end
    ? { kind: "worked", durationMs: durationBetween(group.work.startedAt, end) }
    : group.work.waiting
      ? { kind: "waiting", ...group.work.waiting }
      : { kind: "working", since: group.work.startedAt };
}

/** Whether a readable turn's work fold starts expanded. */
export function readableWorkDefaultOpen(group: ActivityGroup): true | undefined {
  const phases = group.items.filter((item) => item.kind === "startup-phase");
  return timelineGroupContainsPresentedImage(group) ||
    group.outcome === "failed" ||
    phases.some((item) => item.status === "failed" || item.status === "cancelled")
    ? true
    : undefined;
}

/** Whether the live preview should show (images stay primary output instead). */
export function readableWorkShowsPreview(group: ActivityGroup): boolean {
  return !timelineGroupContainsPresentedImage(group);
}

/**
 * The step a rolling preview shows: steps advance with event order (progress notes and
 * startup phases have their own surfaces). Mirrors the web RollingActivity selection.
 */
export function rollingActivityItem(
  items: readonly ActivityItem[],
  previousItem?: ActivityItem,
  mounted = true,
): { item: ActivityItem; running: boolean; earlierCount: number } | null {
  const work = items.filter((item) => item.kind !== "startup-phase" && item.kind !== "agent-message");
  const active = work.filter((item) =>
    item.kind === "reasoning" ? item.streaming : "status" in item && item.status === "running",
  );
  const item =
    !mounted && previousItem && previousItem.kind !== "agent-message" ? previousItem : work.at(-1);
  if (!item) return null;
  return {
    item,
    running: active.some((entry) => entry.id === item.id),
    earlierCount: Math.max(
      0,
      work.findIndex((entry) => entry.id === item.id),
    ),
  };
}

export function isToolCall(item: ActivityItem): item is ToolCallItem {
  return item.kind === "tool-call";
}