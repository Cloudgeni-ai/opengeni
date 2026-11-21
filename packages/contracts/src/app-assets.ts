/**
 * Multi-file app versions ("big apps stay fast"): an app version may carry
 * immutable asset files (the JS chunks, CSS, fonts and images of a normal
 * Vite or Bun build) next to its entry HTML, so each page loads only its own
 * code and browsers cache it for a year.
 *
 * - Agents upload the files as one JSON bundle (`SiteAssetBundle`) beside the
 *   HTML; the API stores each file content-addressed per workspace and keeps
 *   a manifest (`SiteAssetManifest`) on the immutable version row.
 * - App frames are opaque-origin and send no cookies, so a version's file
 *   URLs carry an unguessable per-version token that only its access-checked
 *   HTML reveals. Published apps load them from their own host through the
 *   Sites gateway (`/_og/a/...`); the console loads them from the API
 *   (`/v1/app-assets/...`), which also works without a Sites domain.
 * - The version's HTML gets a `<base href>` for its folder
 *   (`injectSiteAssetBase`), so a build with a relative base works unchanged.
 *
 * Keep this module dependency-free apart from zod: the Sites gateway Worker,
 * the API and the React frame share it.
 */
import { z } from "zod";

/** Most files one version may carry. */
export const SITE_ASSET_MAX_FILES = 1_000;
/** Largest single asset file. */
export const SITE_ASSET_MAX_FILE_BYTES = 16 * 1024 * 1024;
/** All asset files of one version together. */
export const SITE_ASSET_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/**
 * The uploaded JSON bundle (base64 content is a third larger than the
 * files). The API holds a bundle in memory while it publishes, so this stays
 * modest; large media belongs in app files.
 */
export const SITE_ASSET_BUNDLE_MAX_BYTES = 48 * 1024 * 1024;
/** Longest asset path. */
export const SITE_ASSET_PATH_MAX_CHARS = 512;

/** Browser and edge caching for asset files: they never change for their version. */
export const SITE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The gateway's asset route on a published app's own host. */
export const SITE_GATEWAY_ASSET_PREFIX = "/_og/a";
/** The API's asset route for the console frame (no Sites domain needed). */
export const SITE_ASSET_API_PREFIX = "/v1/app-assets";

/**
 * Content type per file extension. Only what a static single-page build
 * emits; HTML pages and anything else are refused at publish, so a file is
 * never served as a document of its own.
 */
export const SITE_ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  wasm: "application/wasm",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
});

/** The served content type of an asset path, or null when its extension is not allowed. */
export function siteAssetContentType(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return SITE_ASSET_CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

const SEGMENT = /^[A-Za-z0-9._~@+-]+$/u;

/**
 * A relative, traversal-free path such as `assets/index-4f2a.js`: segments
 * of letters, digits and `._~@+-`, no `.` or `..` segment, an allowed
 * extension. These characters never need encoding in a URL path, so the
 * stored path is also the exact URL path.
 */
export function isSiteAssetPath(path: string): boolean {
  if (path.length === 0 || path.length > SITE_ASSET_PATH_MAX_CHARS) return false;
  const segments = path.split("/");
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === ".."))
    return false;
  return siteAssetContentType(path) !== null;
}

/** The per-version capability in asset URLs: 128 random bits, base64url. */
export const SITE_ASSET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const SiteAssetFile = z
  .object({
    path: z.string().refine(isSiteAssetPath, { message: "invalid app asset path" }),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    sizeBytes: z.number().int().nonnegative().max(SITE_ASSET_MAX_FILE_BYTES),
  })
  .strict();
export type SiteAssetFile = z.infer<typeof SiteAssetFile>;

/** What a version row keeps: its token and files, sorted by path. */
export const SiteAssetManifest = z
  .object({
    token: z.string().regex(SITE_ASSET_TOKEN_PATTERN),
    files: z.array(SiteAssetFile).min(1).max(SITE_ASSET_MAX_FILES),
  })
  .strict();
export type SiteAssetManifest = z.infer<typeof SiteAssetManifest>;

