import {
  SITE_BRIDGE_BOOTSTRAP_SCRIPT,
  injectSiteBridgeBootstrap,
} from "@opengeni/sdk/site-bridge-host";
import { SITE_CLIENT_SCRIPT_PATH, resolveSiteClientScript } from "@opengeni/sdk/site-document";
import { probeAccess } from "./access";
import { redirect } from "./auth";
import { sha256Hex } from "./crypto";
import { edgeCache, edgeCacheKey } from "./edge-cache";
import { SITE_FRAME_MAX_BYTES, lockstepTee, siteFrameStream } from "./frame-stream";
import { SITE_HTML_CSP, applySecurityHeaders } from "./headers";
import { UpstreamError } from "./host-map";
import { frameAccessPage, messagePage, neutralPage } from "./pages";
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

/**
 * The document the frame loads: the Site's own HTML plus the bridge bootstrap,
 * as in the console. The gateway streams this same document
 * (`siteFrameStream`); this whole-string form is its reference.
 */
export function siteFrameDocument(html: string): string {
  return injectSiteBridgeBootstrap(resolveSiteClientScript(html));
}

/**
 * Revision of how the gateway builds the frame document from a version's
 * stored HTML. Bump it when that changes in a way the SDK scripts below do
 * not capture, so browsers and the edge cache stop reusing older documents.
 */
const FRAME_FORMAT = "frame-stream-1";

let frameFingerprint: Promise<string> | null = null;

/** Everything besides the version that shapes the frame document: format, bootstrap and client runtime. */
function siteFrameFingerprint(): Promise<string> {
  frameFingerprint ??= sha256Hex(
    [
      FRAME_FORMAT,
      SITE_BRIDGE_BOOTSTRAP_SCRIPT,
      resolveSiteClientScript(`<script src="${SITE_CLIENT_SCRIPT_PATH}"></script>`),
    ].join("\n"),
  ).then((hex) => hex.slice(0, 16));
  return frameFingerprint;
}

/**
 * A strong validator for the frame document. A version's stored HTML never
 * changes (the API serves it `immutable`), so the document is fixed by the
 * Site, the version and the gateway's own frame fingerprint; the page itself
 * is never hashed, so serving it never needs it whole.
 */
export async function siteFrameEtag(siteId: string, versionId: string): Promise<string> {
  const fingerprint = await siteFrameFingerprint();
  return `"${(await sha256Hex(`${fingerprint}:${siteId}:${versionId}`)).slice(0, 32)}"`;
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

/** Megabytes for people, rounded up. */
function megabytes(bytes: number): number {
  return Math.ceil(bytes / (1024 * 1024));
}

/** The Site's page is over SITE_FRAME_MAX_BYTES: a plain Opengeni page inside the shell instead. */
export function siteTooLargePage(security: { hsts: boolean }, bytes: number): Response {
  return messagePage(
    { ...security, frameable: "self" },
    502,
    "Site too large",
    `This Site's page is ${megabytes(bytes)} MB, more than the ${megabytes(SITE_FRAME_MAX_BYTES)} MB a Site page can be. If it's your Site, make the page smaller, for example by linking large videos and images instead of embedding them.`,
  );
}

/**
 * GET /_og/v/<versionId>: Site HTML for the shell's frame. The host and
 * access checks run first on every request; members and invited Sites
 * confirm the site session with the API. The current version comes from a
 * short edge cache keyed by host, generation, Site, version and frame
 * fingerprint; other versions always ask the API, which serves only the
 * current version and a short grace window. Browsers keep it `private,
 * no-cache` and revalidate with the ETag, so a takedown applies on the next
 * load.
 *
 * The page streams through (src/frame-stream.ts): the Worker never holds a
 * whole Site page, so a page of any size up to SITE_FRAME_MAX_BYTES stays
 * within the Worker's memory and a larger one gets a clear page instead of
 * Cloudflare's resource-limit error.
 */
export async function handleVersionHtml(site: SiteContext, versionId: string): Promise<Response> {
  const security = { hsts: site.hsts, frameable: "self" as const };
  const method = site.request.method;
  if (method !== "GET" && method !== "HEAD")
    return messagePage(security, 405, "Not allowed", "Site pages are read-only.");
  if (!UUID.test(versionId)) return neutralPage(security);
  if (!isFrameLoad(site.request)) {
    const response = redirect(site, "/", 302);
    response.headers.set("Vary", "Sec-Fetch-Dest");
    return response;
  }
  const signIn = requiresSignIn(site.config, site.record);
  if (signIn) {
    const probe = await probeAccess(site);
    if (probe.kind === "signin") return frameAccessPage(site, 401);
    if (probe.kind === "forbidden") return frameAccessPage(site, 403);
    if (probe.kind === "missing") return neutralPage(security);
  }
  const etag = await siteFrameEtag(site.record.siteId, versionId);
  const headers = applySecurityHeaders(new Headers(), {
    noindex: site.noindex,
    hsts: site.hsts,
    frameable: "self",
  });
  headers.set("Content-Security-Policy", SITE_HTML_CSP);
  headers.set("Cache-Control", BROWSER_HTML_CACHE_CONTROL);
  headers.set("ETag", etag);
  headers.set("Vary", "Sec-Fetch-Dest");
  const revalidating = etagMatches(site.request.headers.get("if-none-match"), etag);
  const current = versionId === site.record.versionId;
  // The current version's document is fixed by its ETag: the browser already has it.
  if (current && revalidating) return new Response(null, { status: 304, headers });

  const cache = current ? edgeCache() : null;
  const key = edgeCacheKey(site.hostname, "site-html", [
    site.record.generation,
    site.record.siteId,
    versionId,
    await siteFrameFingerprint(),
  ]);
  const hit = cache ? await cache.match(key) : undefined;
  if (hit?.body) {
    headers.set("X-OpenGeni-Site-Cache", "HIT");
    headers.set("Content-Type", "text/html; charset=utf-8");
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
        suffix: `/versions/${versionId}/html`,
      }),
    );
  } catch {
    throw new UpstreamError("Site HTML fetch failed", null);
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return neutralPage(security);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return frameAccessPage(site, response.status);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamError("Site HTML fetch failed", response.status);
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > SITE_FRAME_MAX_BYTES) {
    await response.body?.cancel();
    return siteTooLargePage(site, declared);
  }
  if (revalidating) {
    await response.body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  headers.set("X-OpenGeni-Site-Cache", "MISS");
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (method === "HEAD") {
    await response.body?.cancel();
    return new Response(null, { status: 200, headers });
  }

  const document = siteFrameStream(response.body ?? new ReadableStream<Uint8Array>());
  if (!cache) return new Response(document, { status: 200, headers });
  // Fill the edge cache from the same stream, in step with the viewer.
  const branches = lockstepTee(document);
  site.ctx.waitUntil(branches.done);
  site.ctx.waitUntil(
    cache
      .put(
        key,
        new Response(branches.secondary, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": `public, max-age=${EDGE_HTML_TTL}`,
            ETag: etag,
          },
        }),
      )
      .catch(() => undefined),
  );
  return new Response(branches.primary, { status: 200, headers });
}
