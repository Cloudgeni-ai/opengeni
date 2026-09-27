/**
 * Wire grammar of the content-free web client error beacon
 * (`POST /v1/client-errors`).
 *
 * A report is only a closed error kind, the matched route PATTERN (never a
 * concrete URL), and the bundle revision. The web client that projects a
 * report, the API route that admits it, and the public structured-log
 * projection that prints it all validate against these exact values, so the
 * browser can only send what the API accepts and logs.
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
