/** A response-quality notice, not a failed turn or a completed deliverable. */
export const EMPTY_FINAL_REPLY_NOTICE =
  "The model returned no final reply after a reply reminder. Completed work is preserved; the goal and later updates are unaffected.";

export type EmptyFinalReplyCompletion = {
  emptyFinalReply: true;
};

export function turnCompletedWithEmptyFinalReply(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as { emptyFinalReply?: unknown }).emptyFinalReply === true
  );
}
