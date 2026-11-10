import type { SessionEvent } from "../types";
import type { TimelineItem } from "../../timeline";

/**
 * The failure events the failed-session banner presents, for
 * `MessageTimeline`'s `presentedFailureEventIds`, so the timeline does not
 * repeat what the banner says next to its actions. That is the failure
 * itself, and for a credit stop the turn end it stopped (a credit stop can
 * end a turn as nominally completed, with no failure event).
 */
export function bannerFailureEventIds(
  events: readonly SessionEvent[],
  failure: { failureEventId?: string | null | undefined },
  creditExhausted: boolean | undefined,
): string[] {
  const ids = failure.failureEventId ? [failure.failureEventId] : [];
  if (creditExhausted) {
    let last: SessionEvent | undefined;
    for (const event of events) {
      if (
        (event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled") &&
        (!last || event.sequence > last.sequence)
      )
        last = event;
    }
    if (last && !ids.includes(last.id)) ids.push(last.id);
  }
  return ids;
}

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
  failure: { failureEventId?: string | null | undefined; turnId?: string | null | undefined },
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
