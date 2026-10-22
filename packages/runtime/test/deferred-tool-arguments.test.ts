import { describe, expect, test } from "bun:test";
import { restoreDeferredToolArgumentTypes } from "../src/deferred-tool-arguments";

const schema = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    limit: { type: "integer", minimum: 1 },
    ratio: { type: "number" },
    includeOutput: { type: "boolean" },
    facts: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" } } },
    },
    pathParameters: { type: "object", additionalProperties: { type: "string" } },
    cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    mode: { enum: ["a", "b"] },
    page: { anyOf: [{ type: "integer" }, { type: "null" }] },
    nested: {
      type: "object",
      properties: { count: { type: "integer" }, label: { type: "string" } },
    },
  },
};

function restore(args: Record<string, unknown>) {
  const text = restoreDeferredToolArgumentTypes(JSON.stringify(args), schema);
  return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
}

describe("restoreDeferredToolArgumentTypes", () => {
  test("preserves unknown own keys during sibling and nested coercion", () => {
    const input =
      '{"limit":"3","__proto__":{"unused":true},"constructor":"kept","nested":{"count":"4","__proto__":{"extra":true}}}';
    const result = JSON.parse(restoreDeferredToolArgumentTypes(input, schema)!);
    expect(result.limit).toBe(3);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual({ unused: true });
    expect(result.constructor).toBe("kept");
    expect(result.nested.count).toBe(4);
    expect(Object.hasOwn(result.nested, "__proto__")).toBe(true);
    expect(result.nested.__proto__).toEqual({ extra: true });
  });

  test("does not turn numeric overflow into a valid nullable value", () => {
    for (const overflow of ["1e309", "-1e309"]) {
      const nullable = { type: "object", properties: { value: { type: ["number", "null"] } } };
      expect(
        restoreDeferredToolArgumentTypes(JSON.stringify({ value: overflow }), nullable),
      ).toBeNull();
      expect(restore({ ratio: overflow })).toBeNull();
      expect(restore({ limit: "3", ratio: overflow })).toEqual({ limit: 3, ratio: overflow });
    }
  });

  test("rejects overflow inside stringified containers at every depth", () => {
    for (const facts of ["[1e309]", '[{"deep":[-1e309]}]']) {
      expect(restore({ facts })).toBeNull();
      expect(restore({ limit: "3", facts })).toEqual({ limit: 3, facts });
    }
    for (const pathParameters of ['{"value":1e309}', '{"__proto__":{"deep":[1e309]}}']) {
      expect(restore({ pathParameters })).toBeNull();
    }
  });

  test("does not reserialize overflow already present in outer JSON", () => {
    for (const input of [
      '{"limit":"3","ratio":1e309}',
      '{"limit":"3","unknown":[{"deep":-1e309}]}',
      '{"limit":"3","__proto__":{"value":1e309}}',
      '{"nested":{"count":"4","unknown":1e309}}',
    ])
      expect(restoreDeferredToolArgumentTypes(input, schema)).toBeNull();
  });

  test("keeps finite and string-permitted boundary values unchanged in meaning", () => {
    expect(
      restore({ ratio: "1e308", page: "null", cursor: "1e309", sessionId: "[1e309]" }),
    ).toEqual({
      ratio: 1e308,
      page: null,
      cursor: "1e309",
      sessionId: "[1e309]",
    });
    expect(restore({ pathParameters: '{"__proto__":{"unused":true}}' })).toEqual({
      pathParameters: JSON.parse('{"__proto__":{"unused":true}}'),
    });
  });

  test("restores scalars, arrays and objects that arrived as JSON text", () => {
    expect(
      restore({
        sessionId: "s-1",
        limit: "3",
        ratio: "0.5",
        includeOutput: "true",
        facts: '[{"label":"a"}]',
        pathParameters: '{"workspaceId":"w-1"}',
        page: "2",
        nested: { count: "4", label: "7" },
      }),
    ).toEqual({
      sessionId: "s-1",
      limit: 3,
      ratio: 0.5,
      includeOutput: true,
      facts: [{ label: "a" }],
      pathParameters: { workspaceId: "w-1" },
      page: 2,
      nested: { count: 4, label: "7" },
    });
  });

  test("never rewrites a value whose schema allows a string", () => {
    expect(restore({ sessionId: "123", cursor: "42", mode: "a", nested: { label: "1" } })).toBe(
      null,
    );
  });

  test("leaves text that is not exactly an allowed type for normal validation", () => {
    expect(restore({ limit: "three", includeOutput: "yes", facts: '{"label":"a"}' })).toBe(null);
    expect(restore({ limit: "2.5" })).toBe(null);
  });

  test("returns null for already typed or non-object arguments", () => {
    expect(restore({ limit: 3, includeOutput: false, facts: [] })).toBe(null);
    expect(restoreDeferredToolArgumentTypes("[1]", schema)).toBe(null);
    expect(restoreDeferredToolArgumentTypes("not json", schema)).toBe(null);
    expect(restoreDeferredToolArgumentTypes('{"limit":"3"}', undefined)).toBe(null);
  });
});
