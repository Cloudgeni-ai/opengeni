import { expect, test } from "bun:test";
import { toolPolicyActionName, executableToolSchema } from "../src/tool-policy";

test("only schema-declared valid action discriminators select preferences", () => {
  const schema = {
    type: "object",
    properties: { action: { type: "string", enum: ["read", "write"] } },
  };
  expect(toolPolicyActionName("perform", schema, { action: "read" })).toBe("read");
  expect(toolPolicyActionName("perform", schema, { action: "unknown" })).toBe("perform");
  expect(toolPolicyActionName("perform", { type: "object" }, { action: "read" })).toBe("perform");
  expect(toolPolicyActionName("perform", schema, { action: " read " })).toBe("perform");
  expect(toolPolicyActionName("perform", schema, { action: { toString: () => "read" } })).toBe(
    "perform",
  );
});

test("schema compatibility ignores prose but preserves property names, literals and defaults", () => {
  expect(
    executableToolSchema({
      description: "New prose",
      properties: {
        description: { type: "string", description: "Help", const: "keep" },
        payload: { type: "object", default: { description: "meaningful" } },
      },
      allOf: [{ title: "Heading", required: ["description"] }],
    }),
  ).toEqual({
    properties: {
      description: { type: "string", const: "keep" },
      payload: { type: "object", default: { description: "meaningful" } },
    },
    allOf: [{ required: ["description"] }],
  });
});
