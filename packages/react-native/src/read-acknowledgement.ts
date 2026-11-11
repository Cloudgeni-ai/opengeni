import {
  useSessionReadAcknowledgement,
  type SessionAttentionClientLike,
  type UseSessionReadAcknowledgementInput,
} from "@opengeni/react/session";

export { readAcknowledgementFrontier } from "@opengeni/react/session-attention-model";
export type { SessionAttentionClientLike };

/**
 * Mark the open conversation read while it is on screen and the app is in the
 * foreground, through the latest delivered attention boundary (completed
 * reply, question, failure), never per streaming flush. The same
 * implementation the web conversation uses; see `useSessionReadAcknowledgement`.
 */
export function useNativeReadAcknowledgement(input: UseSessionReadAcknowledgementInput): void {
  useSessionReadAcknowledgement(input);
}
