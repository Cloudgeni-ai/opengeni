import { expect, test } from "bun:test";
import {
  compareCanonicalStrings,
  createWorkspaceToolGateway,
  digestCanonicalJson,
  generateToolGatewayDeclarations,
} from "../src";

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

test("uses locale-independent canonical ordering for digests and declarations", () => {
  expect(["ä", "z", "A"].sort(compareCanonicalStrings)).toEqual(["A", "z", "ä"]);

  const value = { ä: 1, z: 2, A: 3 };
  const expected = digestCanonicalJson({ A: 3, z: 2, ä: 1 });
  expect(digestCanonicalJson(value)).toBe(expected);

  const source = generateToolGatewayDeclarations(
    createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      definitions: [
        {
          identity: { serverId: "unicode", toolName: "inspect" },
          modelName: "unicode__inspect",
          codemodePath: ["unicode", "inspect"],
          inputSchema: {
            type: "object",
            properties: { ä: { type: "number" }, z: { type: "number" }, A: { type: "number" } },
            additionalProperties: false,
          },
          source: "mcp",
          approval: "none",
          execute: async () => ({ content: [] }),
        },
      ],
    }).catalog,
  );
  expect(source.indexOf("readonly A?")).toBeLessThan(source.indexOf("readonly z?"));
  expect(source.indexOf("readonly z?")).toBeLessThan(source.indexOf('readonly "ä"?'));
});
