import { fromPostgresLosslessJson, LOSSLESS_JSON_STRING_PREFIX } from "./lossless-json";

export const SESSION_MCP_PROGRESS_CHARS = 600;

// A code point occupies at most two UTF-16 units. Read one extra code point
// so a prefix cannot split the last delivered surrogate pair. Eight base64
// characters encode three complete UTF-16 units, so a cut encoded prefix is
// independently decodable by the canonical codec (no partial bytes/units).
export const SESSION_MCP_PROGRESS_STORAGE_CHARS =
  LOSSLESS_JSON_STRING_PREFIX.length + Math.ceil(((SESSION_MCP_PROGRESS_CHARS + 1) * 2) / 3) * 8;

/** Project only the selected scalar, never the rest of a goal.progress payload. */
export function projectSessionMcpProgressText(
  storedPrefix: string | null,
  storedChars: number | null,
  codecVersion: number | null,
): { text: string | null; originalChars: number | null; textTruncated?: true } {
  if (storedPrefix === null) return { text: null, originalChars: null };
  const decoded = fromPostgresLosslessJson(storedPrefix, codecVersion);
  const chars = Array.from(decoded);
  const encodedPrefixWasCut =
    decoded !== storedPrefix && (storedChars ?? 0) > Array.from(storedPrefix).length;
  // Encoded length determines UTF-16 units, not Unicode code points. The
  // unread suffix may contain surrogate pairs: do not invent an omission count.
  const originalChars = encodedPrefixWasCut
    ? null
    : decoded === storedPrefix
      ? storedChars
      : chars.length;
  return {
    text: chars.slice(0, SESSION_MCP_PROGRESS_CHARS).join(""),
    originalChars,
    ...(encodedPrefixWasCut ? { textTruncated: true } : {}),
  };
}
