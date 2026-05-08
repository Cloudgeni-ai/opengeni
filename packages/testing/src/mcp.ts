import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";

export type TestMcpToolCall = {
  tool: string;
  args: Record<string, unknown>;
};

export type TestMcpServer = {
  url: string;
  calls: TestMcpToolCall[];
  close: () => void;
};

export function startTestMcpServer(): TestMcpServer {
  const calls: TestMcpToolCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/mcp") {
        return new Response("not found", { status: 404 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      const mcp = buildServer(calls);
      await mcp.connect(transport);
      return await transport.handleRequest(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    calls,
    close: () => server.stop(true),
  };
}

function buildServer(calls: TestMcpToolCall[]): McpServer {
  const server = new McpServer({
    name: "test-document-search",
    version: "1.0.0",
  });
  server.registerTool("search_documents", {
    description: "Search indexed documents.",
    inputSchema: {
      query: z.string(),
    },
  }, async ({ query }) => {
    calls.push({ tool: "search_documents", args: { query } });
    return {
      content: [{ type: "text", text: `found document for ${query}` }],
    };
  });
  server.registerTool("fetch_document", {
    description: "Fetch one indexed document.",
    inputSchema: {
      id: z.string(),
    },
  }, async ({ id }) => {
    calls.push({ tool: "fetch_document", args: { id } });
    return {
      content: [{ type: "text", text: `document ${id}` }],
    };
  });
  return server;
}
