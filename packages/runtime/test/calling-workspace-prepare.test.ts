import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  OPENGENI_CALLING_WORKSPACE_HEADER,
  verifyCallingWorkspaceProof,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";

import { prepareAgentTools } from "../src/index";

/* Through the real tool preparation: a workspace agent's remote MCP server on
   Opengeni's own host (however spelled) receives the signed calling workspace
   on every request, and Opengeni's built-in servers never do. */

const secret = "calling-workspace-prepare-delegation-secret";
const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

/** Opengeni's host: answers MCP and records the calling-workspace header per path. */
function opengeniHost() {
  const seen: Array<{ path: string; header: string | null }> = [];
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        header: request.headers.get(OPENGENI_CALLING_WORKSPACE_HEADER),
      });
      const server = new McpServer({ name: "opengeni-host", version: "1.0.0" });
      server.registerTool("echo", { inputSchema: {} }, async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transports.push(transport);
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  return {
    port: host.port,
    seen,
    async stop() {
      for (const transport of transports) await transport.close();
      host.stop(true);
    },
  };
}

for (const spelling of ["localhost", "localhost.", "LocalHost.."]) {
  test(`a remote MCP server on Opengeni's own host (${spelling}) names the calling workspace`, async () => {
    const host = opengeniHost();
    try {
      const settings = testSettings({
        sandboxBackend: "none",
        delegationSecret: secret,
        publicBaseUrl: `http://localhost:${host.port}`,
        opengeniMcpUrl: `http://127.0.0.1:${host.port}/v1/workspaces/{workspaceId}/mcp`,
        opengeniMcpInternalUrl: `http://127.0.0.1:${host.port}/v1/workspaces/{workspaceId}/mcp`,
        mcpServers: [
          {
            id: "remote-opengeni",
            url: `http://${spelling}:${host.port}/v1/mcp`,
            cacheToolsList: false,
          },
          {
            id: "opengeni",
            url: `http://127.0.0.1:${host.port}/v1/workspaces/{workspaceId}/mcp`,
            cacheToolsList: false,
          },
        ],
      });
      const prepared = await prepareAgentTools(
        settings,
        [
          { kind: "mcp", id: "remote-opengeni" },
          { kind: "mcp", id: "opengeni" },
        ],
        { ...scope, workspaceToolGateway: {} },
      );
      await prepared.close();
      const remote = host.seen.filter((each) => each.path === "/v1/mcp");
      const builtIn = host.seen.filter((each) => each.path !== "/v1/mcp");
      expect(remote.length).toBeGreaterThan(0);
      expect(builtIn.length).toBeGreaterThan(0);
      for (const each of remote) {
        expect(await verifyCallingWorkspaceProof(secret, each.header!)).toEqual(scope);
      }
      for (const each of builtIn) expect(each.header).toBeNull();
    } finally {
      await host.stop();
    }
  });
}

test("a remote MCP server on another host never sees it", async () => {
  const host = opengeniHost();
  try {
    const settings = testSettings({
      sandboxBackend: "none",
      delegationSecret: secret,
      publicBaseUrl: "https://opengeni.example",
      mcpServers: [
        { id: "elsewhere", url: `http://127.0.0.1:${host.port}/v1/mcp`, cacheToolsList: false },
      ],
    });
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "elsewhere" }], {
      ...scope,
      workspaceToolGateway: {},
    });
    await prepared.close();
    expect(host.seen.length).toBeGreaterThan(0);
    for (const each of host.seen) expect(each.header).toBeNull();
  } finally {
    await host.stop();
  }
});
