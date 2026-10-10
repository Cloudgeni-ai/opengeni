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
