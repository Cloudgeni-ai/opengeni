/**
 * The console's HTML frame host on `og.<sites domain>` (see
 * packages/contracts/src/html-frame-host.ts). The console renders
 * agent-authored HTML in an opaque-origin sandboxed frame of this page, so the
 * HTML never inherits the console's strict Content-Security-Policy and never
 * shares an origin with the console or any Site.
 */
import {
  HTML_FRAME_HOST_DOCUMENT,
  HTML_FRAME_HOST_LABEL,
  HTML_FRAME_HOST_PATH,
  OFFICE_FRAME_ANCESTOR_ORIGINS,
  htmlFrameHostContentSecurityPolicy,
} from "@opengeni/contracts/html-frame-host";
import { normalizeSitesDomain } from "@opengeni/contracts";

/** True when the request is addressed to the frame host's hostname. */
export function isHtmlFrameHostRequest(hostname: string, sitesDomain: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/\.+$/u, "");
  return name === `${HTML_FRAME_HOST_LABEL}.${normalizeSitesDomain(sitesDomain)}`;
}

/**
 * Serves the frame host page. Only the console origin may frame it (plus the
 * Office hosts, because the console's Excel add-in frames it inside Office and
 * every ancestor must pass frame-ancestors); it sends
 * no X-Frame-Options (that header cannot name another origin) and its policy
 * sandboxes the page itself, so a direct visit is just as isolated as the
 * frame. No Permissions-Policy: like the `srcdoc` frame it replaces, the
 * HTML keeps the browser defaults of a cross-origin frame without `allow`.
 * Every other path is a 404.
 */
export function handleHtmlFrameHost(
  request: Request,
  url: URL,
  options: { appOrigin: string; hsts: boolean },
): Response {
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
  });
  if (options.hsts) headers.set("Strict-Transport-Security", "max-age=31536000");
  if (
    url.pathname !== HTML_FRAME_HOST_PATH ||
    (request.method !== "GET" && request.method !== "HEAD")
  ) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    headers.set("X-Frame-Options", "DENY");
    return new Response(request.method === "HEAD" ? null : "Not found.\n", {
      status: 404,
      headers,
    });
  }
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set(
    "Content-Security-Policy",
    htmlFrameHostContentSecurityPolicy([options.appOrigin, ...OFFICE_FRAME_ANCESTOR_ORIGINS]),
  );
  // The page is the same for every console (the embedder's origin is in the
  // query string and checked by the loader), so it can be cached briefly.
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(request.method === "HEAD" ? null : HTML_FRAME_HOST_DOCUMENT, {
    status: 200,
    headers,
  });
}
