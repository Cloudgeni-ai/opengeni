import { describe, expect, test } from "bun:test";
import {
  LOSSLESS_CONTENT_CODEC_VERSION,
  LOSSLESS_JSON_STRING_PREFIX,
  toPostgresLosslessJson,
} from "../src/lossless-json";
import {
  projectSessionMcpProgressText,
  SESSION_MCP_PROGRESS_CHARS,
  SESSION_MCP_PROGRESS_STORAGE_CHARS,
} from "../src/session-mcp-progress";

function projectStored(stored: string, codecVersion: number | null) {
  const chars = Array.from(stored);
  return projectSessionMcpProgressText(
    chars.slice(0, SESSION_MCP_PROGRESS_STORAGE_CHARS).join(""),
    chars.length,
    codecVersion,
  );
}

describe("bounded canonical MCP progress scalar", () => {
  test("preserves absent progress and ordinary Unicode counts", () => {
    expect(projectSessionMcpProgressText(null, null, null)).toEqual({
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
});
