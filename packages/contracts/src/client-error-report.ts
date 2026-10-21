/**
 * Wire grammar of the web client error beacon (`POST /v1/client-errors`).
 *
 * A report is a closed error kind, the matched route PATTERN (never a concrete
 * URL), the bundle revision, and optional error diagnostics: the error's name,
 * message and stack, plus React's component stack for a render failure. The
 * diagnostics are error text, not analytics. They can occasionally contain a
 * fragment of user content (an error message that quotes a value), so they are
 * scrubbed of obvious credentials and query strings by
 * {@link scrubClientErrorText} and bounded per field by
 * {@link CLIENT_ERROR_DETAIL_MAX_BYTES} in the browser, and the API re-applies
 * the same projection to whatever it receives. The web client that projects a
 * report, the API route that admits it, and the public structured-log
 * projection that prints it all validate against these exact rules, so the
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

/**
 * Largest UTF-8 byte length of each error diagnostic field. A longer value is
 * cut at the end, so a stack keeps its innermost frames.
 */
export const CLIENT_ERROR_DETAIL_MAX_BYTES = {
  name: 128,
  message: 1024,
  stack: 4096,
  componentStack: 4096,
} as const;
export type ClientErrorDetailField = keyof typeof CLIENT_ERROR_DETAIL_MAX_BYTES;
export const CLIENT_ERROR_DETAIL_FIELDS = Object.keys(
  CLIENT_ERROR_DETAIL_MAX_BYTES,
) as ClientErrorDetailField[];

/**
 * Largest accepted report body. The detail fields total 9,344 bytes; JSON
 * escaping at most doubles that, which leaves room for the closed fields.
 */
export const CLIENT_ERROR_REPORT_MAX_BYTES = 20 * 1024;

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

/** Error diagnostics. Every field is optional and already scrubbed and bounded. */
export type ClientErrorDetail = Partial<Record<ClientErrorDetailField, string>>;

export type ClientErrorReport = {
  kind: ClientErrorKind;
  route: string;
  revision: string;
  error?: ClientErrorDetail;
};

const REDACTED = "[redacted]";
const TRUNCATED = "…[truncated]";

// Hosts whose error URLs carry the error's arguments in the query string, and
// nothing else (React's production error decoder links).
const ERROR_DECODER_URL = /^https?:\/\/(?:react\.dev\/errors\/|reactjs\.org\/docs\/error-decoder)/i;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Every control character except tab and newline.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const URL_WITH_QUERY = /\bhttps?:\/\/[^\s?#"'<>()`]*[?#][^\s"'<>()`]*/gi;
const LINE_AND_COLUMN_SUFFIX = /(?::\d+){1,2}$/;
// A credential, not prose such as "Basic authentication": it contains a digit.
const AUTHORIZATION_VALUE =
  /\b(Bearer|Basic|Token)\s+(?=[A-Za-z._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
const KNOWN_TOKEN =
  /\b(?:sk-(?:proj-|ant-)?|sk_(?:live|test)_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|npm_|xox[abposr]-|ops_|AKIA|ASIA|AIza)[A-Za-z0-9_-]{12,}/g;
// The value never starts with `[` or `…`, so an already redacted value and a
// truncation marker are left alone and the scrubber stays idempotent.
const SECRET_ASSIGNMENT =
  /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|token|client[_-]?secret|secret|password|passwd|api[_-]?key|apikey|authorization|cookie|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"'&,;}[…][^\s"'&,;}]*/gi;
const OPAQUE_RUN = /[A-Za-z0-9+=_-]{32,}/g;

/**
 * A long run that looks like a credential rather than a word, chunk name,
 * path or UUID: it mixes letters and digits and has an unbroken stretch of at
 * least 24 characters between `-`/`_` separators. Content-hashed asset names
 * (`artifact-page-chrome-DkF3x9aB`) and UUIDs have no stretch that long.
 */
function isOpaqueCredential(run: string): boolean {
  return (
    /[0-9]/.test(run) &&
    /[A-Za-z]/.test(run) &&
    run.split(/[-_]/).some((stretch) => stretch.length >= 24)
  );
}

/**
 * Remove what an error text must never carry while keeping what makes it
 * useful. Query strings and fragments are dropped from http(s) URLs (keeping a
 * stack frame's `:line:column`); authorization values, JWTs, well-known API
 * token formats, the values of `token=`/`password:`-style assignments, and
 * long opaque letter-and-digit runs become `[redacted]`; control characters
 * other than tab and newline become spaces. Messages, file names, route paths,
 * UUIDs and stack frames survive. Applying it twice changes nothing.
 */
export function scrubClientErrorText(text: string): string {
  return text
    .replace(LONE_SURROGATE, "\uFFFD")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(URL_WITH_QUERY, (url) => {
      if (ERROR_DECODER_URL.test(url)) return url;
      const cut = url.search(/[?#]/);
      const suffix = url.slice(cut).match(LINE_AND_COLUMN_SUFFIX)?.[0] ?? "";
      return url.slice(0, cut) + suffix;
    })
    .replace(AUTHORIZATION_VALUE, `$1 ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(KNOWN_TOKEN, REDACTED)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
    .replace(OPAQUE_RUN, (run) => (isOpaqueCredential(run) ? REDACTED : run));
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes on a character boundary, ending
 * with a truncation marker when anything was removed.
 */
export function boundClientErrorText(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const budget = maxBytes - utf8ByteLength(TRUNCATED);
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = utf8ByteLength(character);
    if (bytes + size > budget) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end) + TRUNCATED;
}

/** Whether `text` is already exactly what the projection would produce for it. */
export function isProjectedClientErrorText(text: string, field: ClientErrorDetailField): boolean {
  return (
    text.length > 0 &&
    utf8ByteLength(text) <= CLIENT_ERROR_DETAIL_MAX_BYTES[field] &&
    scrubClientErrorText(text) === text
  );
}

/**
 * Project raw diagnostics into a {@link ClientErrorDetail}: non-string and
 * blank fields are dropped, the rest scrubbed and then bounded. Returns
 * `undefined` when nothing remains. Bounding after scrubbing keeps a cut from
 * splitting a credential into a fragment the scrubber no longer recognizes;
 * the marker cannot form one, so the result is stable under re-projection.
 */
export function projectClientErrorDetail(
  raw: Partial<Record<ClientErrorDetailField, unknown>> | null | undefined,
): ClientErrorDetail | undefined {
  if (!raw) return undefined;
  const detail: ClientErrorDetail = {};
  for (const field of CLIENT_ERROR_DETAIL_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string") continue;
    const projected = boundClientErrorText(
      scrubClientErrorText(value).trim(),
      CLIENT_ERROR_DETAIL_MAX_BYTES[field],
    );
    if (projected) detail[field] = projected;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

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
  "secrets",
  "variable-sets",
  "environments",
  "rigs",
  "playground",
  "read-only-chats",
  "inbox",
  "home",
  "session-link",
  "identity-link",
  "checkout-return",
  "integration-return",
  "device",
  "connect-agent",
  "native-sign-in",
  "reset-password",
  "setup-account",
  "account-auth",
  "site-auth",
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
