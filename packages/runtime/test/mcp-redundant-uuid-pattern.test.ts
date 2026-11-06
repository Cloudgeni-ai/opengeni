import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import * as z4 from "zod/v4";
import { PrefixedMcpServer } from "../src/index";
import { withoutRedundantUuidPatterns } from "../src/mcp-listed-tools";

/** What Zod (and so the MCP SDK) emits for a field nested in a tool's schema. */
function nested(schema: z4.ZodType): Record<string, unknown> {
  const { $schema: _rootDialect, ...rest } = z4.toJSONSchema(schema, {
    target: "draft-7",
  }) as Record<string, unknown>;
  return rest;
}

/** Any 8-4-4-4-12 hex UUID: the pattern says what the format says. */
const UUID = nested(z4.guid());
/** RFC version and variant digits: the pattern is stricter than the format. */
const RFC_UUID = nested(z4.string().uuid());

const SCHEMA = {
  type: "object",
  properties: {
    idempotencyKey: UUID,
    ids: { type: "array", items: UUID },
    either: { anyOf: [UUID, { type: "null" }] },
    sessionId: RFC_UUID,
    code: { type: "string", pattern: "^[A-Z]{3}$" },
    pattern: { type: "string", description: "A field named pattern stays." },
  },
  required: ["idempotencyKey"],
};

function server(schema: unknown): MCPServer {
  return {
    name: "stub",
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async listTools() {
      return [{ name: "tool_with_ids", description: "Has ids.", inputSchema: schema }];
    },
    async callTool() {
      return [];
    },
    async invalidateToolsCache() {},
  } as unknown as MCPServer;
}

function prefixed(firstPartyCatalog: boolean): PrefixedMcpServer {
  return new PrefixedMcpServer(
    server(SCHEMA),
    "opengeni",
    undefined,
    false,
    undefined,
    "opengeni",
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    firstPartyCatalog,
  );
}

describe("redundant UUID patterns", () => {
  test("Zod emits format and a pattern for every UUID; the RFC pattern is stricter", () => {
    expect(UUID.format).toBe("uuid");
    expect(typeof UUID.pattern).toBe("string");
    expect(RFC_UUID.format).toBe("uuid");
    expect(RFC_UUID.pattern).not.toBe(UUID.pattern);
  });

  test("only a pattern that repeats format: uuid is dropped, at any depth", () => {
    const trimmed = withoutRedundantUuidPatterns(SCHEMA);
    expect(trimmed).toEqual({
      type: "object",
      properties: {
        idempotencyKey: { type: "string", format: "uuid" },
        ids: { type: "array", items: { type: "string", format: "uuid" } },
        either: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
        sessionId: RFC_UUID,
        code: { type: "string", pattern: "^[A-Z]{3}$" },
        pattern: { type: "string", description: "A field named pattern stays." },
      },
      required: ["idempotencyKey"],
    });
    // The input is not modified.
    expect((SCHEMA.properties.idempotencyKey as Record<string, unknown>).pattern).toBe(
      UUID.pattern,
    );
  });

  test("a first-party server's tools lose the repeated pattern; other servers keep theirs", async () => {
    const [firstParty] = await prefixed(true).listTools();
    const [external] = await prefixed(false).listTools();
    expect(firstParty!.inputSchema).toEqual(withoutRedundantUuidPatterns(SCHEMA) as never);
    expect(external!.inputSchema).toEqual(SCHEMA as never);
  });
});
