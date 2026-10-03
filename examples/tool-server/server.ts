import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OpenGeniClient } from "@opengeni/sdk";
import { toNodeMiddleware } from "@opengeni/sdk/express";
import { createSessionProxyHandler } from "@opengeni/sdk/session-proxy";
import { ToolRequestError, verifyToolRequest } from "@opengeni/sdk/tool-auth";
import express from "express";
import { z } from "zod";

// The product's own data: each post belongs to one user.
const posts = [
  { id: "p1", owner: "ada", title: "Launch plan for Monday" },
  { id: "p2", owner: "ada", title: "Pricing page draft" },
  { id: "p3", owner: "grace", title: "Grace's private roadmap" },
];

// 1. Your MCP server, built with the official MCP SDK. Verify first, then scope
//    every tool to the verified user, never to an id the model supplied.
async function mcp(request: Request): Promise<Response> {
  let user: string;
  try {
    ({ user } = await verifyToolRequest(request));
    console.log(`MCP request verified for user ${user}`);
  } catch (error) {
    if (error instanceof ToolRequestError) return error.toResponse();
    throw error;
  }
  const server = new McpServer({ name: "posts", version: "1.0.0" });
  server.registerTool(
    "search_posts",
    {
      description: "Search the signed-in user's posts",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const mine = posts.filter(
        (post) => post.owner === user && post.title.toLowerCase().includes(query.toLowerCase()),
      );
      return { content: [{ type: "text", text: JSON.stringify(mine) }] };
    },
  );
  server.registerTool(
    "rename_post",
    {
      description: "Rename one of the signed-in user's posts",
      inputSchema: { id: z.string(), title: z.string() },
    },
    async ({ id, title }) => {
      const post = posts.find((candidate) => candidate.id === id && candidate.owner === user);
      if (!post)
        return {
          content: [{ type: "text", text: "Post not found." }],
          isError: true,
        };
      post.title = title;
      return { content: [{ type: "text", text: JSON.stringify(post) }] };
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return await transport.handleRequest(request);
}

// 2. The packaged session proxy, with the tool server attached per user.
const og = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});
const proxy = createSessionProxyHandler(og, {
  chats: "shared",
  // Demo auth: a real product reads its own session cookie here.
  resolve: (request) => {
    const user = request.headers.get("x-demo-user");
    if (!user) return new Response("Unauthorized", { status: 401 });
    return {
      workspaceId: process.env.OPENGENI_WORKSPACE_ID!,
      user,
      source: "tool-server-demo",
    };
  },
  createSession: ({ initialMessage, idempotencyKey }) => ({
    initialMessage,
    idempotencyKey,
    tools: [],
    firstPartyMcpTools: [],
    sandboxBackend: "none",
  }),
  toolServer: {
    url: `${process.env.PUBLIC_BASE_URL}/api/mcp`, // OpenGeni must reach it over HTTPS
    approvals: { ask: ["rename_post"] }, // writes wait for the user's approval
  },
});

const app = express();
app.all("/api/mcp", toNodeMiddleware(mcp));
app.use("/api/opengeni", toNodeMiddleware(proxy));
app.get("/api/posts", (_request, response) => {
  response.json(posts);
});
const port = Number(process.env.PORT ?? 4101);
app.listen(port, () => console.log(`tool-server demo on http://localhost:${port}`));
