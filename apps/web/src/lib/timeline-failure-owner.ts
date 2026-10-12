import type { TimelineItem } from "@opengeni/react";

/**
 * Whether the rendered timeline already shows this exact session failure, so
 * the failed-session banner need not repeat its headline and Details.
 * Presentation only: retry, billing and sandbox recovery keep their owners.
 *
 * The proof is item identity, never wording: the failure event's own notice,
 * or a failed compaction landmark of the failure's own turn that carries
 * diagnostics. A cleared or paged view that omits both proves nothing.
 */
export function timelineShowsFailure(
  items: readonly TimelineItem[],
  failure: { failureEventId?: string | null; turnId?: string | null },
): boolean {
  const { failureEventId, turnId } = failure;
  return items.some(
    (item) =>
      (item.kind === "notice" && Boolean(failureEventId) && item.id === failureEventId) ||
      (item.kind === "context-compaction" &&
        Boolean(turnId) &&
        item.turnId === turnId &&
        item.phase === "skipped" &&
        item.skipReason === "summarization_failed" &&
        Boolean(item.providerRejection || item.failureDetail)),
  );
}
