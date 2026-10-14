import type { SiteHostMapRecord } from "@opengeni/contracts";
import type { GatewayConfig, GatewayEnv, WaitUntil } from "./env";
import type { GatewayCaller } from "./signing";

/** One request to an active Site host, after host lookup and cookie verification. */
export type SiteContext = {
  request: Request;
  url: URL;
  env: GatewayEnv;
  config: GatewayConfig;
  ctx: WaitUntil;
  /** Lowercase Site hostname, e.g. `team-4k9x.<sites domain>`. */
  hostname: string;
  /** `https://<hostname>` (plain HTTP and a port only in local development). */
  siteOrigin: string;
  record: SiteHostMapRecord & { versionId: string };
  cookies: Map<string, string>;
  /** Gateway-verified visitor id from `__Host-og_v`, or null. */
  visitor: string | null;
  /** Raw site-session token from `__Host-og_session`, or null. The API validates it. */
  session: string | null;
  clientIp: string;
  noindex: boolean;
  hsts: boolean;
};

/** Members and invited Sites need a site session; so does every Site on a login-only deployment. */
export function requiresSignIn(config: GatewayConfig, record: SiteHostMapRecord): boolean {
  return record.access !== "public" || config.loginOnly;
}

export function siteCaller(site: SiteContext, human = false): GatewayCaller {
  return {
    host: site.hostname,
    session: site.session ?? "",
    visitor: site.visitor ?? "",
    clientIp: site.clientIp,
    human,
  };
}

/**
 * Browser same-origin proof for state-changing and API requests: the Origin
 * header when present (always on POST), else Fetch Metadata. Requests from
 * the opaque-origin Site frame carry `Origin: null` and are refused.
 */
export function isSameOriginRequest(request: Request, siteOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === siteOrigin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}
