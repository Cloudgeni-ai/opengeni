import type { AuthNeededItem, TimelineItem } from "@opengeni/sdk/session";
import type { Snippet } from "svelte";

export type TimelineItemRenderer = Snippet<[TimelineItem]>;
export type TimelineRendererRegistry = Partial<Record<TimelineItem["kind"], TimelineItemRenderer>>;
export type AuthReconnectHandler = (item: AuthNeededItem) => void | Promise<void>;

export function timelineRendererFor(
  registry: TimelineRendererRegistry | undefined,
  item: TimelineItem,
): TimelineItemRenderer | undefined {
  return registry?.[item.kind];
}
