import { describe, expect, test } from "bun:test";
import {
  LEGACY_LOSSLESS_JSON_ENVELOPE_KEY,
  LEGACY_LOSSLESS_TEXT_PREFIX,
  LOSSLESS_JSON_STRING_PREFIX,
  LOSSLESS_TEXT_PREFIX,
  UnsupportedCanonicalValueError,
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  toPostgresLosslessJson,
  toPostgresLosslessText,
} from "../src/lossless-json";

describe("lossless PostgreSQL content boundaries", () => {
  test("leaves ordinary queryable JSON unchanged", () => {
    const value = { type: "message", id: "call-synthetic", content: "ordinary 👩🏽‍💻" };
    expect(toPostgresLosslessJson(value)).toBe(value);
    expect(fromPostgresLosslessJson(value)).toBe(value);
  });

  test("round-trips unsafe strings while preserving SQL-visible structural fields", () => {
    const nul = String.fromCharCode(0);
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    const value = {
      id: "call-synthetic",
      updateId: "update-synthetic",
      sourceKey: "source-synthetic",
      recordingId: "recording-synthetic",
      code: "synthetic_code",
      type: "agent.toolCall.output",
      output: `before${nul}middle${loneHigh}${loneLow}after`,
      nested: { [`unsafe${loneHigh}key`]: `value${nul}` },
    };

    const stored = toPostgresLosslessJson(value) as Record<string, unknown>;
    expect(stored.id).toBe(value.id);
    expect(stored.updateId).toBe(value.updateId);
    expect(stored.sourceKey).toBe(value.sourceKey);
    expect(stored.recordingId).toBe(value.recordingId);
    expect(stored.code).toBe(value.code);
    expect(stored.type).toBe(value.type);
    expect(JSON.stringify(stored)).not.toContain("\\u0000");
    expect(fromPostgresLosslessJson(stored)).toEqual(value);
  });

  test("preserves large and deep ordinary JSON without wrapping its SQL shape", () => {
    const root: Record<string, unknown> = {
      id: "large-synthetic",
      body: "x".repeat(96 * 1024),
    };
    let cursor = root;
    for (let depth = 0; depth < 180; depth += 1) {
      const next: Record<string, unknown> = { depth };
      cursor.next = next;
      cursor = next;
    }

    expect(toPostgresLosslessJson(root)).toBe(root);
  });

  test("treats the legacy v1 JSON envelope as ordinary preexisting data", () => {
    const value = {
      [LEGACY_LOSSLESS_JSON_ENVELOPE_KEY]: {
        version: 1,
        data: "b3BlbmdlbmktcHJlZXhpc3RpbmctZGF0YQ==",
      },
    };
    expect(fromPostgresLosslessJson(value)).toBe(value);
    expect(fromPostgresLosslessJson(toPostgresLosslessJson(value))).toEqual(value);
  });

  test("escapes producer strings that begin with the active v2 markers", () => {
    const jsonValue = `${LOSSLESS_JSON_STRING_PREFIX}UVdWamFHVT0=`;
    const textValue = `${LOSSLESS_TEXT_PREFIX}UVdWamFHVT0=`;
    expect(fromPostgresLosslessJson(toPostgresLosslessJson({ value: jsonValue }))).toEqual({
      value: jsonValue,
    });
    expect(fromPostgresLosslessText(toPostgresLosslessText(textValue))).toBe(textValue);
  });

  test("treats the legacy v1 text prefix as exact preexisting text", () => {
    const value = `${LEGACY_LOSSLESS_TEXT_PREFIX}UVdWamFHVT0=`;
    expect(fromPostgresLosslessText(value)).toBe(value);
    expect(fromPostgresLosslessText(toPostgresLosslessText(value))).toBe(value);
  });

  test("lossless text handles NUL and lone UTF-16 code units", () => {
    for (const value of [
      `nul${String.fromCharCode(0)}value`,
      `high${String.fromCharCode(0xd800)}value`,
      `low${String.fromCharCode(0xdc00)}value`,
    ]) {
      expect(fromPostgresLosslessText(toPostgresLosslessText(value))).toBe(value);
    }
  });

  test("rejects non-JSON graphs and executable/accessor values before persistence", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toPostgresLosslessJson(cyclic)).toThrow(UnsupportedCanonicalValueError);
    expect(() => toPostgresLosslessJson({ bigint: 2n })).toThrow(UnsupportedCanonicalValueError);
    expect(() => toPostgresLosslessJson({ callback: () => undefined })).toThrow(
      UnsupportedCanonicalValueError,
    );
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "not invoked",
    });
    expect(() => toPostgresLosslessJson(accessor)).toThrow(UnsupportedCanonicalValueError);
  });
});
