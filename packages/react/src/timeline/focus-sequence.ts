import type { TimelineGroup, TimelineItem } from "./types";

/*
 * Landing on a moment in a session: an inbox item or a phone notification
 * points at the durable event that raised it, and the timeline opens on the
 * row that holds that moment. Events that render no row of their own (an
 * agent's notification, a goal change) land on the nearest row before them.
 */

function itemSequences(item: TimelineItem): number[] {
  const sources =
    item.sourceEvents ??
    ("annotationSource" in item && item.annotationSource ? [item.annotationSource] : []);
  return sources.map((source) => source.sequence);
}

/** Every durable event sequence a group renders, nested work included. */
export function timelineGroupSequences(group: TimelineGroup): number[] {
  if (group.kind === "item") return itemSequences(group.item);
  if (group.kind === "turn") return group.groups.flatMap(timelineGroupSequences);
  return [
    ...group.items.flatMap((item) => itemSequences(item)),
    ...(group.work?.details.flatMap(timelineGroupSequences) ?? []),
  ];
}

/**
 * The index of the group to land on for `sequence`: the group that holds it,
 * else the last group that starts before it. -1 when every loaded group is
 * later (the moment is in older history) or nothing is loaded.
 */
export function timelineGroupIndexAtSequence(
  groups: readonly TimelineGroup[],
  sequence: number,
): number {
  let landing = -1;
  for (let index = 0; index < groups.length; index += 1) {
    const sequences = timelineGroupSequences(groups[index]!);
    if (sequences.length === 0) continue;
    if (sequences.includes(sequence)) return index;
    if (Math.min(...sequences) <= sequence) landing = index;
  }
  return landing;
}
