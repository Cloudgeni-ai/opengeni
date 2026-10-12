import type { TimelineItem } from "@opengeni/react";

/**
 * Whether the rendered timeline already shows this exact session failure, so
 * the failed-session banner need not repeat its headline and Details.
 * Presentation only: retry, billing and sandbox recovery keep their owners.
 *
 * The proof is item identity, never wording: the failure event's own notice,
 * or a failed compaction landmark with diagnostics from the same attempt as the
 * failure's own turn end. Retry reopens the same logical turn, so a landmark
 * before that turn's previous settlement belongs to an older failure. A
 * cleared or paged view that omits the failure proves nothing.
 */
export function timelineShowsFailure(
  items: readonly TimelineItem[],
  failure: { failureEventId?: string | null; turnId?: string | null },
): boolean {
  const { failureEventId, turnId } = failure;
  if (!failureEventId) return false;
  if (items.some((item) => item.kind === "notice" && item.id === failureEventId)) return true;
  if (!turnId) return false;
  // `buildTimeline` keys a failure's turn end by its event id.
  const end = items.findIndex(
    (item) =>
      item.kind === "turn-end" &&
      item.id === `${failureEventId}-turn-end` &&
      item.turnId === turnId,
  );
  for (let index = end - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "turn-end" && item.turnId === turnId) return false;
    if (
      item?.kind === "context-compaction" &&
      item.turnId === turnId &&
      item.phase === "skipped" &&
      item.skipReason === "summarization_failed"
    ) {
      return Boolean(item.providerRejection || item.failureDetail);
    }
  }
  return false;
}
