import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { testSettings } from "@opengeni/testing";
import { prepareAgentTools } from "../src/index";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

/**
 * A real streamable HTTP MCP server whose session setup (initialize and
 * tools/list) answers slowly, like a deployment API that is restarting or
 * busy. Its one tool answers after `callDelayMs`.
 */
function slowProvider(input: { setupDelayMs: number; callDelayMs: number }) {
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (request.method === "POST" ? await request.clone().json() : {}) as {
        method?: string;
      };
      if (body.method === "initialize" || body.method === "tools/list") {
        await Bun.sleep(input.setupDelayMs);
      }
      const server = new McpServer({ name: "slow-setup", version: "1.0.0" });
      server.registerTool("echo", { inputSchema: {} }, async () => {
        await Bun.sleep(input.callDelayMs);
        return { content: [{ type: "text" as const, text: "ok" }] };
      });
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
    url: `http://127.0.0.1:${provider.port}/mcp`,
    async stop() {
      for (const transport of transports) await transport.close();
      provider.stop(true);
    },
  };
}

async function prepareSlow(input: { url: string; timeoutMs: number; setupTimeoutMs?: number }) {
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: [
      {
        id: "slow",
        url: input.url,
        cacheToolsList: false,
        timeoutMs: input.timeoutMs,
        ...(input.setupTimeoutMs ? { setupTimeoutMs: input.setupTimeoutMs } : {}),
      },
    ],
  });
  return await prepareAgentTools(settings, [{ kind: "mcp", id: "slow" }], {
    ...scope,
    workspaceToolGateway: {},
  });
}

test("a slow server setup fails at its call timeout without a setup timeout", async () => {
  const provider = slowProvider({ setupDelayMs: 1_500, callDelayMs: 0 });
  try {
    // The same error a busy deployment API produced for every turn start.
    await expect(prepareSlow({ url: provider.url, timeoutMs: 1_000 })).rejects.toThrow(
      /Request timed out/,
    );
  } finally {
    await provider.stop();
  }
});

test("setupTimeoutMs lets a slow server finish setup while tool calls keep their own timeout", async () => {
  const provider = slowProvider({ setupDelayMs: 1_500, callDelayMs: 1_500 });
  try {
    const prepared = await prepareSlow({
      url: provider.url,
      timeoutMs: 1_000,
      setupTimeoutMs: 3_000,
    });
    try {
      expect(prepared.toolGatewayCatalog?.entries.map((entry) => entry.identity)).toEqual([
        { serverId: "slow", toolName: "echo" },
      ]);
      // The longer setup bound never stretches tool calls: a call slower than
      // `timeoutMs` still times out.
      const [server] = prepared.mcpServers;
      await expect(server!.callTool("slow__echo", {})).rejects.toThrow(/timed out/i);
    } finally {
      await prepared.close();
    }
  } finally {
    await provider.stop();
  }
});
