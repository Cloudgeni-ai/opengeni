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
/** One of the app's latest API requests; correlationId is the server's reference for its logs. */
export type FeedbackRecentRequest = {
  at: string;
  method: string;
  /** Without the query string. */
  path: string;
  /** 0 when no response arrived. */
  status: number;
  durationMs: number;
  correlationId?: string | undefined;
};
/** An uncaught error, an unhandled promise rejection, or a file that failed to load. */
export type FeedbackRecentException = {
  at: string;
  kind: "error" | "unhandled_rejection" | "resource";
  message: string;
  stack?: string | undefined;
  source?: string | undefined;
};
/** A step before the report: a screen opened, the app hidden or shown, the network lost or back. */
export type FeedbackBreadcrumb = {
  at: string;
  kind: "navigation" | "lifecycle" | "network";
  label: string;
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
  /** The chat in view; the server records its state with the report. */
  sessionId?: string | undefined;
  locale?: string | undefined;
  timeZone?: string | undefined;
  online?: boolean | undefined;
  recentErrors?: FeedbackRecentError[] | undefined;
  recentRequests?: FeedbackRecentRequest[] | undefined;
  recentExceptions?: FeedbackRecentException[] | undefined;
  breadcrumbs?: FeedbackBreadcrumb[] | undefined;
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
