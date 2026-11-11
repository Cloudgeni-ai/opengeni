import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z4 from "zod/v4";
import { createApiMcpTransport } from "../src/mcp/transport";

/**
 * The MCP SDK refuses request bodies over 4 MiB by default. The API's own
 * request-body limit is larger and already applies to MCP routes, so a tool
 * call the API admits must reach the tool instead of failing with 413.
 */
describe("API MCP transport request body size", () => {
  test("a tool call larger than the SDK's 4 MiB default reaches the tool", async () => {
    const mcp = new McpServer({ name: "body-size-test", version: "1.0.0" });
    let receivedLength = 0;
    mcp.registerTool(
      "echo_length",
      { description: "returns the text length", inputSchema: { text: z4.string() } },
      async ({ text }) => {
        receivedLength = text.length;
        return { content: [{ type: "text", text: String(text.length) }] };
      },
    );
    const transport = createApiMcpTransport({ enableJsonResponse: true });
    await mcp.connect(transport);

    const text = "x".repeat(5 * 1024 * 1024);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo_length", arguments: { text } },
    });
    const response = await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(receivedLength).toBe(text.length);
    await mcp.close();
  });
});
