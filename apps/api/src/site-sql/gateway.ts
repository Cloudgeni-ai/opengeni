import { createHash, createHmac } from "node:crypto";
import {
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_SIGNATURE_VERSION,
  SITE_GATEWAY_TIMESTAMP_HEADER,
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
};

export type SiteSqlGatewaySettings = Pick<
  Settings,
  | "sitesCloudflareStorageEnabled"
  | "sitesGatewayInternalOrigin"
  | "sitesGatewaySecret"
  | "sitesSqlTimeoutMs"
>;

/** The gateway to call, or null when Site SQL is not configured on this deployment. */
export function siteSqlGatewayConfig(
  settings: SiteSqlGatewaySettings,
): SiteSqlGatewayConfig | null {
  if (!settings.sitesCloudflareStorageEnabled) return null;
  if (!settings.sitesGatewayInternalOrigin || !settings.sitesGatewaySecret) return null;
  return {
    origin: new URL(settings.sitesGatewayInternalOrigin).origin,
    secret: settings.sitesGatewaySecret,
    timeoutMs: settings.sitesSqlTimeoutMs,
  };
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
  const path = siteDbInternalPath(siteId, operation);
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
        ? "The Site database did not answer in time"
        : "The Site database is temporarily unavailable",
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
  if (response.ok && parsed !== null && typeof parsed === "object") return parsed as T;
  const error = (parsed as Partial<SiteDbErrorBody> | null)?.error;
  const code = typeof error?.code === "string" ? error.code : "unavailable";
  const message =
    typeof error?.message === "string" ? error.message : "The Site database request failed";
  // The gateway's own refusals (signature, missing binding) are configuration
  // problems, not the caller's: report them as unavailable.
  if (response.status === 401 || response.status === 404 || response.status >= 500)
    throw new SiteDbCallError(
      503,
      "unavailable",
      response.status >= 500 ? message : "Site SQL is not reachable on this deployment",
      response.status >= 500 && !READ_ONLY.has(operation),
    );
  throw new SiteDbCallError(response.status, code, message);
}
