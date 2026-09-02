import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { prepareAgentTools } from "../src";

describe("workspace tool gateway filtering", () => {
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
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "delete_item",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
