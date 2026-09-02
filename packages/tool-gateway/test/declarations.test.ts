import { expect, test } from "bun:test";
import { createWorkspaceToolGateway, generateToolGatewayDeclarations } from "../src";

test("generates digest-pinned SDK declarations from the workspace catalog", () => {
  const catalog = createWorkspaceToolGateway({
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    generation: 1,
    definitions: [
      {
        identity: { serverId: "inventory", toolName: "lookup" },
        modelName: "inventory__lookup",
        codemodePath: ["inventory", "lookup"],
        inputSchema: {
          type: "object",
          properties: { sku: { type: "string" } },
          required: ["sku"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
          additionalProperties: false,
        },
        source: "mcp",
        approval: "none",
        execute: async () => ({ content: [] }),
      },
    ],
  }).catalog;
  const source = generateToolGatewayDeclarations(catalog);
  expect(source).toContain(`// Tool catalog digest: ${catalog.digest}`);
  expect(source).toContain('declare module "@opengeni/sdk"');
  expect(source).toContain("interface OpenGeniGeneratedTools");
  expect(source).toContain("readonly inventory:");
  expect(source).toContain("readonly sku: string");
  expect(source).toContain("Promise<{ readonly count: number }>");
});