/**
 * What an agent uploads beside the HTML: every file of the build output
 * except the entry HTML, with its path relative to that HTML and its bytes
 * as base64.
 */
export const SiteAssetBundle = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string(),
            base64: z.string(),
          })
          .strict(),
      )
      .min(1)
      .max(SITE_ASSET_MAX_FILES),
  })
  .strict();
export type SiteAssetBundle = z.infer<typeof SiteAssetBundle>;

/** The stored asset file, by its content's SHA-256, shared by a workspace's versions. */
export function siteAssetObjectKey(workspaceId: string, sha256: string): string {
  return `workspaces/${workspaceId}/workspace-artifacts/assets/${sha256}`;
}

/** A version's asset folder on its published host (relative to that host). */
export function siteAssetGatewayBase(versionId: string, token: string): string {
  return `${SITE_GATEWAY_ASSET_PREFIX}/${versionId}/${token}/`;
}

/** A version's asset folder on the API, for the console frame. */
export function siteAssetApiBase(
  apiBaseUrl: string,
  workspaceId: string,
  versionId: string,
  token: string,
): string {
  return `${apiBaseUrl.replace(/\/+$/u, "")}${SITE_ASSET_API_PREFIX}/${workspaceId}/${versionId}/${token}/`;
}

/**
 * Split `<versionId>/<token>/<path>` (what follows an asset prefix). Null for
 * anything that is not a well-formed asset address.
 */
export function parseSiteAssetAddress(
  rest: string,
): { versionId: string; token: string; path: string } | null {
  const first = rest.indexOf("/");
  const second = first < 0 ? -1 : rest.indexOf("/", first + 1);
  if (second < 0) return null;
  const versionId = rest.slice(0, first);
  const token = rest.slice(first + 1, second);
  const path = rest.slice(second + 1);
  if (!UUID_PATTERN.test(versionId) || !SITE_ASSET_TOKEN_PATTERN.test(token)) return null;
  if (!isSiteAssetPath(path)) return null;
  return { versionId, token, path };
}

/**
 * Bare `#section` links scroll within the page as they would without a
 * `<base>` (with one, the browser would resolve them against the asset
 * folder and leave the app).
 */
const HASH_LINK_SCRIPT =
  '<script>addEventListener("click",function(e){var t=e.target,a=t&&t.closest&&t.closest("a[href]");' +
  "if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;" +
  'var h=a.getAttribute("href")||"",g=(a.getAttribute("target")||"").toLowerCase();' +
  'if(h.charAt(0)!=="#"||(g&&g!=="_self"))return;e.preventDefault();location.hash=h;})</script>';

function escapeAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
}

function leadingDoctypeEnd(html: string): number {
  const lower = html.toLowerCase();
  let cursor = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (cursor < html.length) {
    while (/\s/u.test(html[cursor] ?? "")) cursor += 1;
    if (!html.startsWith("<!--", cursor)) break;
    const commentEnd = html.indexOf("-->", cursor + 4);
    if (commentEnd < 0) return -1;
    cursor = commentEnd + 3;
  }
  if (!lower.startsWith("<!doctype", cursor)) return -1;
  return html.indexOf(">", cursor + 9);
}

/**
 * The version's HTML with a `<base href>` for its asset folder, placed right
 * after the doctype so it precedes every relative URL in the document (the
 * parser moves it into the head). Ours comes first, so it wins over a base
 * the build may have written. It deliberately also precedes the page's own
 * `<meta charset>` and CSP `<meta>`: the tags are ASCII, the response
 * declares UTF-8, and a CSP `<meta>` applies only to what follows it.
 */
export function injectSiteAssetBase(html: string, baseHref: string): string {
  const tag = `<base href="${escapeAttribute(baseHref)}">${HASH_LINK_SCRIPT}`;
  const doctypeEnd = leadingDoctypeEnd(html);
  if (doctypeEnd >= 0) return `${html.slice(0, doctypeEnd + 1)}${tag}${html.slice(doctypeEnd + 1)}`;
  // Without a doctype it goes first, after a byte-order mark.
  const bom = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  return `${html.slice(0, bom)}${tag}${html.slice(bom)}`;
}
