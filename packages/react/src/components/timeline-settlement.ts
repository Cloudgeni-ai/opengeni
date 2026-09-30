import type { TimelineGroup } from "../timeline/types";
import { timelineHasReader } from "./timeline-anchor";

export type TimelineSettlement = { element: HTMLElement; top: number };

/** Capture only a retained answer at a real live→settled boundary, never history load. */
export function captureTimelineSettlement(
  scroller: HTMLElement,
  groups: readonly { key: string; group: TimelineGroup }[],
): TimelineSettlement | null {
  // Selectionchange can arrive after this commit. Inspect ownership directly
  // as well as the caller's pin latch so that race cannot move selected text.
  if (timelineHasReader(scroller)) return null;
  const live = Array.from(
    scroller.querySelectorAll(
      '[data-og-exchange-status="working"], [data-og-exchange-status="waiting"]',
    ),
  );
  // At the live tip the newest retained answer owns the transition. An older
  // waiting/incomplete row must not mask it, including batched settlements.
  for (const status of live.reverse()) {
    const row = status.closest<HTMLElement>("[data-og-group-key]");
    const index = groups.findIndex(({ key }) => key === row?.dataset.ogGroupKey);
    const work = groups[index]?.group;
    const answer = groups[index + 1];
    if (
      work?.kind !== "activity" ||
      !work.work?.endedAt ||
      answer?.group.kind !== "item" ||
      answer.group.item.kind !== "agent-message"
    )
      continue;
    const element = Array.from(scroller.querySelectorAll<HTMLElement>("[data-og-group-key]")).find(
      (node) => node.dataset.ogGroupKey === answer.key,
    );
    if (element) return { element, top: element.getBoundingClientRect().top };
  }
  return null;
}

/**
 * Folding earlier prose can clamp scrollTop before paint. Keep the retained
 * answer visually continuous after the normal scroll authority has run. This
 * is one local position transition, not a new scroll writer or a presence tree.
 */
export function animateTimelineSettlement(snapshot: TimelineSettlement): Animation | null {
  const { element, top } = snapshot;
  if (!element.isConnected || typeof element.animate !== "function") return null;
  const delta = top - element.getBoundingClientRect().top;
  if (Math.abs(delta) < 1) return null;
  return element.animate(
    [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
    {
      id: "og-timeline-settlement",
      // Match the existing activity-rail collapse; reduced motion is gated by the caller.
      duration: 320,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  );
}
