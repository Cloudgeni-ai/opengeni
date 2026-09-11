/** Exact endpoint identity: normalize URL syntax, preserve paths and query parameters. */
export function mcpEndpointIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export function pluginMcpUnavailableReason(server: { endpoint: string | null; transport?: string; requiresConfiguration?: boolean }): string | null {
  if (server.transport === "stdio" || !server.endpoint) return "Requires a local runtime";
  if (server.transport && !["http", "streamable-http", "streamable_http"].includes(server.transport)) return "Unsupported transport: " + server.transport;
  if (server.requiresConfiguration || server.endpoint.includes("{")) return "Requires custom connection configuration";
  const endpoint = mcpEndpointIdentity(server.endpoint);
  if (!endpoint?.startsWith("https://")) return "Requires a valid HTTPS endpoint";
  return null;
}
