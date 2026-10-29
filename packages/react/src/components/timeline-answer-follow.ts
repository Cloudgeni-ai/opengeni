import { createContext, useContext } from "react";

/**
 * A card the person just answered (a finished connection, say) hands the view
 * back to the conversation: the agent continues from that answer, so the
 * timeline follows its tip again even though focus stays on the card.
 * Outside a timeline this is null and cards do nothing.
 */
export const TimelineAnswerFollowContext = createContext<((card: HTMLElement) => void) | null>(
  null,
);

export function useTimelineAnswerFollow(): ((card: HTMLElement) => void) | null {
  return useContext(TimelineAnswerFollowContext);
}
