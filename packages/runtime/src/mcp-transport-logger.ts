const CLEANUP_MESSAGES = new Set([
  "Failed to terminate MCP session:",
  "Failed to close MCP client:",
  "Failed to close MCP transport:",
  ...[
    "failed MCP reconnect",
    "stale MCP",
    "discarded MCP",
    "replaced MCP",
    "reconnected MCP",
  ].flatMap((name) => [`Failed to close ${name} client:`, `Failed to terminate ${name} session:`]),
]);

/** SDK cleanup warnings do not imply failed connect, discovery, or tool calls.
 * Emit only fixed labels and the runtime's credential-safe error projection. */
export function createMcpTransportLogger(
  serverId: string,
  errorFields: (
    error: unknown,
    code: "mcp_cleanup_failed" | "mcp_transport_failed",
    serverId: string,
  ) => unknown,
) {
  const logFailure = (message: string, ...args: unknown[]) => {
    const cleanup = CLEANUP_MESSAGES.has(message);
    let error: unknown;
    for (let index = args.length - 1; index >= 0; index--) {
      if (args[index] instanceof Error) {
        error = args[index];
        break;
      }
    }
    console.warn(
      cleanup ? "[mcp] cleanup operation failed" : "[mcp] transport operation failed",
      errorFields(error, cleanup ? "mcp_cleanup_failed" : "mcp_transport_failed", serverId),
    );
  };
  return {
    namespace: "opengeni:mcp-transport",
    debug: () => undefined,
    error: logFailure,
    warn: logFailure,
    dontLogModelData: true,
    dontLogToolData: true,
  };
}
