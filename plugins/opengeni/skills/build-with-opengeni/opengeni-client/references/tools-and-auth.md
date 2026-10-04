# Tools and auth

Give the agent the product's data and actions through the product's own API,
not through prompts. Two ways:

| Need                                         | Use                                         | Credential                        |
| -------------------------------------------- | ------------------------------------------- | --------------------------------- |
| Chat tools that act as the signed-in user    | MCP endpoint plus the proxy's `toolServer` | per-user token, minted by the proxy |
| Workspace-wide tools, or background agents   | OpenAPI Integration, or a workspace MCP connection | one workspace Connection          |

## Per-user MCP tools

```ts
createSessionProxyHandler(og, {
  resolve,
  createSession,
  toolServer: {
    // url defaults to OPENGENI_TOOL_SERVER_URL: public HTTPS, a tunnel when local
    approvals: { ask: ["rename_post"] }, // every write tool; `true` for all tools
  },
});
```

The endpoint, with any MCP library (the official SDK needs zod 3.25 or later):

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ToolRequestError, verifyToolRequest } from "@opengeni/sdk/tool-auth";
import { z } from "zod";

export async function mcp(request: Request): Promise<Response> {
  let user: string;
  try {
    ({ user } = await verifyToolRequest(request));
  } catch (error) {
    if (error instanceof ToolRequestError) return error.toResponse(); // 401
    throw error;
  }
  const server = new McpServer({ name: "acme", version: "1.0.0" });
  server.registerTool(
    "search_posts",
    { description: "Search the user's posts", inputSchema: { query: z.string() } },
    async ({ query }) => ({
      content: [{ type: "text", text: JSON.stringify(await db.posts.search(user, query)) }],
    }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return await transport.handleRequest(request);
}
```

Mount it at the `OPENGENI_TOOL_SERVER_URL` path for every method (Next.js:
`export { mcp as GET, mcp as POST }`; Express: `toNodeMiddleware(mcp)`; Hono:
`toHonoHandler(mcp)`).

How it works: the proxy adds the endpoint to each chat it creates (tool names
appear to the model as `app__<tool>`; change the prefix with `toolServer.id`)
and refreshes the token on every message, approval, and answer. Tools act as
the user who started the chat, also in shared chats. The token is an HS256 JWT
signed with a key derived from `OPENGENI_API_KEY`, with `aud` set to the tool
URL, `sub` the user, and `tenant` and `workspace_id` claims.

Authorize every call:

- Scope every query to the verified `user` and `tenant`. Treat ids the model
  sends as lookup keys, and check they belong to that user.
- Re-check the user's current permissions before writes; the token proves who
  the user is, not what they may do now.
- Accept this token only on the tool endpoint, and never accept the product's
  login token there.

Tool endpoint in another language: run `await deriveToolTokenKey()` (from
`@opengeni/sdk/tool-auth`) once, store the hex key as its own secret, and verify
the JWT with any library: HS256, `iss` `"opengeni-session-proxy"`, `aud` the
exact tool URL, plus `exp`. Python:
`jwt.decode(token, bytes.fromhex(key), algorithms=["HS256"], issuer="opengeni-session-proxy", audience=url)`.

Your own tokens instead of `toolServer`: add the server in `createSession`
(`mcpServers: [{ id, url, headers: { Authorization: "Bearer …" } }]`, plus
`{ kind: "mcp", id }` in `tools` when you pass `tools`), and return
`{ mcpCredentialUpdates: [{ id, headers }] }` from `beforeForwardMessage` to
rotate it.

## OpenAPI Integrations

For an existing HTTP API, publish an OpenAPI 3.x document with only the
operations the agent may use, then install it once per workspace:

1. Store the API credential as a workspace Connection, saying where it goes:
   `credential: { headers: { Authorization: "Token …" } }`.
2. `og.client.previewApiIntegration(workspaceId, { source, connectionId })`
   compiles the operations into tools and classifies reads and writes.
3. `og.client.installApiIntegration(workspaceId, …)` with the same `source`,
   the preview's revision and digest (`expectedRevisionId`,
   `expectedContentSha256`), and the tool ids you allow (`allowedTools`, from
   `preview.tools[].id`). Writes ask for approval unless listed in
   `autoApprovedTools`; list them only for unattended runs.
4. Select the returned server id in sessions or schedules:
   `tools: [{ kind: "mcp", id: serverId }]`.

Every session in that workspace uses the same credential, so scope it to what
any member of the workspace may do. The API must be reachable from Opengeni
over public HTTPS.

## Credentials

Never put tokens in prompts, Skills, `modelContext`, tool URLs, browser code,
or logs. Opengeni stores Connection and MCP header secrets encrypted and keeps
them out of the model's context.
