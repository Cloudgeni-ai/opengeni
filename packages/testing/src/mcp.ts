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

export function startTestMcpServer(
  options: {
    requiredAuthorization?: string;
    requiredHeaders?: Record<string, string>;
    // Permission-scoped tool registration: returns the extra tool names that the
    // calling request's bearer token is authorized to see, in addition to the
    // always-present base tools. Mirrors the production first-party MCP server,
    // whose tools/list response varies by the delegated token's grant.
    toolsForAuthorization?: (authorization: string | null) => string[];
    forbiddenTools?: string[];
    unauthorizedAuthenticateHeader?: string;
    forbiddenAuthenticateHeader?: string;
    // JSON-RPC methods that get a 401 even when auth headers are satisfied. Lets a
    // test connect successfully (its `initialize` handshake passes) and then fail
    // a later request such as `tools/list`, reproducing a credential that is valid
    // at connect but rejected at run time.
    unauthorizedForMethods?: string[];
    // JSON-RPC methods that get a generic 500. Lets a test connect successfully
    // and then fail a later request with a NON-auth error, modeling an optional
    // integration that is simply down (provider 5xx) rather than unauthenticated.
    serverErrorForMethods?: string[];
    // Per-request Authorization validator. Called for EVERY request with the raw
    // `authorization` header; returning false → 401. Unlike requiredHeaders (a
    // static string match) this can decode/verify a token — e.g. reject an
    // expired signed bearer — so a test can prove a token that is valid at
    // connect is rejected once the clock advances past its TTL.
    validateAuthorization?: (authorization: string | null) => boolean | Promise<boolean>;
    beforeToolResult?: (call: TestMcpToolCall) => Promise<void>;
  } = {},
): TestMcpServer {
  const calls: TestMcpToolCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/mcp") {
        return new Response("not found", { status: 404 });
      }
      if (
        options.requiredAuthorization &&
        request.headers.get("authorization") !== options.requiredAuthorization
      ) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            ...(options.unauthorizedAuthenticateHeader
              ? { "www-authenticate": options.unauthorizedAuthenticateHeader }
              : {}),
          },
        });
      }
      for (const [name, expected] of Object.entries(options.requiredHeaders ?? {})) {
        if (request.headers.get(name) !== expected) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: {
              "content-type": "application/json",
              ...(options.unauthorizedAuthenticateHeader
                ? { "www-authenticate": options.unauthorizedAuthenticateHeader }
                : {}),
            },
          });
        }
      }
      if (
        options.validateAuthorization &&
        !(await options.validateAuthorization(request.headers.get("authorization")))
      ) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            ...(options.unauthorizedAuthenticateHeader
              ? { "www-authenticate": options.unauthorizedAuthenticateHeader }
              : {}),
          },
        });
      }
      if (await matchesJsonRpcMethod(request, options.unauthorizedForMethods ?? [])) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            ...(options.unauthorizedAuthenticateHeader
              ? { "www-authenticate": options.unauthorizedAuthenticateHeader }
              : {}),
          },
        });
      }
      if (await matchesJsonRpcMethod(request, options.serverErrorForMethods ?? [])) {
        return new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      const forbiddenTool = await forbiddenToolName(request, options.forbiddenTools ?? []);
      if (forbiddenTool) {
        return new Response(JSON.stringify({ error: "insufficient_scope", tool: forbiddenTool }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            ...(options.forbiddenAuthenticateHeader
              ? { "www-authenticate": options.forbiddenAuthenticateHeader }
              : {}),
          },
        });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      const scopedTools = options.toolsForAuthorization
        ? options.toolsForAuthorization(request.headers.get("authorization"))
        : undefined;
      const mcp = buildServer(calls, scopedTools, options.beforeToolResult);
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

async function matchesJsonRpcMethod(request: Request, methods: string[]): Promise<boolean> {
  if (methods.length === 0 || request.method !== "POST") {
    return false;
  }
  try {
    const body = (await request.clone().json()) as { method?: unknown };
    return typeof body.method === "string" && methods.includes(body.method);
  } catch {
    return false;
  }
}

async function forbiddenToolName(
  request: Request,
  forbiddenTools: string[],
): Promise<string | null> {
  if (forbiddenTools.length === 0 || request.method !== "POST") {
    return null;
  }
  try {
    const body = (await request.clone().json()) as {
      method?: unknown;
      params?: { name?: unknown };
    };
    const name =
      body.method === "tools/call" && typeof body.params?.name === "string"
        ? body.params.name
        : null;
    return name && forbiddenTools.includes(name) ? name : null;
  } catch {
    return null;
  }
}

function buildServer(
  calls: TestMcpToolCall[],
  scopedTools?: string[],
  beforeToolResult?: (call: TestMcpToolCall) => Promise<void>,
): McpServer {
  const server = new McpServer({
    name: "test-document-search",
    version: "1.0.0",
  });
  server.registerTool(
    "search_documents",
    {
      description: "Search indexed documents.",
      inputSchema: {
        query: z.string(),
      },
    },
    async ({ query }) => {
      const call = { tool: "search_documents", args: { query } };
      calls.push(call);
      await beforeToolResult?.(call);
      return {
        content: [{ type: "text", text: `found document for ${query}` }],
      };
    },
  );
  server.registerTool(
    "fetch_document",
    {
      description: "Fetch one indexed document.",
      inputSchema: {
        id: z.string(),
      },
    },
    async ({ id }) => {
      const call = { tool: "fetch_document", args: { id } };
      calls.push(call);
      await beforeToolResult?.(call);
      return {
        content: [{ type: "text", text: `document ${id}` }],
      };
    },
  );
  // Permission-scoped tools, registered only when the caller's grant includes
  // them. The base tools above are always present, mirroring tools that every
  // grant can see.
  for (const toolName of scopedTools ?? []) {
    server.registerTool(
      toolName,
      {
        description: `Scoped tool ${toolName}.`,
        inputSchema: {},
      },
      async () => {
        const call = { tool: toolName, args: {} };
        calls.push(call);
        await beforeToolResult?.(call);
        return {
          content: [{ type: "text", text: `ran ${toolName}` }],
        };
      },
    );
  }
  return server;
}
