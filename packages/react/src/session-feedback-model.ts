// Reply and session feedback shared by web and native: the one feedback read
// per session (with recovery), saved turn ratings, the submission payload with
// a retained idempotency key, and the dialog copy. No DOM, no React.
import type {
  CreateFeedbackRequest,
  Feedback,
  FeedbackSentiment,
  OpenGeniClient,
} from "@opengeni/sdk";

export type FeedbackClient = Pick<OpenGeniClient, "createFeedback" | "listOwnFeedback">;

/** One shared read per session, with recovery after a transient network failure. */
export function loadSessionFeedback(
  client: Pick<OpenGeniClient, "listOwnFeedback">,
  workspaceId: string,
  sessionId: string,
  onLoaded: (result: Awaited<ReturnType<OpenGeniClient["listOwnFeedback"]>>) => void,
): () => void {
  let current = true;
  let delay = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = () => {
    void client.listOwnFeedback(workspaceId, { sessionId, includeTurns: true }).then(
      (result) => {
        if (current) onLoaded(result);
      },
      () => {
        if (!current) return;
        timer = setTimeout(load, delay);
        delay = Math.min(delay * 2, 30_000);
      },
    );
  };
  load();
  return () => {
    current = false;
    clearTimeout(timer);
  };
}

/** The first saved rating per turn (the list is newest-first). */
export function turnRatingsFromFeedback(
  feedback: readonly Feedback[],
): Record<string, FeedbackSentiment> {
  const ratings: Record<string, FeedbackSentiment> = {};
  for (const entry of feedback) {
    if (entry.turnId && entry.sentiment && !ratings[entry.turnId])
      ratings[entry.turnId] = entry.sentiment;
  }
  return ratings;
}

export type FeedbackPayload = Omit<CreateFeedbackRequest, "idempotencyKey">;

/**
 * The request to send, reusing the previous idempotency key when the user
 * retries the identical submission (a lost response must not duplicate it).
 */
export function feedbackSubmission(
  payload: FeedbackPayload,
  previous: CreateFeedbackRequest | null,
  newKey: () => string,
): CreateFeedbackRequest {
  if (
    previous &&
    previous.sessionId === payload.sessionId &&
    previous.turnId === payload.turnId &&
    previous.sentiment === payload.sentiment &&
    previous.comment === payload.comment
  ) {
    return previous;
  }
  return { ...payload, idempotencyKey: newKey() };
}

export function feedbackDialogCopy(target: {
  sessionId?: string | undefined;
  turnId?: string | undefined;
}) {
  return {
    title: target.turnId
      ? "Rate this reply"
      : target.sessionId
        ? "Rate this session"
        : "Send feedback",
    description: target.sessionId
      ? "Share what worked or what could be better."
      : "Tell us what could make Opengeni better.",
  };
}

export function feedbackSentimentLabel(sentiment: FeedbackSentiment): string {
  return sentiment === "positive" ? "Thumbs up" : "Thumbs down";
}
