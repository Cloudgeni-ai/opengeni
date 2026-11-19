/** Exact endpoint identity: normalize URL syntax, preserve paths and query parameters. */
export function mcpEndpointIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * MCP hosts this deployment cannot start a new connection to: a catalog
 * connection on that host needs an operator-registered OAuth client that is
 * missing here (`runtime.operatorOAuthClient.configured === false`). Another
 * server on the same host, such as one a plugin bundles, signs in with the
 * same provider and cannot connect either.
 */
export function mcpHostsDeploymentCannotConnect(
  items: readonly {
    kind: string;
    mcpUrl?: string | null | undefined;
    endpointUrl?: string | null | undefined;
    runtime?: { operatorOAuthClient?: { configured: boolean } | undefined } | undefined;
  }[],
): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const item of items) {
    if (item.kind !== "mcp" || item.runtime?.operatorOAuthClient?.configured !== false) continue;
    const endpoint = mcpEndpointIdentity(item.mcpUrl ?? item.endpointUrl);
    if (endpoint) hosts.add(new URL(endpoint).host);
  }
  return hosts;
}

export function pluginMcpUnavailableReason(
  server: {
    endpoint: string | null;
    transport?: string;
    requiresConfiguration?: boolean;
  },
  deployment?: { cannotConnectHosts?: ReadonlySet<string> | undefined },
): string | null {
  if (server.transport === "stdio" || !server.endpoint) return "Requires a local runtime";
  if (
    server.transport &&
    !["http", "streamable-http", "streamable_http"].includes(server.transport)
  )
    return "Unsupported transport: " + server.transport;
  if (server.requiresConfiguration || server.endpoint.includes("{"))
    return "Requires custom connection configuration";
  const endpoint = mcpEndpointIdentity(server.endpoint);
  if (!endpoint?.startsWith("https://")) return "Requires a valid HTTPS endpoint";
  if (deployment?.cannotConnectHosts?.has(new URL(endpoint).host))
    return "The provider only accepts apps it has approved";
  return null;
}
