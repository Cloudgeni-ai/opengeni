/**
 * Published Sites gateway: one Cloudflare Worker on `*.<sites domain>`.
 *
 * Thin by design (docs/design/published-sites-2026-10-14.md, Decision 5):
 * host lookup, cookies, sign-in redirects, signing and forwarding to the
 * site-runtime API, caching immutable Site HTML, and security headers. All
 * authorization stays in the Opengeni API.
 */
import {
  SITE_GATEWAY_API_PREFIX,
  SITE_GATEWAY_CALLBACK_PATH,
  SITE_GATEWAY_LIVE_PATH,
  SITE_GATEWAY_LOGIN_PATH,
  SITE_GATEWAY_LOGOUT_PATH,
  SITE_GATEWAY_PREFIX,
  SITE_GATEWAY_REPORT_PATH,
  SITE_GATEWAY_TIMING_PATH,
  SITE_GATEWAY_VERSION_PREFIX,
  parseSiteHostname,
} from "@opengeni/contracts";
import { handleApi } from "./api";
import { handleCallback, handleLogin, handleLogout } from "./auth";
import { parseCookies, readSession, readVisitor } from "./cookies";
import {
  GatewayConfigError,
  gatewayConfig,
  type GatewayConfig,
  type GatewayEnv,
  type WaitUntil,
} from "./env";
import { applySecurityHeaders, jsonError } from "./headers";
import { UpstreamError, lookupHost } from "./host-map";
import { handleHumanCheck } from "./human";
import { handleHtmlFrameHost, isHtmlFrameHostRequest } from "./html-frame-host";
import { messagePage, neutralPage, takedownPage } from "./pages";
import { countSiteRequest } from "./platform-requests";
import { handleReport } from "./report";
import { SITE_GATEWAY_HUMAN_PATH } from "./shell/shell-config";
import { handleShell } from "./shell";
import type { SiteContext } from "./site-context";
import { handleSiteDbInternal, isSiteDbInternalPath } from "./site-db";
import {
  handleConsoleLive,
  handleSiteLive,
  handleSiteLiveInternal,
  isSiteLiveInternalPath,
} from "./site-live";
import { handleTimingBeacon, recordTiming } from "./timing";
import { handleVersionHtml, isFrameLoad } from "./version";

export type { GatewayEnv } from "./env";
/** The per-Site SQLite Durable Object class bound as `SITE_DB` (optional Cloudflare storage). */
export { SiteDatabase } from "./site-database";
/** The per-Site live-hint Durable Object class bound as `SITE_LIVE` (optional). */
export { SiteLive } from "./site-live";

function plain(status: number, body: string, headers: HeadersInit = {}): Response {
  const out = applySecurityHeaders(new Headers(headers), { noindex: true, hsts: false });
  out.set("Content-Type", "text/plain; charset=utf-8");
  if (!out.has("Cache-Control")) out.set("Cache-Control", "no-store");
  return new Response(body, { status, headers: out });
}

function robots(noindex: boolean): Response {
  return plain(
    200,
    noindex ? "User-agent: *\nDisallow: /\n" : `User-agent: *\nDisallow: ${SITE_GATEWAY_PREFIX}/\n`,
    { "Cache-Control": "public, max-age=300" },
  );
}

function isApiPath(pathname: string): boolean {
  return pathname === SITE_GATEWAY_API_PREFIX || pathname.startsWith(`${SITE_GATEWAY_API_PREFIX}/`);
}

/**
 * An error the gateway did not expect: a plain Opengeni page (or a JSON error
 * on the Site API and the internal Site database route) instead of
 * Cloudflare's raw "Worker threw exception" page.
 */
