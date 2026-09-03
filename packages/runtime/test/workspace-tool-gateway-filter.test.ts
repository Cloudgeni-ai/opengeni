import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { prepareAgentTools } from "../src";

describe("workspace tool gateway filtering", () => {
  test("forwards local provider preflight into the current-human gateway", async () => {
    const events: string[] = [];
    const signal = new AbortController().signal;
    const server: MCPServer = {
      name: "inventory",
      cacheToolsList: true,
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "write_item",
            inputSchema: {
              type: "object",
              properties: { sku: { type: "string" } },
              required: ["sku"],
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        events.push("execute");
        return { content: [{ type: "text", text: "ok" }] };
      },
      async invalidateToolsCache() {},
    };
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "inventory",
            url: "https://inventory.example.test/mcp",
            cacheToolsList: true,
            requireApproval: ["write_item"],
            connectionRef: {
              providerDomain: "inventory.example.test",
              kind: "oauth2",
              subjectScope: "workspace",
            },
          },
        ],
      }),
      [{ kind: "mcp", id: "inventory" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        localMcpServers: [
          {
            id: "inventory",
            server,
            preflightCall: async (toolName, args, options) => {
              events.push(`preflight:${toolName}:${String(args.sku)}`);
              expect(options?.signal).toBe(signal);
            },
          },
        ],
        workspaceToolGateway: {
          requireApproval: (_entry, _caller, context) =>
            context.transportMeta?.approvalConfirmed !== true,
        },
      },
    );
    try {
      const gateway = prepared.toolGateway!;
      const catalog = prepared.toolGatewayCatalog!;
      const call = await gateway.prepareCall(
        {
          operationId: "33333333-3333-4333-8333-333333333333",
          catalogDigest: catalog.digest,
          identity: { serverId: "inventory", toolName: "write_item" },
          arguments: { sku: "SKU-1" },
          caller: { kind: "http", subjectId: "human:test" },
        },
        { signal, transportMeta: { approvalConfirmed: true } },
      );
      expect(events).toEqual(["preflight:write_item:SKU-1"]);
      await call.execute();
      expect(events).toEqual(["preflight:write_item:SKU-1", "execute"]);
    } finally {
      await prepared.close();
    }
  });

  test("intersects the live catalog with an exact frozen tool identity set", async () => {
    const server: MCPServer = {
      name: "inventory",
      cacheToolsList: true,
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "read_item",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "delete_item",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: "text", text: "ok" }] };
      },
      async invalidateToolsCache() {},
    };
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "inventory",
            url: "https://inventory.example.test/mcp",
            cacheToolsList: true,
          },
        ],
      }),
      [{ kind: "mcp", id: "inventory" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        localMcpServers: [{ id: "inventory", server }],
        workspaceToolGateway: {
          filterDefinition: (definition) =>
            definition.identity.serverId === "inventory" &&
            definition.identity.toolName === "read_item",
        },
      },
    );
    try {
      expect(prepared.toolGatewayCatalog?.entries.map((entry) => entry.identity)).toEqual([
        { serverId: "inventory", toolName: "read_item" },
      ]);
    } finally {
      await prepared.close();
    }
  });
});
