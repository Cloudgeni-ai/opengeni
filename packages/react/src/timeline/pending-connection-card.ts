import type { AuthNeededItem, TimelineItem } from "./types";

/**
 * The connection card (connect, reconnect or more access) the agent ended
 * waiting on, which the chat keeps in view above the composer as it does an
 * approval, or null. It is the latest card, still actionable and not
 * finished, with no message from the person after it: their message moves
 * the work on, and a finished card stays only as history in the timeline.
 */
export function pendingConnectionCard(
  items: readonly TimelineItem[],
  actionable: (item: AuthNeededItem) => boolean,
): AuthNeededItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "user-message") return null;
    if (item.kind !== "auth-needed") continue;
    if (item.setupFinished || item.askedAgainLater || !actionable(item)) return null;
    return item;
  }
  return null;
}
