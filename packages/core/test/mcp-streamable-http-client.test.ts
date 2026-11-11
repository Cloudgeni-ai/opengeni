import { afterEach, expect, test } from "bun:test";
import {
  connectMcpStreamableHttpClient,
  withMcpStreamableHttpClient,
} from "../src/domain/mcp-streamable-http-client";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const TOOLS = [{ name: "search", description: "Search.", inputSchema: { type: "object" } }];

/**
 * A hosted server that answers the 2026-07-28 `server/discover` probe but sends
 * every other result in the 2025 shape (no `resultType`), and also speaks the
 * plain 2025 `initialize` handshake.
 */
function startDiscoverAnsweringLegacyServer() {
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = (await request.json()) as { id?: unknown; method?: string };
      methods.push(body.method ?? "");
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
      switch (body.method) {
        case "server/discover":
          return reply({
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
            resultType: "complete",
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "hosted", version: "1" } },
          });
        case "initialize":
          return reply({
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "hosted", version: "1" },
          });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return reply({ tools: TOOLS });
        default:
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found" },
          });
      }
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/`, methods };
}

const connectInput = (url: string) => ({
  url,
  clientName: "test",
  clientVersion: "0.0.0",
  timeoutMs: 5_000,
});

test("a server that answers the probe with 2025-era results is unusable over the new era", async () => {
  const fixture = startDiscoverAnsweringLegacyServer();
  const client = await connectMcpStreamableHttpClient(connectInput(fixture.url));
  try {
    await expect(client.listTools()).rejects.toThrow();
  } finally {
    await client.close();
  }
});

test("withMcpStreamableHttpClient falls back to the 2025 handshake for such a server", async () => {
  const fixture = startDiscoverAnsweringLegacyServer();
  const listed = await withMcpStreamableHttpClient(connectInput(fixture.url), (client) =>
    client.listTools(),
  );
  expect(listed.tools.map((tool) => tool.name)).toEqual(["search"]);
  expect(fixture.methods).toEqual([
    "server/discover",
    "tools/list",
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
});

test("withMcpStreamableHttpClient does not retry unrelated failures", async () => {
  const fixture = startDiscoverAnsweringLegacyServer();
  let calls = 0;
  await expect(
    withMcpStreamableHttpClient(connectInput(fixture.url), async () => {
      calls += 1;
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(calls).toBe(1);
  expect(fixture.methods).toEqual(["server/discover"]);
});
