import { expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing/settings";
import { prepareAgentTools } from "../src/index";
import { mcpToolWireName } from "../src/mcp-model-tool-name";

test("session tool policy intersects connection tools for discovery and direct execution", async () => {
  const called: string[] = [];
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: [{ id: "crm", url: "https://example.test/mcp", allowedTools: ["read", "write"] }],
  });
  const local = {
    name: "crm",
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    listTools: async () =>
      ["read", "write", "admin"].map((name) => ({
        name,
        inputSchema: { type: "object", properties: {} },
      })),
    callTool: async (name: string) => {
      called.push(name);
      return [];
    },
  } as MCPServer;
  for (const allowedTools of [["read", "admin"], []]) {
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "crm", allowedTools }], {
      localMcpServers: [{ id: "crm", server: local }],
    });
    try {
      const server = prepared.mcpServers[0]!;
      expect((await server.listTools()).map((tool) => tool.name)).toEqual(
        allowedTools.length ? [mcpToolWireName("crm", "read")] : [],
      );
      await expect(server.callTool(mcpToolWireName("crm", "write"), {})).rejects.toThrow(
        "is not one of the tools",
      );
      await expect(server.callTool(mcpToolWireName("crm", "admin"), {})).rejects.toThrow(
        "is not one of the tools",
      );
      if (allowedTools.length) await server.callTool(mcpToolWireName("crm", "read"), {});
    } finally {
      await prepared.close();
    }
  }
  expect(called).toEqual(["read"]);
});
