import { describe, expect, test } from "bun:test";
import {
  createAttemptToolEnvironment,
  generateCodemodeDeclarations,
  jsonSchemaToTypeScript,
  type AttemptToolDefinition,
} from "../src";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

function definition(
  toolName: string,
  overrides: Partial<AttemptToolDefinition> = {},
): AttemptToolDefinition {
  return {
    identity: { serverId: "docs", toolName },
    modelName: `docs__${toolName}`,
    description: `Run ${toolName}`,
    inputSchema: { type: "object", additionalProperties: false },
    source: "docs",
    approval: "none",
    execute: async () => ({ content: [] }),
    ...overrides,
  };
}

describe("Codemode declarations", () => {
  test("pins one exact catalog and types structured and unstructured results honestly", () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      createdAt: new Date("2026-08-10T12:00:00.000Z"),
      definitions: [
        definition("search", {
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "integer" },
            },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              hits: { type: "array", items: { type: "string" } },
            },
            required: ["hits"],
            additionalProperties: false,
          },
        }),
        definition("refresh"),
      ],
    }).catalog;

    const declaration = generateCodemodeDeclarations(catalog);
    expect(declaration).toContain(`Attempt catalog digest: ${catalog.digest}`);
    expect(declaration).toContain("interface CodemodeGeneratedTools");
    expect(declaration).toContain(
      "argumentsValue: { readonly limit?: number; readonly query: string }",
    );
    expect(declaration).toContain("Promise<{ readonly hits: readonly (string)[] }>;");
    expect(declaration).toContain("argumentsValue?: Record<string, never>");
    expect(declaration).toContain("Promise<CodemodeToolResult>;");
  });

  test("resolves local definitions and preserves unsupported schemas as unknown", () => {
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

  test("rejects a namespace/tool prefix collision instead of emitting invalid declarations", () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        definition("one", { codemodePath: ["docs", "search"] }),
        definition("two", { codemodePath: ["docs", "search", "advanced"] }),
      ],
    }).catalog;
    expect(() => generateCodemodeDeclarations(catalog)).toThrow("extends a tool leaf");
  });
});
