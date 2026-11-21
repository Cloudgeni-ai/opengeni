import { createHash, createHmac } from "node:crypto";
import {
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_SIGNATURE_VERSION,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  SITE_DB_LOCATION_HEADER,
  SITE_DB_RELOCATION_ERROR_HEADER,
  siteDbInternalPath,
  siteGatewayCanonicalString,
  type SiteDbErrorBody,
  type SiteDbOperation,
} from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";

/**
 * The API's client for a Site's Durable Object, through the Site gateway's
 * internal route (`POST <origin>/_og/internal/site-db/<siteId>/<operation>`).
 * Requests are signed like gateway -> API requests, in the other direction:
 * HMAC-SHA256 with the shared gateway secret over `siteGatewayCanonicalString`
 * (the internal path, the gateway's host, the body digest and the time; no
 * viewer fields). Every request names a fresh id the Durable Object refuses
 * to see twice. Nothing here decides who may do what: the service does that
 * before calling.
 */

export type SiteSqlGatewayConfig = {
  origin: string;
  secret: string;
  timeoutMs: number;
  /** Record each call's round trip (seconds); measuring never fails a call. */
  observe?: (operation: SiteDbOperation, outcome: "ok" | "error", seconds: number) => void;
};

export type SiteSqlGatewaySettings = Pick<
  Settings,
  | "sitesCloudflareStorageEnabled"
  | "sitesGatewayInternalOrigin"
  | "sitesGatewaySecret"
  | "sitesSqlTimeoutMs"
>;

/**
 * The gateway to call, or null when no gateway origin and secret are
 * configured. This alone lets the API reach Durable Objects that already
 * exist (export, inspect, dropping data); offering Site SQL also needs the
 * flag (siteSqlOffered).
 */
export function siteSqlGatewayConfig(
  settings: SiteSqlGatewaySettings,
): SiteSqlGatewayConfig | null {
  if (!settings.sitesGatewayInternalOrigin || !settings.sitesGatewaySecret) return null;
  return {
    origin: new URL(settings.sitesGatewayInternalOrigin).origin,
    secret: settings.sitesGatewaySecret,
    timeoutMs: settings.sitesSqlTimeoutMs,
  };
}

/**
 * Whether this deployment offers Site SQL: the flag is on and the gateway is
 * configured. Turning it on, migrating, rebuilding, importing and running
 * SQL need this; export, inspect and dropping a database only need the
 * gateway.
 */
export function siteSqlOffered(settings: SiteSqlGatewaySettings): boolean {
  return settings.sitesCloudflareStorageEnabled && siteSqlGatewayConfig(settings) !== null;
}

/** A refusal or failure from the gateway or the Durable Object. */
export class SiteDbCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** True when the operation may have run (a timeout or lost response). */
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "SiteDbCallError";
  }
}

export type SiteDbFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Sign one internal request. Exported for tests. */
export function signSiteDbRequest(
  config: Pick<SiteSqlGatewayConfig, "origin" | "secret">,
  siteId: string,
  operation: SiteDbOperation,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { url: string; headers: Record<string, string> } {
  return signGatewayInternalRequest(
    config,
    siteDbInternalPath(siteId, operation),
    body,
    nowSeconds,
  );
}

/**
 * Sign one API -> gateway internal POST to `path` (Site database and live
 * hint routes alike): no viewer fields, the gateway's host, the body digest.
 */
export function signGatewayInternalRequest(
  config: Pick<SiteSqlGatewayConfig, "origin" | "secret">,
  path: string,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { url: string; headers: Record<string, string> } {
  const url = new URL(path, config.origin);
  const canonical = siteGatewayCanonicalString({
    method: "POST",
    host: url.host,
    pathWithQuery: url.pathname,
    timestamp: nowSeconds,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    session: "",
    visitor: "",
    clientIp: "",
    human: "",
  });
  const mac = createHmac("sha256", config.secret).update(canonical).digest("base64url");
  return {
    url: url.toString(),
    headers: {
      "content-type": "application/json",
      [SITE_GATEWAY_TIMESTAMP_HEADER]: String(nowSeconds),
      [SITE_GATEWAY_SIGNATURE_HEADER]: `${SITE_GATEWAY_SIGNATURE_VERSION}=${mac}`,
    },
  };
}

/** Sites logged as not in the EU yet, and when: at most once per Site per hour per process. */
const notInEuLogged = new Map<string, number>();
const NOT_IN_EU_LOG_MS = 60 * 60_000;

function shouldLogNotInEu(siteId: string, now = Date.now()): boolean {
  const last = notInEuLogged.get(siteId);
  if (last !== undefined && now - last < NOT_IN_EU_LOG_MS) return false;
  if (notInEuLogged.size >= 1000) notInEuLogged.clear();
  notInEuLogged.set(siteId, now);
  return true;
}

/** Read-only operations: a lost response cannot have changed anything. */
const READ_ONLY: ReadonlySet<SiteDbOperation> = new Set(["inspect", "export"]);

/** Call one Durable Object operation and return its JSON. */
export async function callSiteDb<T>(
  config: SiteSqlGatewayConfig,
  siteId: string,
  operation: SiteDbOperation,
  payload: Record<string, unknown>,
  fetchImpl: SiteDbFetch = fetch,
): Promise<T> {
  const started = performance.now();
  let outcome: "ok" | "error" = "error";
  try {
    const result = await callSiteDbOnce<T>(config, siteId, operation, payload, fetchImpl);
    outcome = "ok";
    return result;
  } finally {
    try {
      config.observe?.(operation, outcome, (performance.now() - started) / 1000);
    } catch {
      // Measuring never fails a call.
    }
  }
}

async function callSiteDbOnce<T>(
  config: SiteSqlGatewayConfig,
  siteId: string,
  operation: SiteDbOperation,
  payload: Record<string, unknown>,
  fetchImpl: SiteDbFetch,
): Promise<T> {
  const body = JSON.stringify({ requestId: crypto.randomUUID(), ...payload });
  const signed = signSiteDbRequest(config, siteId, operation, body);
  let response: Response;
  try {
    response = await fetchImpl(signed.url, {
      method: "POST",
      headers: signed.headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new SiteDbCallError(
      503,
      "unavailable",
      timedOut
        ? "The app database did not answer in time"
        : "The app database is temporarily unavailable",
      !READ_ONLY.has(operation),
    );
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  // A database not yet in the EU is served from its earlier location (apps/site-gateway, "Location").
  const relocationError = response.headers.get(SITE_DB_RELOCATION_ERROR_HEADER);
  if (relocationError && shouldLogNotInEu(siteId))
    console.warn("[site-sql] app database is not in the EU yet", {
      siteId,
      location: response.headers.get(SITE_DB_LOCATION_HEADER),
      reason: relocationError,
    });
  if (response.ok && parsed !== null && typeof parsed === "object") return parsed as T;
  const error = (parsed as Partial<SiteDbErrorBody> | null)?.error;
  const code = typeof error?.code === "string" ? error.code : "unavailable";
  const message =
    typeof error?.message === "string" ? error.message : "The app database request failed";
  // The gateway's own refusals (signature, missing binding) are configuration
  // problems, not the caller's: report them as unavailable.
  if (response.status === 401 || response.status === 404 || response.status >= 500)
    throw new SiteDbCallError(
      503,
      "unavailable",
      response.status >= 500 ? message : "App SQL is not reachable on this deployment",
      // The gateway says when nothing ran (a database briefly held while it moves).
      response.status >= 500 && !READ_ONLY.has(operation) && error?.outcomeUnknown !== false,
    );
  throw new SiteDbCallError(response.status, code, message);
}
