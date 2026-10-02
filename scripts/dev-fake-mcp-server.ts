#!/usr/bin/env bun
/**
 * A local fake MCP server for UI design previews ("Acme Tickets" and the other
 * connectors seeded by scripts/dev-seed-agent-config.ts). Loopback only; runs
 * until stopped.
 *
 *   bun scripts/dev-fake-mcp-server.ts [--port 8791]
 */
import { startTestMcpServer } from "../packages/testing/src/mcp";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : 8791);
if (!Number.isInteger(port) || port <= 0) {
  console.error("dev-fake-mcp-server: --port must be a positive integer");
  process.exit(1);
}
const server = startTestMcpServer({ port });
console.log(`Fake MCP server listening at ${server.url}`);
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
await new Promise(() => {});
