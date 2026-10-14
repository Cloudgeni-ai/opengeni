import { injectSiteBridgeBootstrap } from "@opengeni/sdk/site-bridge-host";
import { resolveSiteClientScript } from "@opengeni/sdk/site-document";
import { probeAccess } from "./access";
import { edgeCache, internalCacheKey } from "./edge-cache";
import { SITE_HTML_CSP, applySecurityHeaders } from "./headers";
import { UpstreamError } from "./host-map";
import { messagePage, neutralPage } from "./pages";
import { signedApiRequest } from "./signing";
import { requiresSignIn, siteCaller, type SiteContext } from "./site-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Edge-cache lifetime for immutable version HTML (seconds); takedown purges it. */
export const EDGE_HTML_TTL = 7 * 24 * 60 * 60;
/** Browser cache lifetime for immutable version HTML (seconds). */
export const BROWSER_HTML_TTL = 365 * 24 * 60 * 60;

/** The document the frame loads: the Site's own HTML plus the bridge bootstrap, as in the console. */
export function siteFrameDocument(html: string): string {
  return injectSiteBridgeBootstrap(resolveSiteClientScript(html));
}

/**
 * GET /_og/v/<versionId>: immutable Site HTML. The host and access checks
 * run first on every request; members and invited Sites confirm the site
 * session with the API. The current version is served from the edge cache
 * (keyed by Site and version); other versions always ask the API, which
 * serves only the host's current or rollback-eligible versions.
 */
export async function handleVersionHtml(site: SiteContext, versionId: string): Promise<Response> {
  const method = site.request.method;
  if (method !== "GET" && method !== "HEAD")
    return messagePage(site, 405, "Not allowed", "Site pages are read-only.");
  if (!UUID.test(versionId)) return neutralPage(site);
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
  const key = internalCacheKey(`/site-html/${site.record.siteId}/${versionId}`);
  let html: string | null = null;
  let cacheStatus = "MISS";
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      html = await hit.text();
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
    if (cache)
      site.ctx.waitUntil(
        cache.put(
          key,
          new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": `public, max-age=${EDGE_HTML_TTL}`,
            },
          }),
        ),
      );
  }
  const headers = applySecurityHeaders(new Headers(), {
    noindex: site.noindex,
    hsts: site.hsts,
    frameable: "self",
  });
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", SITE_HTML_CSP);
  // Immutable content, cached by the browser only after the access check above.
  headers.set(
    "Cache-Control",
    `${signIn ? "private" : "public"}, max-age=${BROWSER_HTML_TTL}, immutable`,
  );
  headers.set("X-OpenGeni-Site-Cache", cacheStatus);
  return new Response(method === "HEAD" ? null : html, { status: 200, headers });
}
