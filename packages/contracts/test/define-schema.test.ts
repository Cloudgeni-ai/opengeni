import { expect, test } from "bun:test";
import { z } from "zod";
import { defineSchema } from "../src/define-schema";

test("schema factories remain eager and preserve the exact schema identity", () => {
  const schema = z.object({ name: z.string().min(1) }).strict();
  let calls = 0;
  const result = defineSchema(() => {
    calls += 1;
    return schema;
  });
  expect(calls).toBe(1);
  expect(result).toBe(schema);
  expect(result.parse({ name: "test" })).toEqual({ name: "test" });
  expect(result.safeParse({ name: "" }).success).toBe(false);
  expect(calls).toBe(1);
});

test("schema factory errors still occur during initialization", () => {
  const error = new Error("invalid schema definition");
  expect(() =>
    defineSchema(() => {
      throw error;
    }),
  ).toThrow(error);
});
