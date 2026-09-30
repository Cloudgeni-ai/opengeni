import type { TimelineGroup } from "../timeline/types";

export type TimelineSettlement = { element: HTMLElement; top: number };

/** Capture only a retained answer at a real live→settled boundary, never history load. */
export function captureTimelineSettlement(
  scroller: HTMLElement,
  groups: readonly { key: string; group: TimelineGroup }[],
): TimelineSettlement | null {
  // Selectionchange can arrive after this commit. Inspect ownership directly
  // as well as the caller's pin latch so that race cannot move selected text.
  const focused = scroller.ownerDocument.activeElement;
  const selection = scroller.ownerDocument.getSelection();
  if (
    (focused && focused !== scroller && scroller.contains(focused)) ||
    (selection &&
      !selection.isCollapsed &&
      selection.anchorNode &&
      scroller.contains(selection.anchorNode))
  )
    return null;
  const live = scroller
    .querySelector('[data-og-exchange-status="working"], [data-og-exchange-status="waiting"]')
    ?.closest<HTMLElement>("[data-og-group-key]");
  if (!live) return null;
  const index = groups.findIndex(({ key }) => key === live.dataset.ogGroupKey);
  const work = groups[index]?.group;
  const answer = groups[index + 1];
  if (
    work?.kind !== "activity" ||
    !work.work?.endedAt ||
    answer?.group.kind !== "item" ||
    answer.group.item.kind !== "agent-message"
  )
    return null;
  const element = Array.from(scroller.querySelectorAll<HTMLElement>("[data-og-group-key]")).find(
    (node) => node.dataset.ogGroupKey === answer.key,
  );
  return element ? { element, top: element.getBoundingClientRect().top } : null;
}

/**
 * Folding earlier prose can clamp scrollTop before paint. Keep the retained
 * answer visually continuous after the normal scroll authority has run. This
 * is one local position transition, not a new scroll writer or a presence tree.
 */
export function animateTimelineSettlement(snapshot: TimelineSettlement): void {
  const { element, top } = snapshot;
  if (!element.isConnected || typeof element.animate !== "function") return;
  const delta = top - element.getBoundingClientRect().top;
  if (Math.abs(delta) < 1) return;
  element.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
    id: "og-timeline-settlement",
    // Match the existing activity-rail collapse; reduced motion is gated by the caller.
    duration: 320,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  });
}
