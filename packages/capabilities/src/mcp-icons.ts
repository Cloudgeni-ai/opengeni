import { MAX_LOGO_BYTES, normalizedContentType } from "./logo-asset";

/**
 * MCP server icons (`serverInfo.icons`, spec 2025-11-25, SEP-973).
 *
 * A server may list several icons: different formats, sizes and themes. The
 * catalog keeps one logo per capability, drawn on the same tile in both themes,
 * so this picks the icons most likely to read well there, best first. Fetching,
 * validating and storing the chosen bytes is the caller's job.
 */

export type McpIcon = {
  readonly src: string;
  readonly mimeType: string | null;
  /** Largest declared edge in pixels; `Infinity` for `any` (vector). Null when undeclared. */
  readonly size: number | null;
  readonly theme: "light" | "dark" | null;
};

/** At most this many icons are tried before a server keeps its monogram. */
export const MAX_MCP_ICON_ATTEMPTS = 3;

/** The `icons` of an MCP `Implementation` (serverInfo), normalized; malformed entries are dropped. */
export function mcpServerIcons(serverInfo: unknown): McpIcon[] {
  if (!serverInfo || typeof serverInfo !== "object") return [];
  const icons = (serverInfo as { icons?: unknown }).icons;
  if (!Array.isArray(icons)) return [];
  return icons.slice(0, 32).flatMap((value): McpIcon[] => {
    if (!value || typeof value !== "object") return [];
    const icon = value as Record<string, unknown>;
    if (typeof icon.src !== "string") return [];
    const src = icon.src.trim();
    if (!/^https:\/\//i.test(src) && !/^data:image\//i.test(src)) return [];
    // A data URI larger than any acceptable logo is not worth decoding.
    if (src.length > Math.ceil(MAX_LOGO_BYTES * 1.4) + 256) return [];
    const theme = icon.theme === "light" || icon.theme === "dark" ? icon.theme : null;
    return [
      {
        src,
        mimeType: typeof icon.mimeType === "string" ? normalizedContentType(icon.mimeType) : null,
        size: largestDeclaredSize(icon.sizes),
        theme,
      },
    ];
  });
}

function largestDeclaredSize(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let largest: number | null = null;
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const size = entry.trim().toLowerCase();
    if (size === "any") return Number.POSITIVE_INFINITY;
    const match = /^(\d{1,5})x(\d{1,5})$/.exec(size);
    if (!match) continue;
    const edge = Math.max(Number(match[1]), Number(match[2]));
    largest = largest === null ? edge : Math.max(largest, edge);
  }
  return largest;
}

function iconFormat(icon: McpIcon): string | null {
  if (icon.mimeType) return icon.mimeType;
  const dataType = /^data:([^;,]+)/i.exec(icon.src)?.[1];
  if (dataType) return normalizedContentType(dataType);
  const path = (() => {
    try {
      return new URL(icon.src).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".ico")) return "image/x-icon";
  return null;
}

/**
 * Icons ordered best first for a single theme-neutral tile:
 * - an icon without a theme, then one for light backgrounds, then dark;
 * - vector before raster, a large raster (64 px and up) before a small one or
 *   one of unknown size, and a favicon (`.ico`) last.
 */
export function rankMcpServerIcons(icons: readonly McpIcon[]): McpIcon[] {
  const themeRank = (icon: McpIcon) => (icon.theme === null ? 0 : icon.theme === "light" ? 1 : 2);
  const formatRank = (icon: McpIcon) => {
    const format = iconFormat(icon);
    if (format === "image/svg+xml") return 0;
    if (format === "image/x-icon" || format === "image/vnd.microsoft.icon") return 3;
    if (icon.size !== null && icon.size >= 64) return 1;
    return 2;
  };
  return icons
    .map((icon, index) => ({ icon, index }))
    .sort(
      (a, b) =>
        themeRank(a.icon) - themeRank(b.icon) ||
        formatRank(a.icon) - formatRank(b.icon) ||
        (b.icon.size ?? 0) - (a.icon.size ?? 0) ||
        a.index - b.index,
    )
    .map(({ icon }) => icon);
}

/** Bytes and declared type of a `data:` icon, or null when it is not a decodable image. */
export function decodeDataUriIcon(
  src: string,
): { contentType: string | null; bytes: Uint8Array } | null {
  const match = /^data:([^,]*?),(.*)$/is.exec(src);
  if (!match) return null;
  const header = match[1] ?? "";
  const payload = match[2] ?? "";
  const parts = header.split(";").map((part) => part.trim());
  const base64 = parts.slice(1).some((part) => part.toLowerCase() === "base64");
  const contentType = normalizedContentType(parts[0] || null);
  try {
    const bytes = base64
      ? Uint8Array.from(Buffer.from(payload.replace(/\s+/g, ""), "base64"))
      : new TextEncoder().encode(decodeURIComponent(payload));
    return { contentType, bytes };
  } catch {
    return null;
  }
}
