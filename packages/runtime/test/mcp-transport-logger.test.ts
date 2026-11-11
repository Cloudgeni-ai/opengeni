import { expect, spyOn, test } from "bun:test";
import { createMcpTransportLogger } from "../src/mcp-transport-logger";

test("SDK teardown warnings remain distinct from connection failures without exposing diagnostics", () => {
  const warnings: unknown[][] = [];
  const warn = spyOn(console, "warn").mockImplementation((...args) => {
    warnings.push(args);
  });
  const logger = createMcpTransportLogger("test-server", (_error, code, serverId) => ({
    code,
    serverId,
  }));
  const secret = "secret-provider-diagnostic";
  try {
    logger.warn("Failed to terminate MCP session:", new Error(`HTTP 405 ${secret}`));
    logger.warn("Failed to close discarded MCP client:", new Error(secret));
    logger.error(`Error initializing MCP server: ${secret}`, new Error(secret));
    expect(warnings).toEqual([
      ["[mcp] cleanup operation failed", { code: "mcp_cleanup_failed", serverId: "test-server" }],
      ["[mcp] cleanup operation failed", { code: "mcp_cleanup_failed", serverId: "test-server" }],
      [
        "[mcp] transport operation failed",
        { code: "mcp_transport_failed", serverId: "test-server" },
      ],
    ]);
    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(logger.dontLogToolData).toBe(true);
  } finally {
    warn.mockRestore();
  }
});
