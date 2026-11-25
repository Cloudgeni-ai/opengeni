import { applySecurityHeaders } from "./headers";

/**
 * The opt-in Opengeni look for apps (`<link rel="stylesheet" href="/__opengeni/ui.css">`)
 * and its chart helpers (`<script src="/__opengeni/charts.js">`). Site HTML
 * runs in an opaque origin, so both may be read cross-origin.
 */
export function siteUiAsset(
  request: Request,
  hsts: boolean,
  contentType: string,
  body: string,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const headers = applySecurityHeaders(
    new Headers({
      "content-type": contentType,
      "cache-control": "public, max-age=300",
    }),
    { noindex: true, hsts },
  );
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(request.method === "HEAD" ? null : body, { headers });
}
