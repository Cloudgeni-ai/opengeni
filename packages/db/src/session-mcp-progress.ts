import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  fromPostgresLosslessJson,
  LOSSLESS_CONTENT_CODEC_VERSION,
  LOSSLESS_JSON_STRING_PREFIX,
} from "./lossless-json";

export const SESSION_MCP_PROGRESS_CHARS = 600;

// A code point occupies at most two UTF-16 units. Read one extra code point
// so a prefix cannot split the last delivered surrogate pair. Eight base64
// characters encode three complete UTF-16 units, so a cut encoded prefix is
// independently decodable by the canonical codec (no partial bytes/units).
export const SESSION_MCP_PROGRESS_STORAGE_CHARS =
  LOSSLESS_JSON_STRING_PREFIX.length + Math.ceil(((SESSION_MCP_PROGRESS_CHARS + 1) * 2) / 3) * 8;

// Match the canonical decoder's nonempty, round-tripping base64 of an even
// byte count. Each 8-character block is 6 bytes. The final block contributes
// 6, 2, or 4 bytes; the restricted final sextets enforce zero padding bits.
export const SESSION_MCP_PROGRESS_UTF16_BASE64_PATTERN =
  "([A-Za-z0-9+/]{8})*([A-Za-z0-9+/]{8}|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/]{5}[AQgw]==)";

/** Validate the full scalar in storage; transfer only this boolean, not its suffix. */
export function sessionMcpProgressScalarIsEncodedSql(
  value: SQL,
  codecVersion: SQLWrapper,
): SQL<boolean> {
  // SIMILAR TO matches the whole string, including trailing whitespace. A
  // valid prefix alone cannot prove that the canonical codec would decode it.
  return sql<boolean>`coalesce(
    ${codecVersion} = ${LOSSLESS_CONTENT_CODEC_VERSION}
    and left(${value}, ${LOSSLESS_JSON_STRING_PREFIX.length}) = ${LOSSLESS_JSON_STRING_PREFIX}
    and substring(${value} from ${LOSSLESS_JSON_STRING_PREFIX.length + 1}) collate "C"
      similar to ${SESSION_MCP_PROGRESS_UTF16_BASE64_PATTERN},
    false
  )`;
}

/** Project only the selected scalar, never the rest of a goal.progress payload. */
export function projectSessionMcpProgressText(
  storedPrefix: string | null,
  storedChars: number | null,
  codecVersion: number | null,
  scalarIsEncoded: boolean,
): { text: string | null; originalChars: number | null; textTruncated?: true } {
  if (storedPrefix === null) return { text: null, originalChars: null };
  const decoded = scalarIsEncoded
    ? fromPostgresLosslessJson(storedPrefix, codecVersion)
    : storedPrefix;
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
