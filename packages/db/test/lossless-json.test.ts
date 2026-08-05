import { describe, expect, test } from "bun:test";
import {
  LEGACY_LOSSLESS_JSON_ENVELOPE_KEY,
  LEGACY_LOSSLESS_TEXT_PREFIX,
  LOSSLESS_CONTENT_CODEC_VERSION,
  LOSSLESS_JSON_STRING_PREFIX,
  LOSSLESS_TEXT_PREFIX,
  UnsupportedCanonicalValueError,
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  toPostgresLosslessJson,
  toPostgresLosslessText,
  withLosslessContentWriteVersion,
} from "../src/lossless-json";

function assertLosslessContentWriteTypeContract(): void {
  // @ts-expect-error protected writes must include the content key they stamp
  withLosslessContentWriteVersion({ id: "missing-payload" }, "payload", "payloadCodecVersion");
}
void assertLosslessContentWriteTypeContract;

describe("lossless PostgreSQL content boundaries", () => {
  test("leaves ordinary queryable JSON unchanged", () => {
    const value = { type: "message", id: "call-synthetic", content: "ordinary 👩🏽‍💻" };
    expect(toPostgresLosslessJson(value)).toBe(value);
    expect(fromPostgresLosslessJson(value, LOSSLESS_CONTENT_CODEC_VERSION)).toBe(value);
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
    expect(fromPostgresLosslessJson(stored, LOSSLESS_CONTENT_CODEC_VERSION)).toEqual(value);
  });

  test("preserves nested __proto__ as own JSON data through encode and decode", () => {
    const source = JSON.parse(
      `{"nested":{"__proto__":{"polluted":true},"safe":"x\\u0000y"}}`,
    ) as Record<string, Record<string, unknown>>;

    const stored = toPostgresLosslessJson(source) as Record<string, Record<string, unknown>>;
    const restored = fromPostgresLosslessJson(stored, LOSSLESS_CONTENT_CODEC_VERSION);

    for (const value of [source.nested, stored.nested, restored.nested]) {
      expect(Object.keys(value!)).toEqual(["__proto__", "safe"]);
      expect(Object.hasOwn(value!, "__proto__")).toBeTrue();
      expect(Object.getPrototypeOf(value!)).toBe(Object.prototype);
      expect((value as { polluted?: unknown }).polluted).toBeUndefined();
      expect(value!["__proto__"]).toEqual({ polluted: true });
    }
    expect(restored).toEqual(source);
  });

  test("fails closed when decoding an encoded key would collide with literal storage", () => {
    const unsafeKey = `unsafe${String.fromCharCode(0)}key`;
    const encoded = toPostgresLosslessJson({ [unsafeKey]: "encoded" }) as Record<string, unknown>;
    const encodedKey = Object.keys(encoded)[0]!;
    const collision: Record<string, unknown> = {};
    Object.defineProperty(collision, encodedKey, {
      value: "encoded",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(collision, unsafeKey, {
      value: "literal",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(fromPostgresLosslessJson(collision, LOSSLESS_CONTENT_CODEC_VERSION)).toBe(collision);
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
    expect(fromPostgresLosslessJson(value, null)).toBe(value);
    expect(
      fromPostgresLosslessJson(toPostgresLosslessJson(value), LOSSLESS_CONTENT_CODEC_VERSION),
    ).toEqual(value);
  });

  test("escapes producer strings that begin with the active v2 markers", () => {
    const jsonValue = `${LOSSLESS_JSON_STRING_PREFIX}UVdWamFHVT0=`;
    const textValue = `${LOSSLESS_TEXT_PREFIX}UVdWamFHVT0=`;
    expect(
      fromPostgresLosslessJson(
        toPostgresLosslessJson({ value: jsonValue }),
        LOSSLESS_CONTENT_CODEC_VERSION,
      ),
    ).toEqual({ value: jsonValue });
    expect(
      fromPostgresLosslessText(toPostgresLosslessText(textValue), LOSSLESS_CONTENT_CODEC_VERSION),
    ).toBe(textValue);
  });

  test("treats the legacy v1 text prefix as exact preexisting text", () => {
    const value = `${LEGACY_LOSSLESS_TEXT_PREFIX}UVdWamFHVT0=`;
    expect(fromPostgresLosslessText(value, null)).toBe(value);
    expect(
      fromPostgresLosslessText(toPostgresLosslessText(value), LOSSLESS_CONTENT_CODEC_VERSION),
    ).toBe(value);
  });

  test("lossless text handles NUL and lone UTF-16 code units", () => {
    for (const value of [
      `nul${String.fromCharCode(0)}value`,
      `high${String.fromCharCode(0xd800)}value`,
      `low${String.fromCharCode(0xdc00)}value`,
    ]) {
      expect(
        fromPostgresLosslessText(toPostgresLosslessText(value), LOSSLESS_CONTENT_CODEC_VERSION),
      ).toBe(value);
    }
  });

  test("never decodes valid marker-shaped legacy content without out-of-band version truth", () => {
    const validJsonMarker = `${LOSSLESS_JSON_STRING_PREFIX}QQAAAA==`;
    const validTextMarker = ` ${LOSSLESS_TEXT_PREFIX}0000; `;
    expect(fromPostgresLosslessJson(validJsonMarker, null)).toBe(validJsonMarker);
    expect(fromPostgresLosslessText(validTextMarker, null)).toBe(validTextMarker);
    expect(fromPostgresLosslessJson(validJsonMarker, LOSSLESS_CONTENT_CODEC_VERSION)).toBe(
      `${String.fromCharCode(65)}${String.fromCharCode(0)}`,
    );
    expect(fromPostgresLosslessText(validTextMarker, LOSSLESS_CONTENT_CODEC_VERSION)).toBe(
      String.fromCharCode(0),
    );
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

    const arrayWithExtraProperty = ["safe\u0000value"] as unknown[] & {
      sourceKey?: string;
    };
    arrayWithExtraProperty.sourceKey = "must-not-disappear";
    expect(() => toPostgresLosslessJson(arrayWithExtraProperty)).toThrow(
      UnsupportedCanonicalValueError,
    );

    const arrayWithHiddenProperty = Object.defineProperty(["safe"], "hidden", {
      value: "must-not-disappear",
      enumerable: false,
    });
    expect(() => toPostgresLosslessJson(arrayWithHiddenProperty)).toThrow(
      UnsupportedCanonicalValueError,
    );
  });
});
