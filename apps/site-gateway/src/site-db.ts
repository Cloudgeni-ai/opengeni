import {
  SITE_DB_INTERNAL_PREFIX,
  SITE_DB_OPERATIONS,
  SITE_GATEWAY_CLIENT_IP_HEADER,
  SITE_GATEWAY_HUMAN_HEADER,
  SITE_GATEWAY_MAX_SKEW_SECONDS,
  SITE_GATEWAY_SESSION_HEADER,
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  SITE_GATEWAY_VISITOR_HEADER,
  type SiteDbOperation,
} from "@opengeni/contracts";
import { readBodyCapped } from "./api";
import { sha256Hex, timingSafeEqual } from "./crypto";
import type { GatewayConfig, GatewayEnv } from "./env";
import { applySecurityHeaders, jsonError } from "./headers";
import { signGatewayFields } from "./signing";

/**
 * Optional per-Site Cloudflare storage (PR B): the API's signed internal
 * route to a Site's SQLite Durable Object.
 *
 * `POST /_og/internal/site-db/<siteId>/<operation>` on any host the Worker
 * serves (production uses a reserved label such as `internal.<sites domain>`,
 * which no Site can take). The API signs it like gateway -> API requests:
 * `siteGatewayCanonicalString` over this path, the request's own host, empty
 * session, visitor, client IP and human fields, HMAC-SHA256 with the gateway
 * secret (current or previous), within 30 s. The gateway only verifies and
 * forwards: the API has already authorized the caller, applied limits and
 * resolved named queries, and the Durable Object re-checks every statement.
 * Site pages never reach this route: their calls go through `/_og/api` to the
 * API, which calls back here. Without the `SITE_DB` binding the route is 404.
 */
export { SITE_DB_INTERNAL_PREFIX };

/** Migration scripts and SQL imports are at most 2M characters (up to 6 MB of UTF-8). */
export const MAX_SITE_DB_BODY_BYTES = 8 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The Durable Object namespace binding (`[[durable_objects.bindings]]`). */
export type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
};

export function isSiteDbInternalPath(pathname: string): boolean {
  return pathname === SITE_DB_INTERNAL_PREFIX || pathname.startsWith(`${SITE_DB_INTERNAL_PREFIX}/`);
}

/** `<siteId>/<operation>` from the internal path, or null. */
export function parseSiteDbPath(
  pathname: string,
): { siteId: string; operation: SiteDbOperation } | null {
  const match = /^\/_og\/internal\/site-db\/([^/]+)\/([a-z]+)$/u.exec(pathname);
  if (!match) return null;
  const [, siteId, operation] = match;
  if (!UUID.test(siteId!) || !(SITE_DB_OPERATIONS as readonly string[]).includes(operation!))
    return null;
  return { siteId: siteId!, operation: operation as SiteDbOperation };
}

/**
 * The checks that need no body: a fresh timestamp (30 s either way), no
 * viewer fields and a signature header. Run before the body is read, so a
 * stale or unsigned request costs nothing. `now` is milliseconds.
 */
export function precheckSiteDbSignature(request: Request, now = Date.now()): number | null {
  const timestampHeader = request.headers.get(SITE_GATEWAY_TIMESTAMP_HEADER) ?? "";
  if (!/^\d{1,12}$/u.test(timestampHeader)) return null;
  const timestamp = Number(timestampHeader);
  if (Math.abs(Math.floor(now / 1000) - timestamp) > SITE_GATEWAY_MAX_SKEW_SECONDS) return null;
  // Internal requests carry no viewer: any viewer field makes the request invalid.
  for (const header of [
    SITE_GATEWAY_SESSION_HEADER,
    SITE_GATEWAY_VISITOR_HEADER,
    SITE_GATEWAY_CLIENT_IP_HEADER,
    SITE_GATEWAY_HUMAN_HEADER,
  ])
    if (request.headers.has(header)) return null;
  if (!request.headers.get(SITE_GATEWAY_SIGNATURE_HEADER)) return null;
  return timestamp;
}

/**
 * Verify an API -> gateway signature against the current or previous secret.
 * Exported for tests; `now` is milliseconds.
 */
export async function verifySiteDbSignature(
  secrets: readonly string[],
  request: Request,
  url: URL,
  body: Uint8Array<ArrayBuffer>,
  now = Date.now(),
): Promise<boolean> {
  const timestamp = precheckSiteDbSignature(request, now);
  if (timestamp === null) return false;
  const received = request.headers.get(SITE_GATEWAY_SIGNATURE_HEADER) ?? "";
  const fields = {
    method: request.method,
    pathWithQuery: `${url.pathname}${url.search}`,
    timestamp,
    bodySha256: await sha256Hex(body),
    host: url.host,
    session: "",
    visitor: "",
    clientIp: "",
    human: "",
  };
  let valid = false;
  for (const secret of secrets) {
    const expected = await signGatewayFields(secret, fields);
    // Check every secret so timing does not reveal which one matched.
    if (timingSafeEqual(received, expected)) valid = true;
  }
  return valid;
}

export async function handleSiteDbInternal(
  request: Request,
  url: URL,
  env: GatewayEnv,
  config: GatewayConfig,
): Promise<Response> {
  const security = { noindex: true, hsts: !config.development };
  const namespace = env.SITE_DB as DurableObjectNamespaceLike | undefined;
  if (!namespace) return jsonError(404, { code: "not_found", message: "Not found" }, security);
  if (!config.development && url.protocol !== "https:")
    return jsonError(400, { code: "https_required", message: "Use https" }, security);
  const target = parseSiteDbPath(url.pathname);
  if (!target || url.search)
    return jsonError(404, { code: "not_found", message: "Not found" }, security);
  if (request.method !== "POST")
    return jsonError(405, { code: "method_not_allowed", message: "Use POST" }, security);
  const unauthorized = () =>
    jsonError(401, { code: "unauthorized", message: "Invalid or expired signature" }, security);
  if (precheckSiteDbSignature(request) === null) return unauthorized();
  const body = await readBodyCapped(request, MAX_SITE_DB_BODY_BYTES);
  if (body === "too_large")
    return jsonError(
      413,
      { code: "too_large", message: "The request body is too large" },
      security,
    );
  const secrets = [config.secret, ...(config.previousSecret ? [config.previousSecret] : [])];
  if (!(await verifySiteDbSignature(secrets, request, url, body))) return unauthorized();
  const stub = namespace.get(namespace.idFromName(target.siteId));
  let response: Response;
  try {
    response = await stub.fetch(`https://site-db.internal/${target.operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (error) {
    console.error(`site-gateway: site-db ${target.operation} failed`, error);
    return jsonError(
      503,
      {
        code: "site_db_unavailable",
        message: "The Site database is temporarily unavailable",
        retryable: true,
        outcomeUnknown: target.operation !== "inspect" && target.operation !== "export",
      },
      security,
    );
  }
  const headers = applySecurityHeaders(new Headers(), security);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
