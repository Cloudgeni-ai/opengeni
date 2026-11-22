/**
 * The app's own server code (docs/app-server-code.md) for Site HTML:
 * `site.server.fetch(path, init)` sends one request to the server code the
 * app's current version carries and returns its answer as a `Response`.
 * The host tells the code who is asking; the code runs as the app (the
 * workspace's shared connections, the app's shared data), never as the
 * viewer. Answers are untrusted input: render them with textContent.
 */
import { SITE_DATA_PATH_PREFIX } from "./site-data";

export type OpenGeniSiteServerErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "conflict"
  | "site_server_unsupported"
  | "request_failed";

/** The request could not reach the app's server code (it never answered). */
export class OpenGeniSiteServerError extends Error {
  constructor(
    readonly code: OpenGeniSiteServerErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OpenGeniSiteServerError";
  }
}

export type OpenGeniSiteServerInit = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** A string, or any value to send as JSON. */
  body?: unknown;
};

export type OpenGeniSiteServer = {
  /**
   * Send `path` ("/issues?team=ENG") to the app's server code. Resolves with
   * the code's `Response`, whatever its status; rejects with
   * `OpenGeniSiteServerError` when the code could not be reached (no server
   * code, not allowed, rate limited, unavailable).
   */
  fetch(path: string, init?: OpenGeniSiteServerInit): Promise<Response>;
};

type SiteServerFetch = (path: string, init: RequestInit) => Promise<Response>;

const KNOWN_CODES = new Set<string>([
  "validation",
  "not_found",
  "forbidden",
  "rate_limited",
  "unavailable",
  "conflict",
]);

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Build `site.server` over a Site HTTP fetch; `ready` says whether the host serves the pinned Site. */
export function createOpenGeniSiteServer(
  fetchSite: SiteServerFetch,
  ready: () => Promise<boolean>,
): OpenGeniSiteServer {
  return {
    async fetch(path, init = {}) {
      if (typeof path !== "string" || !path.startsWith("/"))
        throw new OpenGeniSiteServerError("validation", "path must start with /", 0);
      if (!(await ready()))
        throw new OpenGeniSiteServerError(
          "site_server_unsupported",
          "This app host does not run app server code",
          0,
        );
      const headers = { ...(init.headers ?? {}) };
      let body: string | null = null;
      if (init.body !== undefined && init.body !== null) {
        if (typeof init.body === "string") body = init.body;
        else {
          body = JSON.stringify(init.body);
          if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type"))
            headers["content-type"] = "application/json";
        }
      }
      const response = await fetchSite(`${SITE_DATA_PATH_PREFIX}/server`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, method: init.method ?? "GET", headers, body }),
      });
      const text = await response.text();
      let value: unknown = null;
      try {
        value = text ? JSON.parse(text) : null;
      } catch {
        value = null;
      }
      if (response.ok && value && typeof value === "object" && "status" in value) {
        const answer = value as {
          status: number;
          headers: Record<string, string>;
          body: string;
          bodyEncoding: "utf8" | "base64";
        };
        const payload = NULL_BODY_STATUS.has(answer.status)
          ? null
          : answer.bodyEncoding === "base64"
            ? decodeBase64(answer.body)
            : answer.body;
        return new Response(payload, {
          status: answer.status < 200 || answer.status > 599 ? 500 : answer.status,
          headers: answer.headers,
        });
      }
      const error =
        value && typeof value === "object" && "error" in value
          ? ((value as { error: unknown }).error as Record<string, unknown> | null)
          : null;
      const details =
        error && typeof error.details === "object" && error.details !== null
          ? (error.details as Record<string, unknown>)
          : {};
      const detailCode = typeof details.code === "string" ? details.code : undefined;
      throw new OpenGeniSiteServerError(
        detailCode && KNOWN_CODES.has(detailCode)
          ? (detailCode as OpenGeniSiteServerErrorCode)
          : response.status === 404
            ? "not_found"
            : "request_failed",
        typeof error?.message === "string" ? error.message : `Request failed (${response.status})`,
        response.status,
        details,
      );
    },
  };
}