export function unexpectedErrorResponse(request: Request, env: GatewayEnv): Response {
  const url = new URL(request.url);
  const environment = env.ENVIRONMENT?.trim().toLowerCase();
  const hsts = environment !== "development" && environment !== "test";
  if (
    isApiPath(url.pathname) ||
    isSiteDbInternalPath(url.pathname) ||
    isSiteLiveInternalPath(url.pathname)
  )
    return jsonError(
      500,
      {
        code: "site_gateway_error",
        message: "Something went wrong. Try again shortly",
        retryable: true,
      },
      { noindex: true, hsts },
    );
  return messagePage(
    {
      hsts,
      frameable:
        url.pathname.startsWith(`${SITE_GATEWAY_VERSION_PREFIX}/`) && isFrameLoad(request)
          ? "self"
          : "none",
    },
    500,
    "Something went wrong",
    "This Site couldn't be shown. Try again in a moment.",
  );
}

export async function handleRequest(
  request: Request,
  env: GatewayEnv,
  ctx: WaitUntil,
): Promise<Response> {
  let config: GatewayConfig;
  try {
    config = gatewayConfig(env);
  } catch (error) {
    if (error instanceof GatewayConfigError) console.error(`site-gateway: ${error.message}`);
    return plain(500, "Site gateway is not configured.\n");
  }
  const url = new URL(request.url);
  // The API's signed Site database route is not a Site page: it answers on
  // any host the Worker serves and never looks up a Site host.
  if (isSiteDbInternalPath(url.pathname))
    return await handleSiteDbInternal(request, url, env, config);
  if (isSiteLiveInternalPath(url.pathname))
    return await handleSiteLiveInternal(request, url, env, config);
  const requestHost = url.hostname.toLowerCase();
  // `og.<domain>` is reserved for the console's HTML frame host, never a Site.
  if (isHtmlFrameHostRequest(requestHost, config.sitesDomain)) {
    if (!config.development && url.protocol !== "https:") {
      url.protocol = "https:";
      return new Response(null, { status: 308, headers: { Location: url.toString() } });
    }
    if (url.pathname === SITE_GATEWAY_LIVE_PATH)
      return await handleConsoleLive(request, url, env, config);
    return handleHtmlFrameHost(request, url, {
      appOrigin: config.appOrigin,
      hsts: !config.development,
    });
  }
  if (!parseSiteHostname(requestHost, config.sitesDomain)) return plain(404, "Not found.\n");
  // `<site>.<domain>.` is the same DNS name but another browser origin (and
  // another cookie jar): send it to the canonical host.
  if (requestHost.endsWith(".")) {
    url.hostname = requestHost.replace(/\.+$/u, "");
    return new Response(null, {
      status: 308,
      headers: applySecurityHeaders(new Headers({ Location: url.toString() }), {
        noindex: true,
        hsts: false,
      }),
    });
  }
  const hostname = requestHost;
  if (!config.development && url.protocol !== "https:") {
    url.protocol = "https:";
    return new Response(null, { status: 308, headers: { Location: url.toString() } });
  }
  const hsts = !config.development;
  const pathname = url.pathname;
  const api = isApiPath(pathname);
  const pageSecurity = {
    hsts,
    frameable:
      pathname.startsWith(`${SITE_GATEWAY_VERSION_PREFIX}/`) && isFrameLoad(request)
        ? ("self" as const)
        : ("none" as const),
  };
  const clientIp = request.headers.get("cf-connecting-ip") ?? "";

  let record;
  try {
    record = await lookupHost(config, hostname, clientIp, ctx);
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    return api
      ? jsonError(
          502,
          { code: "site_upstream_unavailable", message: "Try again shortly", retryable: true },
          { noindex: true, hsts },
        )
      : messagePage(
          pageSecurity,
          502,
          "Temporarily unavailable",
          "This Site could not be loaded. Try again shortly.",
        );
  }
  // Platform usage: every request served for a known Site host counts,
  // cache hits and refusals included (src/platform-requests.ts).
  if (record) countSiteRequest(config, ctx, hostname);
  const forceNoindex = config.forceNoindex || !record || record.noindex;
  if (pathname === "/robots.txt")
    return robots(forceNoindex || record?.status !== "active" || !record?.versionId);
  if (
    !record ||
    record.status === "unpublished" ||
    (record.status === "active" && !record.versionId)
  )
    return api
      ? jsonError(
          404,
          { code: "site_not_found", message: "No published Site here" },
          { noindex: true, hsts },
        )
      : neutralPage(pageSecurity);
  if (record.status === "suspended")
    return api
      ? jsonError(
          410,
          { code: "site_suspended", message: "This Site has been taken down" },
          { noindex: true, hsts },
        )
      : takedownPage(pageSecurity, config.abuseEmail);

  const cookies = parseCookies(request.headers.get("cookie"));
  const site: SiteContext = {
    request,
    url,
    env,
    config,
    ctx,
    hostname,
    siteOrigin: url.origin,
    record: { ...record, versionId: record.versionId! },
    cookies,
    visitor: await readVisitor(config.secret, cookies),
    session: readSession(cookies),
    clientIp,
    noindex: forceNoindex,
    hsts,
  };

  try {
    if (api) return await handleApi(site);
    if (pathname === SITE_GATEWAY_LOGIN_PATH) return await handleLogin(site);
    if (pathname === SITE_GATEWAY_CALLBACK_PATH) return await handleCallback(site);
    if (pathname === SITE_GATEWAY_LOGOUT_PATH) return await handleLogout(site);
    if (pathname === SITE_GATEWAY_REPORT_PATH) return await handleReport(site);
    if (pathname === SITE_GATEWAY_HUMAN_PATH) return await handleHumanCheck(site);
    if (pathname === SITE_GATEWAY_LIVE_PATH) return await handleSiteLive(site);
    if (pathname === SITE_GATEWAY_TIMING_PATH) return await handleTimingBeacon(site);
    if (pathname.startsWith(`${SITE_GATEWAY_VERSION_PREFIX}/`))
      return await handleVersionHtml(site, pathname.slice(SITE_GATEWAY_VERSION_PREFIX.length + 1));
    if (pathname === SITE_GATEWAY_PREFIX || pathname.startsWith(`${SITE_GATEWAY_PREFIX}/`))
      return neutralPage(site);
    if (request.method !== "GET" && request.method !== "HEAD")
      return messagePage(site, 405, "Not allowed", "Site pages are read-only.");
    return await handleShell(site);
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    return messagePage(
      pageSecurity,
      502,
      "Temporarily unavailable",
      "This Site could not be loaded. Try again shortly.",
    );
  }
}

