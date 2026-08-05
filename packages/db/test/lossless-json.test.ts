import { describe, expect, test } from "bun:test";
import {
  LOSSLESS_JSON_ENVELOPE_KEY,
  UnsupportedCanonicalValueError,
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  serializeCanonicalValue,
  deserializeCanonicalValue,
  toPostgresLosslessJson,
  toPostgresLosslessText,
} from "../src/lossless-json";

describe("lossless PostgreSQL content boundaries", () => {
  test("leaves ordinary queryable JSON unchanged", () => {
    const value = { type: "message", role: "user", content: "ordinary 👩🏽‍💻" };
    expect(toPostgresLosslessJson(value)).toBe(value);
    expect(fromPostgresLosslessJson(value)).toBe(value);
  });

  test("round-trips NUL and lone UTF-16 code units exactly", () => {
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    const value = {
      key: `before${String.fromCharCode(0)}after`,
      loneHigh,
      loneLow,
      nested: { [`unsafe${loneHigh}key`]: "value" },
    };
    const stored = toPostgresLosslessJson(value);
    expect(JSON.stringify(stored)).not.toContain("\\u0000");
    const restored = fromPostgresLosslessJson(stored) as typeof value;
    expect(restored).toEqual(value);
    expect(restored.key).toBe(value.key);
    expect(restored.loneHigh).toBe(loneHigh);
    expect(restored.loneLow).toBe(loneLow);
    expect(Object.keys(restored.nested)).toEqual(Object.keys(value.nested));
  });

  test("preserves oversized, deep, repeated, and cyclic graphs", () => {
    const root: Record<string, unknown> = { body: "x".repeat(96 * 1024) };
    let cursor = root;
    for (let depth = 0; depth < 180; depth += 1) {
      const next: Record<string, unknown> = { depth };
      cursor.next = next;
      cursor = next;
    }
    root.repeated = cursor;
    root.self = root;

    const restored = fromPostgresLosslessJson(toPostgresLosslessJson(root)) as typeof root;
    expect(restored.body).toBe(root.body);
    expect(restored.self).toBe(restored);
    let restoredCursor = restored as Record<string, unknown>;
    for (let depth = 0; depth < 180; depth += 1) {
      restoredCursor = restoredCursor.next as Record<string, unknown>;
      expect(restoredCursor.depth).toBe(depth);
    }
    expect(restored.repeated).toBe(restoredCursor);
  });

  test("does not collide with a producer object using the reserved marker", () => {
    const value = {
      [LOSSLESS_JSON_ENVELOPE_KEY]: { version: 1, data: "producer-content" },
      ordinary: true,
    };
    expect(fromPostgresLosslessJson(toPostgresLosslessJson(value))).toEqual(value);
  });

  test("structured-clone bytes retain exact graph identity", () => {
    const value: Record<string, unknown> = { bigint: 2n, missing: undefined };
    value.self = value;
    const restored = deserializeCanonicalValue(serializeCanonicalValue(value)) as typeof value;
    expect(restored.bigint).toBe(2n);
    expect(Object.prototype.hasOwnProperty.call(restored, "missing")).toBeTrue();
    expect(restored.self).toBe(restored);
  });

  test("lossless text handles database-unsafe strings and its reserved prefix", () => {
    for (const value of [
      `nul${String.fromCharCode(0)}value`,
      `lone${String.fromCharCode(0xd800)}value`,
      "opengeni-canonical-text-v1:producer-content",
    ]) {
      expect(fromPostgresLosslessText(toPostgresLosslessText(value))).toBe(value);
    }
  });

  test("rejects executable/accessor values before persistence", () => {
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
