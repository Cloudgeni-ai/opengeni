import { injectSiteBridgeBootstrap } from "@opengeni/sdk/site-bridge-host";
import { resolveSiteClientScript } from "@opengeni/sdk/site-document";
import { probeAccess } from "./access";
import { redirect } from "./auth";
import { sha256Hex } from "./crypto";
import { edgeCache, edgeCacheKey } from "./edge-cache";
import { SITE_HTML_CSP, applySecurityHeaders } from "./headers";
import { UpstreamError } from "./host-map";
import { messagePage, neutralPage } from "./pages";
import { signedApiRequest } from "./signing";
import { requiresSignIn, siteCaller, type SiteContext } from "./site-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Edge-cache lifetime for the current version's HTML (seconds). Short, and
 * keyed on the host-map generation, so a takedown or a new publish is never
 * masked for longer than this even if the API's purge by hostname is missed.
 */
export const EDGE_HTML_TTL = 60;
/** Browsers revalidate on every load; the ETag makes that a 304. */
export const BROWSER_HTML_CACHE_CONTROL = "private, no-cache";

/** The document the frame loads: the Site's own HTML plus the bridge bootstrap, as in the console. */
export function siteFrameDocument(html: string): string {
  return injectSiteBridgeBootstrap(resolveSiteClientScript(html));
}

/** A strong validator for the frame document. */
export async function siteHtmlEtag(html: string): Promise<string> {
  return `"${(await sha256Hex(html)).slice(0, 32)}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((value) => value.trim().replace(/^W\//u, ""))
    .some((value) => value === etag || value === "*");
}

/**
 * Site HTML is meant to load inside its shell's iframe, which browsers mark
 * `Sec-Fetch-Dest: iframe`. A request that says it is anything else (a
 * top-level navigation, a fetch) goes back to the Site's shell. A browser
 * that sends no Fetch Metadata is served: the HTML's own sandbox CSP and
 * `frame-ancestors 'self'` still isolate it.
 */
export function isFrameLoad(request: Request): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  return dest === null || dest === "iframe";
}

/**
 * GET /_og/v/<versionId>: Site HTML for the shell's frame. The host and
 * access checks run first on every request; members and invited Sites
 * confirm the site session with the API. The current version comes from a
 * short edge cache keyed by host, generation, Site and version; other
 * versions always ask the API, which serves only the current version and a
 * short grace window. Browsers keep it `private, no-cache` and revalidate
 * with the ETag, so a takedown applies on the next load.
 */
export async function handleVersionHtml(site: SiteContext, versionId: string): Promise<Response> {
  const method = site.request.method;
  if (method !== "GET" && method !== "HEAD")
    return messagePage(site, 405, "Not allowed", "Site pages are read-only.");
  if (!UUID.test(versionId)) return neutralPage(site);
  if (!isFrameLoad(site.request)) {
    const response = redirect(site, "/", 302);
    response.headers.set("Vary", "Sec-Fetch-Dest");
    return response;
  }
  const signIn = requiresSignIn(site.config, site.record);
  if (signIn) {
    const probe = await probeAccess(site);
    if (probe.kind === "signin")
      return messagePage(site, 401, "Sign in required", "Sign in to open this Site.");
    if (probe.kind === "forbidden")
      return messagePage(site, 403, "No access", "This Site is not shared with you.");
    if (probe.kind === "missing") return neutralPage(site);
  }
  const current = versionId === site.record.versionId;
  const cache = current ? edgeCache() : null;
  const key = edgeCacheKey(site.hostname, "site-html", [
    site.record.generation,
    site.record.siteId,
    versionId,
  ]);
  let html: string | null = null;
  let etag: string | null = null;
  let cacheStatus = "MISS";
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      html = await hit.text();
      etag = hit.headers.get("ETag");
      cacheStatus = "HIT";
    }
  }
  if (html === null) {
    let response: Response;
    try {
      response = await fetch(
        await signedApiRequest(site.config, siteCaller(site), {
          method: "GET",
          suffix: `/versions/${versionId}/html`,
        }),
      );
    } catch {
      throw new UpstreamError("Site HTML fetch failed", null);
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return neutralPage(site);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return messagePage(site, response.status, "No access", "This Site is not shared with you.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError("Site HTML fetch failed", response.status);
    }
    html = siteFrameDocument(await response.text());
    etag = await siteHtmlEtag(html);
    if (cache)
      site.ctx.waitUntil(
        cache.put(
          key,
          new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": `public, max-age=${EDGE_HTML_TTL}`,
              ETag: etag,
            },
          }),
        ),
      );
  }
  etag ??= await siteHtmlEtag(html);
  const headers = applySecurityHeaders(new Headers(), {
    noindex: site.noindex,
    hsts: site.hsts,
    frameable: "self",
  });
  headers.set("Content-Security-Policy", SITE_HTML_CSP);
  headers.set("Cache-Control", BROWSER_HTML_CACHE_CONTROL);
  headers.set("ETag", etag);
  headers.set("Vary", "Sec-Fetch-Dest");
  headers.set("X-OpenGeni-Site-Cache", cacheStatus);
  if (etagMatches(site.request.headers.get("if-none-match"), etag))
    return new Response(null, { status: 304, headers });
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(method === "HEAD" ? null : html, { status: 200, headers });
}
