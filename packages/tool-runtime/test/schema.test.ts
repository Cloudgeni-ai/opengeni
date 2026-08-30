import { describe, expect, test } from "bun:test";
import {
  CanonicalToolInputValidationError,
  CanonicalToolOutputValidationError,
  assertCanonicalToolInput,
  assertCanonicalToolOutput,
  compileCanonicalToolSchemaValidators,
  jsonSchemaToTypeScript,
} from "../src";

describe("canonical tool schema mechanics", () => {
  test("validates draft-2020 input and output without coercion", () => {
    const validators = compileCanonicalToolSchemaValidators({
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    });
    expect(() => assertCanonicalToolInput(validators.input, { count: 2 })).not.toThrow();
    expect(() => assertCanonicalToolInput(validators.input, { count: "2" })).toThrow(
      CanonicalToolInputValidationError,
    );
    expect(validators.output).not.toBeNull();
    expect(() => assertCanonicalToolOutput(validators.output!, { ok: true })).not.toThrow();
    expect(() => assertCanonicalToolOutput(validators.output!, { ok: "yes" })).toThrow(
      CanonicalToolOutputValidationError,
    );
  });

  test("projects supported JSON Schema honestly and leaves unsupported shapes unknown", () => {
    expect(
      jsonSchemaToTypeScript({
        $defs: { state: { enum: ["open", "closed"] } },
        type: "object",
        properties: {
          state: { $ref: "#/$defs/state" },
          opaque: { not: { type: "string" } },
        },
        required: ["state"],
        additionalProperties: false,
      }),
    ).toBe('{ readonly opaque?: unknown; readonly state: "open" | "closed" }');
    expect(jsonSchemaToTypeScript({ type: ["string", "null"] })).toBe("string | null");
    expect(jsonSchemaToTypeScript({ const: { ok: true } })).toBe("{ readonly ok: true }");
  });
});
