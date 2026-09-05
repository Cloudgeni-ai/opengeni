import { describe, expect, test } from "bun:test";
import {
  LOSSLESS_CONTENT_CODEC_VERSION,
  LOSSLESS_JSON_STRING_PREFIX,
  fromPostgresLosslessJson,
  toPostgresLosslessJson,
} from "../src/lossless-json";
import {
  projectSessionMcpProgressText,
  SESSION_MCP_PROGRESS_CHARS,
  SESSION_MCP_PROGRESS_STORAGE_CHARS,
  SESSION_MCP_PROGRESS_UTF16_BASE64_PATTERN,
} from "../src/session-mcp-progress";

function scalarIsEncoded(stored: string, codecVersion: number | null): boolean {
  if (
    codecVersion !== LOSSLESS_CONTENT_CODEC_VERSION ||
    !stored.startsWith(LOSSLESS_JSON_STRING_PREFIX)
  )
    return false;
  const encoded = stored.slice(LOSSLESS_JSON_STRING_PREFIX.length);
  // Equality excludes JS's special pre-final-newline $ match and mirrors
  // PostgreSQL SIMILAR TO's whole-string matching.
  return (
    new RegExp(`^(?:${SESSION_MCP_PROGRESS_UTF16_BASE64_PATTERN})$`, "u").exec(encoded)?.[0] ===
    encoded
  );
}

function projectStored(stored: string, codecVersion: number | null) {
  const chars = Array.from(stored);
  return projectSessionMcpProgressText(
    chars.slice(0, SESSION_MCP_PROGRESS_STORAGE_CHARS).join(""),
    chars.length,
    codecVersion,
    scalarIsEncoded(stored, codecVersion),
  );
}

describe("bounded canonical MCP progress scalar", () => {
  test("preserves absent progress and ordinary Unicode counts", () => {
    expect(projectSessionMcpProgressText(null, null, null, false)).toEqual({
      text: null,
      originalChars: null,
    });
    for (const note of ["", "Tests are green 🙂", "🙂".repeat(700)]) {
      expect(projectStored(note, LOSSLESS_CONTENT_CODEC_VERSION)).toEqual({
        text: Array.from(note).slice(0, SESSION_MCP_PROGRESS_CHARS).join(""),
        originalChars: Array.from(note).length,
      });
    }
  });

  test("decodes versioned NUL, lone surrogates and literal reserved prefixes", () => {
    for (const note of [
      "tests\u0000green",
      "before\ud800after\udc00",
      `${LOSSLESS_JSON_STRING_PREFIX}literal`,
    ]) {
      const stored = toPostgresLosslessJson(note) as string;
      expect(stored).not.toBe(note);
      expect(projectStored(stored, LOSSLESS_CONTENT_CODEC_VERSION)).toEqual({
        text: note,
        originalChars: Array.from(note).length,
      });
    }
  });

  test("never decodes marker-shaped legacy data or unsupported codec versions", () => {
    for (const version of [null, 0, 2]) {
      for (const note of ["legacy\u0000literal", "🙂".repeat(5000) + "\u0000"]) {
        const marker = toPostgresLosslessJson(note) as string;
        expect(projectStored(marker, version)).toEqual({
          text: marker.slice(0, SESSION_MCP_PROGRESS_CHARS),
          originalChars: marker.length,
        });
      }
    }
  });

  test("keeps exact canonical counts when the entire encoded scalar fits", () => {
    const note = "a".repeat(900) + "🙂\u0000";
    const stored = toPostgresLosslessJson(note) as string;
    expect(stored.length).toBeLessThan(SESSION_MCP_PROGRESS_STORAGE_CHARS);
    expect(projectStored(stored, LOSSLESS_CONTENT_CODEC_VERSION)).toEqual({
      text: "a".repeat(SESSION_MCP_PROGRESS_CHARS),
      originalChars: 902,
    });
  });

  test("long encoded scalars preserve canonical prefixes and signal loss without invented counts", () => {
    for (const note of [
      "a".repeat(10_000) + "\u0000",
      "🙂".repeat(5000) + "\u0000",
      "a".repeat(599) + "🙂" + "b".repeat(10_000) + "\u0000",
      "\ud800".repeat(5000),
      LOSSLESS_JSON_STRING_PREFIX + "z".repeat(5000),
    ]) {
      const stored = toPostgresLosslessJson(note) as string;
      expect(stored.length).toBeGreaterThan(SESSION_MCP_PROGRESS_STORAGE_CHARS);
      const result = projectStored(stored, LOSSLESS_CONTENT_CODEC_VERSION);
      expect(result).toEqual({
        text: Array.from(note).slice(0, SESSION_MCP_PROGRESS_CHARS).join(""),
        originalChars: null,
        textTruncated: true,
      });
      expect(Array.from(result.text!).length).toBe(SESSION_MCP_PROGRESS_CHARS);
    }
  });

  test("preserves malformed complete markers just as the canonical decoder does", () => {
    for (const suffix of ["", "!not-base64", "YQ==", "YQ==="]) {
      const marker = LOSSLESS_JSON_STRING_PREFIX + suffix;
      expect(projectStored(marker, LOSSLESS_CONTENT_CODEC_VERSION)).toEqual({
        text: marker,
        originalChars: marker.length,
      });
    }
  });

  test("invalid suffixes beyond the prefix remain literal, matching full canonical decoding", () => {
    const prefix = LOSSLESS_JSON_STRING_PREFIX + "YQBhAGEA".repeat(600);
    expect(prefix.length).toBeGreaterThan(SESSION_MCP_PROGRESS_STORAGE_CHARS);
    for (const suffix of ["!", "\n", "=", "YQ==", "YWF=", "YQBh=", "YQBhAGEA!"]) {
      const stored = prefix + suffix;
      const canonical = fromPostgresLosslessJson(stored, LOSSLESS_CONTENT_CODEC_VERSION);
      expect(canonical).toBe(stored);
      expect(projectStored(stored, LOSSLESS_CONTENT_CODEC_VERSION)).toEqual({
        text: Array.from(canonical).slice(0, SESSION_MCP_PROGRESS_CHARS).join(""),
        originalChars: Array.from(canonical).length,
      });
    }
  });

  test("full-scalar validity matches the canonical decoder for byte parity and padding bits", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (let length = 1; length <= 48; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 17 + length) % 256));
      const encoded = bytes.toString("base64");
      const lastData = encoded.replace(/=+$/, "").length - 1;
      for (const finalSextet of alphabet) {
        const mutated = encoded.slice(0, lastData) + finalSextet + encoded.slice(lastData + 1);
        const stored = LOSSLESS_JSON_STRING_PREFIX + mutated;
        const canonical = fromPostgresLosslessJson(stored, LOSSLESS_CONTENT_CODEC_VERSION);
        expect(scalarIsEncoded(stored, LOSSLESS_CONTENT_CODEC_VERSION)).toBe(canonical !== stored);
        expect(projectStored(stored, LOSSLESS_CONTENT_CODEC_VERSION).text).toBe(canonical);
      }
    }
  });
});
