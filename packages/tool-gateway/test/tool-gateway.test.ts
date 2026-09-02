import { describe, expect, test } from "bun:test";
import {
  ToolGatewayApprovalRequiredError,
  ToolGatewayCatalogIntegrityError,
  ToolGatewayInputValidationError,
  createWorkspaceToolGateway,
  parseVerifiedToolGatewayCatalog,
  type ToolGatewayDefinition,
} from "../src";

const definition: ToolGatewayDefinition = {
  identity: { serverId: "docs", toolName: "search" },
  modelName: "docs__search",
  description: "Search docs",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  source: "docs",
  approval: "none",
  execute: async (argumentsValue, context) => ({
    content: [{ type: "text", text: `${context.caller.kind}:${String(argumentsValue.query)}` }],
    structuredContent: { ok: true },
  }),
};

describe("ToolGateway", () => {
  test("executes HTTP, MCP, browser, model, and Codemode callers through one core", async () => {
    const { catalog, gateway } = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      definitions: [definition],
    });
    for (const kind of ["http", "mcp", "browser", "codemode"] as const) {
      const result = await gateway.call({
        operationId: crypto.randomUUID(),
        catalogDigest: catalog.digest,
        identity: definition.identity,
        arguments: { query: kind },
        caller: { kind, subjectId: "human:test" },
      });
      expect(result.content[0]).toEqual({ type: "text", text: `${kind}:${kind}` });
    }
    const model = await gateway.callModel({
      modelName: definition.modelName,
      arguments: { query: "model" },
      subjectId: "agent:test",
    });
    expect(model.content[0]).toEqual({ type: "text", text: "model:model" });
  });

  test("validates arguments and supports adapter-owned approval decisions", async () => {
    const { catalog, gateway } = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      definitions: [{ ...definition, approval: "human" }],
      requireApproval: (entry, caller, context) =>
        entry.approval === "human" &&
        caller.kind !== "model" &&
        context.transportMeta?.approvalConfirmed !== true,
    });
    await expect(
      gateway.call({
        operationId: crypto.randomUUID(),
        catalogDigest: catalog.digest,
        identity: definition.identity,
        arguments: { query: 1 },
        caller: { kind: "model", subjectId: "agent:test" },
      }),
    ).rejects.toBeInstanceOf(ToolGatewayInputValidationError);
    await expect(
      gateway.call({
        operationId: crypto.randomUUID(),
        catalogDigest: catalog.digest,
        identity: definition.identity,
        arguments: { query: "blocked" },
        caller: { kind: "browser", subjectId: "human:test" },
      }),
    ).rejects.toBeInstanceOf(ToolGatewayApprovalRequiredError);
    await expect(
      gateway.call(
        {
          operationId: crypto.randomUUID(),
          catalogDigest: catalog.digest,
          identity: definition.identity,
          arguments: { query: "approved" },
          caller: { kind: "browser", subjectId: "human:test" },
        },
        { transportMeta: { approvalConfirmed: true } },
      ),
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
  });

  test("verifies catalog integrity independently of creation time", () => {
    const first = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      definitions: [definition],
    }).catalog;
    const later = createWorkspaceToolGateway({
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      generation: 1,
      createdAt: new Date("2026-09-02T01:00:00.000Z"),
      definitions: [definition],
    }).catalog;
    expect(first.digest).toBe(later.digest);
    expect(() =>
      parseVerifiedToolGatewayCatalog({
        ...first,
        entries: [{ ...first.entries[0], description: "tampered" }],
      }),
    ).toThrow(ToolGatewayCatalogIntegrityError);
  });
});
