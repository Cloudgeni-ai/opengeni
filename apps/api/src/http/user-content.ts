/**
 * Response headers for user-controlled bytes served from the API origin.
 *
 * Retained files, screenshots, exports, and live frames carry bytes and, for
 * uploads, a content type chosen by a user or agent. The API shares its origin
 * with the web console in the default deployment, so a stored `text/html` file
 * opened by top-level navigation would otherwise run as that origin.
 *
 * Every such response therefore:
 * - is a sandboxed document with no script, form, popup, plugin, or network
 *   capability (`sandbox` plus `default-src 'none'`). Raster images and text
 *   still render when a URL is opened directly;
 * - cannot be embedded by another site as a no-cors subresource (CORP);
 * - is never re-sniffed into a different type (`nosniff`).
 *
 * Audio and video keep their real origin (`sandbox allow-same-origin`, still
 * without `allow-scripts`): the browser's synthesized media document re-fetches
 * its own URL, and from an opaque origin that same-origin-only request would be
 * refused. With scripts disabled and `nosniff`, such a response can only ever
 * be a media player, never attacker markup.
 *
 * Markup types that a browser would render as an active document (HTML, XML,
 * SVG, multipart) are additionally served as attachments, so a direct
 * navigation downloads the bytes instead of showing attacker-authored markup on
 * the app origin. The console never navigates to these routes: it reads bytes
 * through the SDK and renders them in app-owned elements, so neither header
 * changes an in-app preview.
 */
const USER_CONTENT_FETCH_DIRECTIVES =
  "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline'";

export const USER_CONTENT_SECURITY_POLICY = `${USER_CONTENT_FETCH_DIRECTIVES}; sandbox`;

/** Media players only; scripts stay disabled (see the module comment). */
export const USER_MEDIA_CONTENT_SECURITY_POLICY = `${USER_CONTENT_FETCH_DIRECTIVES}; sandbox allow-same-origin`;

export const USER_CONTENT_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": USER_CONTENT_SECURITY_POLICY,
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
} as const);

const ACTIVE_DOCUMENT_TYPES = new Set(["text/html", "text/xml", "text/xsl", "application/xml"]);

/** Media type essence (no parameters), lowercased. */
function mediaTypeEssence(contentType: string): string {
  return (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

/**
 * True when a browser would render this type as an active document (HTML,
 * XHTML, SVG, any XML dialect, or multipart replacement streams). Anything that
 * is not a clean `type/subtype` token is treated as active too.
 */
export function isActiveUserContentType(contentType: string): boolean {
  const essence = mediaTypeEssence(contentType);
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(essence)) return true;
  return (
    ACTIVE_DOCUMENT_TYPES.has(essence) ||
    essence.endsWith("+xml") ||
    essence.startsWith("multipart/")
  );
}

/** ASCII-only quoted filename that cannot break out of the header parameter. */
function dispositionFilename(filename: string): string {
  const safe = filename
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return safe || "download";
}

/** `Content-Disposition: attachment` for active markup; inline types are unchanged. */
export function userContentDispositionHeaders(
  contentType: string,
  filename?: string | null,
): { "Content-Disposition": string } | Record<string, never> {
  if (!isActiveUserContentType(contentType)) return {};
  return {
    "Content-Disposition": filename
      ? `attachment; filename="${dispositionFilename(filename)}"`
      : "attachment",
  };
}

/** True for audio and video types the browser plays in a synthesized media document. */
export function isPlayableMediaUserContentType(contentType: string): boolean {
  const essence = mediaTypeEssence(contentType);
  return !isActiveUserContentType(essence) && /^(audio|video)\//.test(essence);
}

/** Sandbox policy for one response; only playable media keeps its origin. */
export function userContentSecurityPolicy(contentType: string): string {
  return isPlayableMediaUserContentType(contentType)
    ? USER_MEDIA_CONTENT_SECURITY_POLICY
    : USER_CONTENT_SECURITY_POLICY;
}

/** Full header set for one user-content response with the given content type. */
export function userContentResponseHeaders(
  contentType: string,
  filename?: string | null,
): Record<string, string> {
  return {
    ...USER_CONTENT_SECURITY_HEADERS,
    "Content-Security-Policy": userContentSecurityPolicy(contentType),
    ...userContentDispositionHeaders(contentType, filename),
  };
}
