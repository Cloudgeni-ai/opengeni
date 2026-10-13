import { expect, test } from "bun:test";
import * as contracts from "@opengeni/contracts";
import { z } from "zod";
import { ACTION_CATALOG } from "../src/mcp/action-catalog.gen";
import { ACTION_REQUEST_SCHEMAS } from "../src/mcp/action-schema-imports.gen";
import { describeAction } from "../src/organization-mcp";

test("every action keeps the exact request-schema object and JSON projection", () => {
  const namespace = contracts as Record<string, unknown>;
  const expectedNames = new Set<string>();
  for (const action of ACTION_CATALOG) {
    const description = describeAction(action);
    for (const [index, name] of action.request.entries()) {
      const candidate = namespace[name];
      let expected: unknown = null;
      if (candidate instanceof z.ZodType) {
        expectedNames.add(name);
        expect(ACTION_REQUEST_SCHEMAS[name]).toBe(candidate);
        try {
          expected = z.toJSONSchema(candidate, { io: "input", unrepresentable: "any" });
        } catch {
          // Keep the existing unprojectable-schema null behavior.
        }
      }
      expect(JSON.stringify(description.input[index]!.schema)).toBe(JSON.stringify(expected));
    }
  }
  expect(Object.keys(ACTION_REQUEST_SCHEMAS).sort()).toEqual([...expectedNames].sort());
});
