/**
 * Wire grammar of the content-free web client error beacon
 * (`POST /v1/client-errors`).
 *
 * A report is only a closed error kind, the matched route PATTERN (never a
 * concrete URL), and the bundle revision. The web client that projects a
 * report, the API route that admits it, and the public structured-log
 * projection that prints it all validate against these exact values, so the
 * browser can only send what the API accepts and logs.
 *
 * The same route also admits the closed operational signals below (requests
 * that never reached the server, live-stream health, and web vitals). They
 * follow the same rules: closed values only, a route pattern or page label,
 * never a URL, message, identifier, or user content.
 */
export const CLIENT_ERRORS_PATH = "/v1/client-errors";

export const CLIENT_ERROR_KINDS = [
  "route_error",
  "unhandled_rejection",
  "window_error",
  "chunk_load",
] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

/** Largest accepted report body. A valid report is well under 256 bytes. */
export const CLIENT_ERROR_REPORT_MAX_BYTES = 512;

const ROUTE_SEGMENT = String.raw`(?:[a-z]+(?:-[a-z]+)*|\$[A-Za-z][A-Za-z0-9]{0,31})`;

/**
 * A route pattern of at most 160 characters that is `/`, `unknown`, or up to
 * twelve `/`-separated segments that are each either a lowercase literal
 * (`variable-sets`) or a `$param` placeholder. The grammar excludes digits in
 * literals, so a concrete id cannot pass as one.
 */
export const CLIENT_ERROR_ROUTE_PATTERN = new RegExp(
  String.raw`^(?=.{1,160}$)(?:unknown|/|(?:/${ROUTE_SEGMENT}){1,12})$`,
);

/** The bundle revision token (a commit SHA, `dev`, or `unknown`). */
export const CLIENT_ERROR_REVISION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type ClientErrorReport = { kind: ClientErrorKind; route: string; revision: string };

/**
 * Content-free operational signals that share the error beacon route. A
 * signal report carries a `signal` discriminator and only closed values; a
 * report without `signal` is a {@link ClientErrorReport}. Older API servers
 * reject signal reports as invalid, so the extension is backward compatible in
 * both directions.
 */
export const CLIENT_SIGNALS = ["request_failure", "stream", "web_vital"] as const;
export type ClientSignal = (typeof CLIENT_SIGNALS)[number];

/**
 * Key product mutations whose failure before any HTTP response is counted.
 * `send_message` includes sends the server queues behind an active turn.
 */
export const CLIENT_REQUEST_ACTIONS = [
  "create_session",
  "send_message",
  "steer_message",
  "composer_submit",
  "retry_turn",
  "connect_integration",
  "connect_model",
  "checkout_start",
] as const;
export type ClientRequestAction = (typeof CLIENT_REQUEST_ACTIONS)[number];

/**
 * Why a request never produced an HTTP response: the browser reported no
 * connectivity (`offline`), the client's own deadline expired (`timeout`), or
 * the transport failed (`network`). Cancellations the user or the app
 * initiated are never reported.
 */
export const CLIENT_REQUEST_FAILURE_REASONS = ["network", "timeout", "offline"] as const;
export type ClientRequestFailureReason = (typeof CLIENT_REQUEST_FAILURE_REASONS)[number];

/** Browser live streams: one session's event stream, or the workspace live stream. */
export const CLIENT_STREAMS = ["session", "workspace"] as const;
export type ClientStream = (typeof CLIENT_STREAMS)[number];

/**
 * Live stream health: a live stream dropped and started reconnecting
 * (`reconnect`), stopped reconnecting (`reconnect_exhausted`), or stayed
 * disconnected for longer than the long-disconnect threshold while the tab
 * was visible (`long_disconnect`).
 */
export const CLIENT_STREAM_EVENTS = [
  "reconnect",
  "reconnect_exhausted",
  "long_disconnect",
] as const;
export type ClientStreamEvent = (typeof CLIENT_STREAM_EVENTS)[number];

/** Core Web Vitals plus time to first byte, measured once per document. */
export const CLIENT_WEB_VITAL_METRICS = ["lcp", "inp", "cls", "ttfb"] as const;
export type ClientWebVitalMetric = (typeof CLIENT_WEB_VITAL_METRICS)[number];

/**
 * Largest accepted value: seconds for the timing metrics, the unitless layout
 * shift score for `cls`.
 */
export const CLIENT_WEB_VITAL_MAX_VALUE: Readonly<Record<ClientWebVitalMetric, number>> = {
  lcp: 600,
  inp: 600,
  cls: 100,
  ttfb: 600,
};

/**
 * The closed page labels of the web console's product-journey projection
 * (`journeyPage` in apps/web/src/lib/analytics-journey.ts; a drift test keeps
 * the two identical). Workspace pages are the first path segment after
 * `/workspaces/<id>/`; the rest are exact top-level routes.
 */
export const CLIENT_PAGES = [
  "sessions",
  "priority",
  "plugins",
  "capabilities",
  "documents",
  "state",
  "memory",
  "schedules",
  "artifacts",
  "settings",
  "organization",
  "insights",
  "machines",
  "files",
  "agents",
  "variable-sets",
  "environments",
  "rigs",
  "get-started",
  "playground",
  "first-agent",
  "home",
  "session-link",
  "identity-link",
  "checkout-return",
  "integration-return",
  "device",
  "reset-password",
  "setup-account",
  "account-auth",
  "personal-security",
  "other",
] as const;
export type ClientPage = (typeof CLIENT_PAGES)[number];

export type ClientRequestFailureReport = {
  signal: "request_failure";
  action: ClientRequestAction;
  reason: ClientRequestFailureReason;
  route: string;
  revision: string;
};

export type ClientStreamReport = {
  signal: "stream";
  stream: ClientStream;
  event: ClientStreamEvent;
  route: string;
  revision: string;
};

export type ClientWebVitalReport = {
  signal: "web_vital";
  metric: ClientWebVitalMetric;
  page: ClientPage;
  /** Seconds for timing metrics, the unitless score for `cls`. */
  value: number;
  revision: string;
};

export type ClientSignalReport =
  | ClientRequestFailureReport
  | ClientStreamReport
  | ClientWebVitalReport;

/** Every body the beacon route accepts. */
export type ClientBeaconReport = ClientErrorReport | ClientSignalReport;