/** The closed route name the gateway reports its own handling time under. */
export function gatewayRoute(pathname: string): string {
  if (isApiPath(pathname)) return "api";
  if (pathname.startsWith(`${SITE_GATEWAY_VERSION_PREFIX}/`)) return "version";
  if (pathname === SITE_GATEWAY_LIVE_PATH) return "live";
  if (pathname === SITE_GATEWAY_TIMING_PATH) return "timing";
  if (pathname.startsWith(`${SITE_GATEWAY_PREFIX}/auth/`)) return "auth";
  if (pathname === SITE_GATEWAY_REPORT_PATH) return "report";
  if (pathname.startsWith(`${SITE_GATEWAY_PREFIX}/internal/`)) return "internal";
  if (pathname.startsWith(`${SITE_GATEWAY_PREFIX}/`) || pathname === SITE_GATEWAY_PREFIX)
    return "other";
  return "shell";
}

/**
 * Measure the gateway's own handling time (until the response starts; a
 * streamed body is not waited for). Reported with the page beacons.
 */
function measureGateway(
  request: Request,
  env: GatewayEnv,
  ctx: WaitUntil,
  started: number,
  status: number,
): void {
  try {
    const config = gatewayConfig(env);
    const route = gatewayRoute(new URL(request.url).pathname);
    // The beacon measures the page, not the gateway.
    if (route === "timing") return;
    recordTiming(
      config,
      ctx,
      "gateway",
      route,
      status >= 500 ? "error" : "ok",
      Date.now() - started,
    );
  } catch {
    // An unconfigured gateway has nothing to report to.
  }
}

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: WaitUntil): Promise<Response> {
    const started = Date.now();
    let status = 500;
    try {
      const response = await handleRequest(request, env, ctx);
      status = response.status;
      return response;
    } catch (error) {
      console.error("site-gateway: unexpected error", error);
      return unexpectedErrorResponse(request, env);
    } finally {
      measureGateway(request, env, ctx, started, status);
    }
  },
};
