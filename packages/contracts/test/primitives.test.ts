import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as primitives from "../src/primitives";

const cases = [
  ["string", primitives.string, () => z.string()],
  ["boolean", primitives.boolean, () => z.boolean()],
  ["uuid", primitives.uuid, () => z.string().uuid()],
  ["nonnegativeInteger", primitives.nonnegativeInteger, () => z.number().int().nonnegative()],
  ["positiveInteger", primitives.positiveInteger, () => z.number().int().positive()],
  ["nullableString", primitives.nullableString, () => z.string().nullable()],
  ["nonEmptyString", primitives.nonEmptyString, () => z.string().min(1)],
  ["nullableUuid", primitives.nullableUuid, () => z.string().uuid().nullable()],
  ["optionalBoolean", primitives.optionalBoolean, () => z.boolean().optional()],
  ["optionalUuid", primitives.optionalUuid, () => z.string().uuid().optional()],
  ["dateTime", primitives.dateTime, () => z.string().datetime()],
] as const;

const values: unknown[] = [
  undefined,
  null,
  "",
  "hello",
  "é𝄞",
  "123e4567-e89b-42d3-a456-426614174000",
  "not-a-uuid",
  "2026-01-02T03:04:05.123Z",
  "2026-01-02T03:04:05+01:00",
  0,
  -0,
  -1,
  1,
  1.5,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  NaN,
  Infinity,
  -Infinity,
  true,
  false,
  [],
  {},
];

function result(schema: z.ZodType, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, issues: parsed.error.issues };
}

describe("shared contract primitives", () => {
  for (const [name, shared, create] of cases) {
    test(`${name} preserves validation, diagnostics and schema bytes`, () => {
      const previous = create();
      for (const value of values) expect(result(shared, value)).toEqual(result(previous, value));
      for (const io of ["input", "output"] as const) {
        for (const target of ["draft-7", "draft-2020-12", "openapi-3.0"] as const) {
          expect(JSON.stringify(z.toJSONSchema(shared, { io, target }))).toBe(
            JSON.stringify(z.toJSONSchema(previous, { io, target })),
          );
          // Reusing the same primitive twice must not introduce model-facing refs.
          const reused = z.object({ first: shared, second: shared });
          const distinct = z.object({ first: create(), second: create() });
          expect(JSON.stringify(z.toJSONSchema(reused, { io, target }))).toBe(
            JSON.stringify(z.toJSONSchema(distinct, { io, target })),
          );
          for (const value of values) {
            expect(result(reused, { first: value, second: value })).toEqual(
              result(distinct, { first: value, second: value }),
            );
          }
        }
      }
    });
  }

  test("field-specific builders and metadata leave the shared schema unchanged", () => {
    const before = JSON.stringify(z.toJSONSchema(primitives.string));
    const described = primitives.string.describe("Only this field");
    const bounded = primitives.string.min(3).max(6);
    const optional = primitives.string.optional();
    expect(described).not.toBe(primitives.string);
    expect(bounded).not.toBe(primitives.string);
    expect(optional).not.toBe(primitives.string);
    expect(described.description).toBe("Only this field");
    expect(primitives.string.description).toBeUndefined();
    expect(bounded.safeParse("a").success).toBe(false);
    expect(primitives.string.safeParse("a").success).toBe(true);
    expect(optional.safeParse(undefined).success).toBe(true);
    expect(primitives.string.safeParse(undefined).success).toBe(false);
    expect(JSON.stringify(z.toJSONSchema(primitives.string))).toBe(before);
  });
});
