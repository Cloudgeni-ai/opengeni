import {
  SITE_GATEWAY_API_PREFIX,
  SITE_TOOL_METHODS,
  matchSiteOperation,
  type SiteToolMethod,
} from "@opengeni/contracts";
import { readHuman } from "./cookies";
import { applySecurityHeaders, jsonError } from "./headers";
import { signedApiRequest } from "./signing";
import { isSameOriginRequest, requiresSignIn, siteCaller, type SiteContext } from "./site-context";

/** Request bodies for JSON operations (Site Data batches are at most 2 MiB). */
export const MAX_API_BODY_BYTES = 4 * 1024 * 1024;
/** Site Data file uploads. */
export const MAX_FILE_BODY_BYTES = 25 * 1024 * 1024;

const SITE_HOST_PREFIX = "/v1/workspaces/site-host";
const FILE_UPLOAD = /^\/published-artifacts\/current\/files(?:\/|$)/u;

/** Headers a Site request may carry to the API. Cookies, authorization and forwarding headers never do. */
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
  "last-event-id",
  "range",
] as const;

/** Headers an API response may carry back. `Set-Cookie` never does: the API sets no cookies on a Site origin. */
const FORWARD_RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-range",
  "content-type",
  "deprecation",
  "etag",
  "last-modified",
  "retry-after",
  "sunset",
  "x-opengeni-api-contract",
  "x-opengeni-correlation-id",
] as const;

export type ApiRoute =
  | { kind: "operation"; id: string; suffix: string; stream: boolean }
  | { kind: "tool"; method: SiteToolMethod; suffix: string };

/**
 * Classify `/_og/api<suffix>` against the Site operation allowlist and the
 * tool bridge methods. Anything else is refused before any request is made.
 */
export function classifyApiRequest(method: string, pathname: string): ApiRoute | null {
  if (pathname !== SITE_GATEWAY_API_PREFIX && !pathname.startsWith(`${SITE_GATEWAY_API_PREFIX}/`))
    return null;
  const suffix = pathname.slice(SITE_GATEWAY_API_PREFIX.length);
  const upper = method.toUpperCase();
  if (suffix.startsWith("/tools/")) {
    const name = suffix.slice("/tools/".length);
    if (upper !== "POST" || !(SITE_TOOL_METHODS as readonly string[]).includes(name)) return null;
    return { kind: "tool", method: name as SiteToolMethod, suffix };
  }
  const sitePath = suffix === "/v1/config/client" ? suffix : `${SITE_HOST_PREFIX}${suffix}`;
  const match = matchSiteOperation(upper, sitePath);
  if (!match || match.suffix !== suffix) return null;
  return {
    kind: "operation",
    id: match.operation.id,
    suffix,
    stream: match.operation.stream === true,
  };
}

/** Read at most `limit` bytes, or "too_large". */
export async function readBodyCapped(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | "too_large"> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return "too_large";
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The per-Site rate-limit key: the verified visitor, else the client IP. */
export function rateLimitKey(site: Pick<SiteContext, "hostname" | "visitor" | "clientIp">): string {
  return site.visitor
    ? `v:${site.hostname}:${site.visitor}`
    : `ip:${site.hostname}:${site.clientIp || "unknown"}`;
}

/** Apply the edge flood brake. A failing binding never blocks traffic; the API enforces real limits. */
export async function underRateLimit(
  site: SiteContext,
  key = rateLimitKey(site),
): Promise<boolean> {
  if (!site.config.rateLimiter) return true;
  try {
    return (await site.config.rateLimiter.limit({ key })).success;
  } catch {
    return true;
  }
}

/**
 * `/_og/api/*`: re-check the operation, the access mode and the flood brake,
 * sign the request and forward it to `/v1/site-runtime<suffix>`. Responses
 * (including SSE) stream through with an allowlisted set of headers.
 */
export async function handleApi(site: SiteContext): Promise<Response> {
  const security = { noindex: true, hsts: site.hsts };
  const { request, url } = site;
  if (!isSameOriginRequest(request, site.siteOrigin))
    return jsonError(
      403,
      { code: "site_cross_origin", message: "Site API calls must come from the Site's own page" },
      security,
    );
  const route = classifyApiRequest(request.method, url.pathname);
  if (!route)
    return jsonError(
      403,
      { code: "site_operation_not_allowed", message: "This operation is not available to Sites" },
      security,
    );
  if (requiresSignIn(site.config, site.record) && !site.session)
    return jsonError(
      401,
      { code: "site_sign_in_required", message: "Sign in to use this Site" },
      security,
    );
  if (!(await underRateLimit(site)))
    return jsonError(
      429,
      { code: "site_rate_limited", message: "Too many requests; slow down", retryable: true },
      { ...security, headers: { "Retry-After": "60" } },
    );
  const method = request.method.toUpperCase();
  let body: Uint8Array<ArrayBuffer> | null = null;
  if (method !== "GET" && method !== "HEAD") {
    const limit =
      route.kind === "operation" && FILE_UPLOAD.test(route.suffix)
        ? MAX_FILE_BODY_BYTES
        : MAX_API_BODY_BYTES;
    const read = await readBodyCapped(request, limit);
    if (read === "too_large")
      return jsonError(
        413,
        { code: "site_request_too_large", message: "The request body is too large" },
        security,
      );
    body = read;
  }
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const human = site.config.turnstile
    ? await readHuman(site.config.secret, site.cookies, site.visitor)
    : false;
  const upstreamRequest = await signedApiRequest(site.config, siteCaller(site, human), {
    method,
    suffix: route.suffix,
    search: route.kind === "tool" ? "" : url.search,
    body,
    headers,
    signal: request.signal,
  });
  let response: Response;
  try {
    response = await fetch(upstreamRequest);
  } catch {
    return jsonError(
      502,
      {
        code: "site_upstream_unavailable",
        message: "The Site service is temporarily unavailable",
        retryable: true,
        outcomeUnknown: method !== "GET" && method !== "HEAD",
      },
      security,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return jsonError(
      502,
      { code: "site_upstream_redirect", message: "The Site service answered unexpectedly" },
      security,
    );
  }
  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  if (!out.has("cache-control")) out.set("Cache-Control", "no-store");
  applySecurityHeaders(out, security);
  return new Response(response.body, { status: response.status, headers: out });
}
