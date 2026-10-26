import { createHash } from "node:crypto";

/**
 * The one acceptance rule for capability logos, shared by the catalog importer,
 * the logo vendoring script and connected MCP server icons. Every accepted logo
 * is stored in object storage under a `catalog-assets/...` key and served by the
 * catalog-asset route, so the browser never loads a logo from a third party.
 */

/** Largest logo the catalog stores. */
export const MAX_LOGO_BYTES = 512 * 1024;

/**
 * The exact content types the catalog-asset route can serve back. Anything
 * outside this map would be stored under an extension the route does not map,
 * so the asset would exist in object storage and still 404. Accepting only
 * these keeps stored bytes and served bytes the same set.
 */
const LOGO_EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/vnd.microsoft.icon": "ico",
  "image/webp": "webp",
  "image/x-icon": "ico",
};

export function normalizedContentType(value: string | null | undefined): string | null {
  return value?.split(";")[0]?.trim().toLowerCase() || null;
}

export function extensionForContentType(contentType: string): string | null {
  return LOGO_EXTENSION_BY_CONTENT_TYPE[contentType] ?? null;
}

export function safePathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

export type LogoAssetValidation =
  | { ok: true; contentType: string; sha256: string; bytes: Uint8Array }
  | { ok: false; reason: string };

export function validateLogoContentType(
  rawContentType: string | null | undefined,
): { ok: true; contentType: string } | { ok: false; reason: string } {
  const contentType = normalizedContentType(rawContentType);
  if (!contentType?.startsWith("image/")) {
    return { ok: false, reason: `invalid_content_type:${contentType ?? "missing"}` };
  }
  if (!extensionForContentType(contentType)) {
    return { ok: false, reason: `unservable_content_type:${contentType}` };
  }
  return { ok: true, contentType };
}

/**
 * Textual SVG constructs that make an asset active content rather than a mark.
 *
 * Defense in depth only: the serving route already sends
 * `X-Content-Type-Options: nosniff` plus `default-src 'none'; sandbox`, and the
 * UI renders logos through `<img>`, so an SVG cannot execute against an
 * Opengeni origin today. Rejecting before storage keeps a scripted mark out of
 * the repository and out of object storage regardless of how the bytes are
 * consumed later.
 */
const SVG_ACTIVE_CONTENT_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: "script_element", re: /<\s*script\b/i },
  { name: "foreign_object", re: /<\s*foreignObject\b/i },
  { name: "event_handler_attribute", re: /\son[a-z]+\s*=/i },
  { name: "javascript_url", re: /javascript\s*:/i },
];

/**
 * `href`/`xlink:href` on the two elements that can pull in another document.
 * The value is extracted rather than matched in place so an optional quote
 * cannot let an external target slip past a lookahead.
 */
const SVG_REFERENCE_HREF =
  /<\s*(use|image)\b[^>]*?\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** A reference an SVG mark may legitimately resolve: same document, or inline bytes. */
function isSelfContainedSvgReference(value: string): boolean {
  const target = value.trim();
  return target.startsWith("#") || /^data:image\//i.test(target);
}

/** Rejects SVG bytes that carry active content; non-SVG bytes always pass. */
export function svgActiveContentReason(contentType: string, bytes: Uint8Array): string | null {
  if (contentType !== "image/svg+xml") {
    return null;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  for (const pattern of SVG_ACTIVE_CONTENT_PATTERNS) {
    if (pattern.re.test(text)) {
      return `svg_active_content:${pattern.name}`;
    }
  }
  SVG_REFERENCE_HREF.lastIndex = 0;
  for (const match of text.matchAll(SVG_REFERENCE_HREF)) {
    const element = match[1]?.toLowerCase() === "use" ? "use" : "image";
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!isSelfContainedSvgReference(value)) {
      return `svg_active_content:external_${element}_href`;
    }
  }
  return null;
}

/**
 * A servable image content type, at most `MAX_LOGO_BYTES`, and no active
 * content inside an SVG.
 */
export function validateLogoAsset(input: {
  contentType: string | null | undefined;
  bytes: Uint8Array;
}): LogoAssetValidation {
  const contentType = validateLogoContentType(input.contentType);
  if (!contentType.ok) return contentType;
  if (input.bytes.byteLength === 0) {
    return { ok: false, reason: "image_empty" };
  }
  if (input.bytes.byteLength > MAX_LOGO_BYTES) {
    return { ok: false, reason: "image_too_large" };
  }
  const activeContent = svgActiveContentReason(contentType.contentType, input.bytes);
  if (activeContent) {
    return { ok: false, reason: activeContent };
  }
  return {
    ok: true,
    contentType: contentType.contentType,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    bytes: input.bytes,
  };
}

/** Digest-keyed object key under `catalog-assets/`; the basename doubles as the ETag. */
export function catalogAssetObjectKey(
  namespace: string,
  sha256: string,
  contentType: string,
): string {
  const extension = extensionForContentType(contentType);
  if (!extension) {
    // Unreachable through the validated paths: `validateLogoContentType`
    // already rejects every content type without a served extension.
    throw new Error(`unsupported logo content type: ${contentType}`);
  }
  const segments = namespace.split("/").map(safePathSegment);
  return `catalog-assets/${segments.join("/")}/${sha256.slice(0, 24)}.${extension}`;
}
