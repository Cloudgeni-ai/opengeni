/**
 * One presentation rule for a queued item, shared by the full queue and the
 * compact session-chrome dock so the two cannot drift. A turn with an empty
 * prompt and timeline annotations is valid content; an item with neither is a
 * malformed or legacy object that gets an explicit fallback, never a blank row.
 */
export type QueueItemContent = "text" | "annotations" | "unavailable";

export const QUEUE_ITEM_CONTENT_UNAVAILABLE = "Content unavailable";

export function queueItemContent(text: string, annotationCount: number): QueueItemContent {
  if (text.length > 0) return "text";
  return annotationCount > 0 ? "annotations" : "unavailable";
}
