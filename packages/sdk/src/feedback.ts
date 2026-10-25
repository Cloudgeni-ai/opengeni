export type FeedbackSentiment = "positive" | "negative";
export type CreateFeedbackRequest = {
  idempotencyKey: string;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  sentiment?: FeedbackSentiment | undefined;
  comment?: string | undefined;
  /** Facts about the app and device the report was sent from. */
  context?: FeedbackContext | undefined;
  /** Up to three screenshots, base64-encoded, at most 3 MiB each. */
  screenshots?: FeedbackScreenshotUpload[] | undefined;
};
export type FeedbackRecentError = {
  at: string;
  title?: string | undefined;
  message: string;
  code?: string | undefined;
  status?: number | undefined;
  screen?: string | undefined;
};
export type FeedbackContext = {
  source: "web" | "desktop" | "mobile";
  trigger?: "menu" | "shake" | undefined;
  platform?: string | undefined;
  appVersion?: string | undefined;
  buildNumber?: string | undefined;
  osVersion?: string | undefined;
  deviceModel?: string | undefined;
  screen?: string | undefined;
  locale?: string | undefined;
  timeZone?: string | undefined;
  online?: boolean | undefined;
  recentErrors?: FeedbackRecentError[] | undefined;
};
export type FeedbackScreenshotUpload = {
  contentType: "image/jpeg" | "image/png";
  base64: string;
};
export type FeedbackScreenshot = {
  index: number;
  contentType: "image/jpeg" | "image/png";
  sizeBytes: number;
  sha256: string;
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
  context: FeedbackContext | null;
  screenshots: FeedbackScreenshot[];
  createdAt: string;
};
export type FeedbackSubmissionResponse = { feedback: Feedback; replayed: boolean };
