import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import { HTTPException } from "hono/http-exception";
import {
  buildWorkspaceToolGatewayMcpServer,
  callWorkspaceToolGateway,
  requireWorkspaceToolGatewayGrant,
  workspaceToolGatewayDeclarations,
  type PreparedWorkspaceToolGateway,
} from "../src/workspace-tool-gateway";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "user:workspace-tool-gateway-test";

function grant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["workspace:read"],
    principalKind: "human_session",
    ...overrides,
  };
}

function preparedGateway(
  calls: Array<{ kind: string; argumentsValue: Record<string, unknown> }>,
): PreparedWorkspaceToolGateway {
  const { catalog, gateway } = createWorkspaceToolGateway({
    accountId,
    workspaceId,
    generation: 1,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    definitions: [
      {
        identity: { serverId: "inventory", toolName: "lookup" },
        modelName: "inventory__lookup",
        codemodePath: ["inventory", "lookup"],
        title: "Inventory lookup",
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
        approval: "human",
        execute: async (argumentsValue, context) => {
          calls.push({ kind: context.caller.kind, argumentsValue });
          return {
            content: [{ type: "text", text: JSON.stringify({ count: 7 }) }],
            structuredContent: { count: 7 },
          };
        },
      },
    ],
  });
  return {
    toolGateway: gateway,
    toolGatewayCatalog: catalog,
    close: async () => undefined,
  };
}

describe("workspace tool gateway adapters", () => {
  test("publishes and executes the exact same catalog through MCP and HTTP", async () => {
    const calls: Array<{ kind: string; argumentsValue: Record<string, unknown> }> = [];
    const prepared = preparedGateway(calls);
    const access = grant();
    const server = buildWorkspaceToolGatewayMcpServer(prepared, access);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "workspace-tool-gateway-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(1);
      expect(listed.tools[0]).toMatchObject({
        name: "inventory__lookup",
        title: "Inventory lookup",
        _meta: {
          "opengeni/identity": { serverId: "inventory", toolName: "lookup" },
          "opengeni/path": ["inventory", "lookup"],
          "opengeni/approval": "human",
          "opengeni/catalogDigest": prepared.toolGatewayCatalog.digest,
        },
      });
      expect(
        await client.callTool({ name: "inventory__lookup", arguments: { sku: "SKU-1" } }),
      ).toMatchObject({ structuredContent: { count: 7 } });

      const response = await callWorkspaceToolGateway(prepared, access, {
        operationId: "33333333-3333-4333-8333-333333333333",
        catalogDigest: prepared.toolGatewayCatalog.digest,
        identity: { serverId: "inventory", toolName: "lookup" },
        arguments: { sku: "SKU-2" },
      });
      expect(response.result).toMatchObject({ structuredContent: { count: 7 } });
      expect(calls).toEqual([
        { kind: "mcp", argumentsValue: { sku: "SKU-1" } },
        { kind: "http", argumentsValue: { sku: "SKU-2" } },
      ]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  test("keeps stale catalogs, unknown identities, and invalid arguments distinct", async () => {
    const prepared = preparedGateway([]);
    const access = grant();
    const base = {
      catalogDigest: prepared.toolGatewayCatalog.digest,
      identity: { serverId: "inventory", toolName: "lookup" },
      arguments: { sku: "SKU-1" },
    };
    await expect(
      callWorkspaceToolGateway(prepared, access, {
        ...base,
        catalogDigest: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      callWorkspaceToolGateway(prepared, access, {
        ...base,
        identity: { serverId: "inventory", toolName: "missing" },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      callWorkspaceToolGateway(prepared, access, { ...base, arguments: {} }),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("generates SDK declarations from the catalog exposed by the route adapter", () => {
    const prepared = preparedGateway([]);
    const declarations = workspaceToolGatewayDeclarations(prepared);
    expect(declarations.catalogDigest).toBe(prepared.toolGatewayCatalog.digest);
    expect(declarations.moduleSpecifier).toBe("@opengeni/sdk");
    expect(declarations.source).toContain("interface OpenGeniGeneratedTools");
    expect(declarations.source).toContain("readonly inventory:");
    expect(declarations.source).toContain("readonly sku: string");
  });

  test("rejects attempt-scoped and service grants from the human gateway", () => {
    expect(() =>
      requireWorkspaceToolGatewayGrant(
        grant({
          principalKind: "agent_attempt",
          metadata: { sessionId: "44444444-4444-4444-8444-444444444444" },
        }),
      ),
    ).toThrow(HTTPException);
    expect(() => requireWorkspaceToolGatewayGrant(grant({ principalKind: "service" }))).toThrow(
      HTTPException,
    );
    expect(() => requireWorkspaceToolGatewayGrant(grant())).not.toThrow();
  });
});
