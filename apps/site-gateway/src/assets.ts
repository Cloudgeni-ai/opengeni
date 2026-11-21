import {
  SITE_ASSET_CACHE_CONTROL,
  SITE_GATEWAY_ASSET_PREFIX,
  parseSiteAssetAddress,
  siteAssetContentType,
} from "@opengeni/contracts/app-assets";
import { edgeCache, edgeCacheKey } from "./edge-cache";
import { SITE_HTML_CSP, applySecurityHeaders } from "./headers";
import { UpstreamError } from "./host-map";
import { signedApiRequest } from "./signing";
import { siteCaller, type SiteContext } from "./site-context";

export function isAssetPath(pathname: string): boolean {
  return pathname.startsWith(`${SITE_GATEWAY_ASSET_PREFIX}/`);
}

function notFound(site: SiteContext): Response {
  const headers = applySecurityHeaders(new Headers(), { noindex: true, hsts: site.hsts });
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response("Not found.\n", { status: 404, headers });
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((value) => value.trim().replace(/^W\//u, ""))
    .some((value) => value === etag || value === "*");
}

/**
 * GET /_og/a/<versionId>/<token>/<path>: one file of a multi-file app version
 * (its JS chunks, CSS, fonts, images), for the app's frame on this host.
 *
 * The frame is opaque-origin and sends no cookies, so there is no sign-in
 * probe: the version's unguessable token, which only its access-checked HTML
 * names, is the capability, and the API checks it against the version's
 * manifest. The host check (unpublished, taken down) has already run. Files
 * never change for their address, so the edge keeps them without the
 * host-map generation and browsers keep them for a year; a takedown still
 * stops them because the host check runs before the cache.
 */
export async function handleAsset(site: SiteContext, pathname: string): Promise<Response> {
  const method = site.request.method;
  if (method !== "GET" && method !== "HEAD") return notFound(site);
  const address = parseSiteAssetAddress(pathname.slice(SITE_GATEWAY_ASSET_PREFIX.length + 1));
  if (!address) return notFound(site);
  const contentType = siteAssetContentType(address.path)!;
  const headers = applySecurityHeaders(new Headers(), { noindex: true, hsts: site.hsts });
  // The opaque-origin frame loads module scripts and fonts with CORS.
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Content-Security-Policy", SITE_HTML_CSP);
  headers.set("Cache-Control", SITE_ASSET_CACHE_CONTROL);
  headers.set("Content-Type", contentType);

  const cache = edgeCache();
  const key = edgeCacheKey(site.hostname, "site-asset", [
    site.record.siteId,
    address.versionId,
    address.token,
    address.path,
  ]);
  const hit = cache ? await cache.match(key) : undefined;
  if (hit?.body) {
    const etag = hit.headers.get("ETag");
    if (etag) headers.set("ETag", etag);
    headers.set("X-OpenGeni-Site-Cache", "HIT");
    if (etag && etagMatches(site.request.headers.get("if-none-match"), etag)) {
      await hit.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    if (method === "HEAD") {
      await hit.body.cancel();
      return new Response(null, { status: 200, headers });
    }
    return new Response(hit.body, { status: 200, headers });
  }

  let response: Response;
  try {
    response = await fetch(
      await signedApiRequest(site.config, siteCaller(site), {
        method: "GET",
        suffix: `/assets/${address.versionId}/${address.token}/${address.path}`,
      }),
    );
  } catch {
    throw new UpstreamError("App file fetch failed", null);
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return notFound(site);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamError("App file fetch failed", response.status);
  }
  const etag = response.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  headers.set("X-OpenGeni-Site-Cache", "MISS");
  const body = response.body ?? new ReadableStream<Uint8Array>();
  if (!cache) {
    if (method === "HEAD") {
      await body.cancel();
      return new Response(null, { status: 200, headers });
    }
    return new Response(body, { status: 200, headers });
  }
  const [viewer, stored] = body.tee();
  site.ctx.waitUntil(
    cache
      .put(
        key,
        new Response(stored, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": SITE_ASSET_CACHE_CONTROL,
            ...(etag ? { ETag: etag } : {}),
          },
        }),
      )
      .catch(() => undefined),
  );
  if (method === "HEAD") {
    await viewer.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(viewer, { status: 200, headers });
}
