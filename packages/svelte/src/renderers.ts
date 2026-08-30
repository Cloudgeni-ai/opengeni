import type { TimelineItem } from "@opengeni/sdk/session";
import type { Snippet } from "svelte";

export type TimelineItemRenderer = Snippet<[TimelineItem]>;
export type TimelineRendererRegistry = Partial<Record<TimelineItem["kind"], TimelineItemRenderer>>;

export function timelineRendererFor(
  registry: TimelineRendererRegistry | undefined,
  item: TimelineItem,
): TimelineItemRenderer | undefined {
  return registry?.[item.kind];
}
