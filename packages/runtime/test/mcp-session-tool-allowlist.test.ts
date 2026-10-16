import { expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { prepareAgentTools, prefixedMcpToolName } from "../src/index";

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
        allowedTools.length ? [prefixedMcpToolName("crm", "read")] : [],
      );
      await expect(server.callTool(prefixedMcpToolName("crm", "write"), {})).rejects.toThrow(
        "not allowed",
      );
      await expect(server.callTool(prefixedMcpToolName("crm", "admin"), {})).rejects.toThrow(
        "not allowed",
      );
      if (allowedTools.length) await server.callTool(prefixedMcpToolName("crm", "read"), {});
    } finally {
      await prepared.close();
    }
  }
  expect(called).toEqual(["read"]);
});
