export type FeedbackSentiment = "positive" | "negative";
export type CreateFeedbackRequest = {
  idempotencyKey: string;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  sentiment?: FeedbackSentiment | undefined;
  comment?: string | undefined;
};
export type Feedback = {
  id: string;
  workspaceId: string;
  subjectId: string;
  principalKind: string | null;
  sessionId: string | null;
  turnId: string | null;
  sentiment: FeedbackSentiment | null;
  comment: string | null;
  createdAt: string;
};
export type FeedbackSubmissionResponse = { feedback: Feedback; replayed: boolean };
