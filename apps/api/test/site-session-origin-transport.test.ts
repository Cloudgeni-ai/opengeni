import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  sessionCreationMetadata,
  withSiteSessionOrigin,
} from "../../../packages/core/src/site-session-origin";

test("Site origin survives the local MCP transport used by first-party gateway tools", async () => {
  const server = new McpServer({ name: "origin-test", version: "1" });
  server.registerTool("create", { inputSchema: {} }, async () => {
    await Promise.resolve();
    return { content: [{ type: "text", text: JSON.stringify(sessionCreationMetadata({})) }] };
  });
  const client = new Client({ name: "origin-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const origins = [
      { siteId: "one", title: "One" },
      { siteId: "two", title: "Two" },
    ];
    const results = await Promise.all(
      origins.map((origin) =>
        withSiteSessionOrigin(origin, () => client.callTool({ name: "create", arguments: {} })),
      ),
    );
    for (const [index, result] of results.entries()) {
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ _opengeniSiteOrigin: origins[index] }) },
      ]);
    }
    expect((await client.callTool({ name: "create", arguments: {} })).content).toEqual([
      { type: "text", text: "{}" },
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
