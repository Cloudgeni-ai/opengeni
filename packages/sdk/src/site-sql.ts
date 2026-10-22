/**
 * Site SQL for Site HTML: run the named, parameterized queries the Site's
 * owner defined on its optional SQLite database. Sites never send SQL. The
 * request travels over the host's Site HTTP channel like Site Data; the API
 * checks who may run the query and binds `:viewer` (and the other `viewer_*`
 * parameters) from the signed-in viewer, never from the page. Returned rows
 * are untrusted input: render them with textContent, never innerHTML.
 */
import { SITE_DATA_PATH_PREFIX } from "./site-data";

export type OpenGeniSiteSqlErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  /** This viewer may not do this on this Site (a role the Site's rules exclude). */
  | "not_available_for_viewer"
  | "conflict"
  | "quota_exceeded"
  | "rate_limited"
  | "sql_error"
  | "unavailable"
  | "disabled"
  | "site_sql_unsupported"
  | "request_failed";

export class OpenGeniSiteSqlError extends Error {
  constructor(
    readonly code: OpenGeniSiteSqlErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OpenGeniSiteSqlError";
  }
}

/** A parameter value. Booleans bind as 1 and 0. */
export type OpenGeniSiteSqlValue = string | number | boolean | null;

export type OpenGeniSiteSqlResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  columns: string[];
  /** Rows keyed by column name; blobs come back as `{ $base64: string }`. */
  rows: Row[];
  /** True when the query's row or size limit cut the result short. */
  truncated: boolean;
  rowsRead: number;
  rowsWritten: number;
};

export type OpenGeniSiteSql = {
  /**
   * Run the named query `name` with `params` (names without the colon). Do
   * not pass `viewer` or any `viewer_*` parameter: the host binds them.
   */
  run<Row extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    params?: Record<string, OpenGeniSiteSqlValue>,
  ): Promise<OpenGeniSiteSqlResult<Row>>;
};

const QUERY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

const KNOWN_CODES = new Set<string>([
  "validation",
  "not_found",
  "forbidden",
  "not_available_for_viewer",
  "conflict",
  "quota_exceeded",
  "rate_limited",
  "sql_error",
  "unavailable",
  "disabled",
]);

type SiteSqlFetch = (path: string, init: RequestInit) => Promise<Response>;

/** Build `site.sql` over a Site HTTP fetch; `ready` says whether the host serves the pinned Site. */
export function createOpenGeniSiteSql(
  fetchSite: SiteSqlFetch,
  ready: () => Promise<boolean>,
): OpenGeniSiteSql {
  return {
    async run<Row extends Record<string, unknown> = Record<string, unknown>>(
      name: string,
      params: Record<string, OpenGeniSiteSqlValue> = {},
    ): Promise<OpenGeniSiteSqlResult<Row>> {
      if (!QUERY_NAME.test(name))
        throw new OpenGeniSiteSqlError("validation", "Invalid query name", 0);
      if (Object.keys(params).some((key) => key === "viewer" || key.startsWith("viewer_")))
        throw new OpenGeniSiteSqlError(
          "validation",
          "viewer parameters are bound by the host, not the Site",
          0,
        );
      if (!(await ready()))
        throw new OpenGeniSiteSqlError(
          "site_sql_unsupported",
          "This Site host does not provide Site SQL",
          0,
        );
      const response = await fetchSite(
        `${SITE_DATA_PATH_PREFIX}/sql/queries/${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ params }),
        },
      );
      const text = await response.text();
      let value: unknown = null;
      try {
        value = text ? JSON.parse(text) : null;
      } catch {
        value = null;
      }
      if (response.ok) return value as OpenGeniSiteSqlResult<Row>;
      throw siteSqlErrorFromResponse(response.status, value);
    },
  };
}

function siteSqlErrorFromResponse(status: number, value: unknown): OpenGeniSiteSqlError {
  const error =
    typeof value === "object" && value !== null && "error" in value
      ? (value as { error: unknown }).error
      : null;
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const details =
    typeof record.details === "object" && record.details !== null
      ? (record.details as Record<string, unknown>)
      : {};
  const detailCode = typeof details.code === "string" ? details.code : undefined;
  const code: OpenGeniSiteSqlErrorCode =
    detailCode && KNOWN_CODES.has(detailCode)
      ? (detailCode as OpenGeniSiteSqlErrorCode)
      : status === 404
        ? "not_found"
        : status === 403
          ? "forbidden"
          : status === 413
            ? "quota_exceeded"
            : status === 429
              ? "rate_limited"
              : "request_failed";
  const message =
    typeof record.message === "string" && record.message
      ? record.message
      : `Site SQL request failed with HTTP ${status}`;
  return new OpenGeniSiteSqlError(code, message, status, details);
}
