import { describe, expect, test } from "bun:test";
import {
  normalizeProtocolJsonValue,
  UnsupportedProtocolJsonValueError,
} from "../src/protocol-json";

describe("normalizeProtocolJsonValue", () => {
  test("omits JavaScript-only undefined object properties recursively without mutating input", () => {
    const input = {
      type: "hosted_tool_call",
      output: undefined,
      providerData: {
        type: "web_search_call",
        optional: undefined,
        result: { query: "OpenGeni" },
      },
    };

    const normalized = normalizeProtocolJsonValue(input);

    expect(normalized).toEqual({
      type: "hosted_tool_call",
      providerData: {
        type: "web_search_call",
        result: { query: "OpenGeni" },
      },
    });
    expect(Object.hasOwn(input, "output")).toBe(true);
    expect(Object.hasOwn(input.providerData, "optional")).toBe(true);
  });

  test("retains references for already-valid protocol JSON", () => {
    const input = { type: "message", content: [{ type: "output_text", text: "done" }] };
    expect(normalizeProtocolJsonValue(input)).toBe(input);
  });

  test("rejects undefined array elements with their exact path", () => {
    expect(() => normalizeProtocolJsonValue({ output: ["ok", undefined] })).toThrow(
      'Protocol JSON value at $["output"][1] cannot contain undefined',
    );
  });

  test("rejects non-JSON values instead of coercing them", () => {
    const cases: Array<[unknown, string]> = [
      [{ usage: 2n }, '$["usage"]'],
      [{ score: Number.NaN }, '$["score"]'],
      [{ createdAt: new Date(0) }, '$["createdAt"]'],
    ];
    for (const [value, path] of cases) {
      try {
        normalizeProtocolJsonValue(value);
        throw new Error("expected normalization to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedProtocolJsonValueError);
        expect((error as UnsupportedProtocolJsonValueError).path).toBe(path);
      }
    }
  });

  test("rejects cycles and preserves prototype-sensitive keys", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeProtocolJsonValue(cyclic)).toThrow(
      'Protocol JSON value at $["self"] cannot contain a cyclic reference',
    );

    const input = JSON.parse('{"__proto__":{"safe":true},"optional":null}') as Record<
      string,
      unknown
    >;
    const normalized = normalizeProtocolJsonValue(input);
    expect(normalized).toBe(input);
    expect(Object.hasOwn(normalized, "__proto__")).toBe(true);
  });
});
