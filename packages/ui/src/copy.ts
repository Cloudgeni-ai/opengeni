export type OpenGeniUiCopy = Readonly<{
  send: string;
  steer: string;
  pause: string;
  resume: string;
  attach: string;
  removeAttachment(name: string): string;
  retryAttachment(name: string): string;
  approve: string;
  reject: string;
  skip: string;
  submitAnswers: string;
  queue: string;
  goal: string;
  loading: string;
  emptyTimeline: string;
  loadOlder: string;
  loadNewer: string;
  jumpToLatest: string;
  expand: string;
  collapse: string;
  dismissError: string;
}>;

export const DEFAULT_OPEN_GENI_UI_COPY: OpenGeniUiCopy = Object.freeze({
  send: "Send",
  steer: "Steer",
  pause: "Pause",
  resume: "Resume",
  attach: "Attach files",
  removeAttachment: (name) => `Remove ${name}`,
  retryAttachment: (name) => `Retry ${name}`,
  approve: "Approve",
  reject: "Reject",
  skip: "Skip",
  submitAnswers: "Send answers",
  queue: "Queue",
  goal: "Goal",
  loading: "Loading…",
  emptyTimeline: "No session activity yet.",
  loadOlder: "Load older activity",
  loadNewer: "Load newer activity",
  jumpToLatest: "Jump to latest",
  expand: "Expand",
  collapse: "Collapse",
  dismissError: "Dismiss error",
});

export function mergeOpenGeniUiCopy(overrides: Partial<OpenGeniUiCopy> = {}): OpenGeniUiCopy {
  return Object.freeze({ ...DEFAULT_OPEN_GENI_UI_COPY, ...overrides });
}
