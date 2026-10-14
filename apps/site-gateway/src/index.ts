/**
 * Published Sites gateway: one Cloudflare Worker on `*.<sites domain>`.
 *
 * Thin by design (docs/design/published-sites-2026-10-14.md, Decision 5):
 * host lookup, cookies, sign-in redirects, signing and forwarding to the
 * site-runtime API, caching immutable Site HTML, and security headers. All
 * authorization stays in the OpenGeni API.
 */
import {
  SITE_GATEWAY_API_PREFIX,
  SITE_GATEWAY_CALLBACK_PATH,
  SITE_GATEWAY_LOGIN_PATH,
  SITE_GATEWAY_LOGOUT_PATH,
  SITE_GATEWAY_PREFIX,
  SITE_GATEWAY_REPORT_PATH,
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
import { messagePage, neutralPage, takedownPage } from "./pages";
import { handleReport } from "./report";
import { SITE_GATEWAY_HUMAN_PATH } from "./shell/shell-config";
import { handleShell } from "./shell";
import type { SiteContext } from "./site-context";
import { SITE_DB_INTERNAL_PREFIX, handleSiteDbInternal } from "./site-db";
import { handleVersionHtml } from "./version";

export type { GatewayEnv } from "./env";

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
  const hostname = url.hostname.toLowerCase();
  if (!parseSiteHostname(hostname, config.sitesDomain)) return plain(404, "Not found.\n");
  if (!config.development && url.protocol !== "https:") {
    url.protocol = "https:";
    return new Response(null, { status: 308, headers: { Location: url.toString() } });
  }
  const hsts = !config.development;
  const pathname = url.pathname;
  const api = isApiPath(pathname);
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
          { hsts },
          502,
          "Temporarily unavailable",
          "This Site could not be loaded. Try again shortly.",
        );
  }
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
      : neutralPage({ hsts });
  if (record.status === "suspended")
    return api
      ? jsonError(
          410,
          { code: "site_suspended", message: "This Site has been taken down" },
          { noindex: true, hsts },
        )
      : takedownPage({ hsts }, config.abuseEmail);

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
    if (pathname.startsWith(`${SITE_GATEWAY_VERSION_PREFIX}/`))
      return await handleVersionHtml(site, pathname.slice(SITE_GATEWAY_VERSION_PREFIX.length + 1));
    if (pathname === SITE_DB_INTERNAL_PREFIX || pathname.startsWith(`${SITE_DB_INTERNAL_PREFIX}/`))
      return await handleSiteDbInternal(site);
    if (pathname === SITE_GATEWAY_PREFIX || pathname.startsWith(`${SITE_GATEWAY_PREFIX}/`))
      return neutralPage(site);
    if (request.method !== "GET" && request.method !== "HEAD")
      return messagePage(site, 405, "Not allowed", "Site pages are read-only.");
    return await handleShell(site);
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    return messagePage(
      site,
      502,
      "Temporarily unavailable",
      "This Site could not be loaded. Try again shortly.",
    );
  }
}

export default {
  fetch(request: Request, env: GatewayEnv, ctx: WaitUntil): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
