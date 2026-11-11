import type { MCPServerStreamableHttp } from "@openai/agents";

type MCPServerStreamableHttpOptions = ConstructorParameters<typeof MCPServerStreamableHttp>[0];

/**
 * MCP client protocol selection for streamable HTTP servers.
 *
 * Remote servers are reached through the MCP TypeScript SDK v2 client, which
 * speaks protocol revision 2026-07-28 and negotiates the era per server:
 * `auto` probes with `server/discover` and falls back to the 2025-era
 * `initialize` handshake when the server is a legacy one. Opengeni's own
 * first-party servers are known 2025-era servers, so they skip the probe and
 * keep their single-round-trip connect on the turn-start path.
 *
 * ChatGPT's apps server (codex_apps) also stays on the 2025 handshake: it
 * answers `server/discover`, but its `tools/list` result has no `resultType`,
 * so a 2026-07-28 client rejects every tool list and the turn silently runs
 * without any connected app.
 */
export function loadMcpClientModule(): Promise<unknown> {
  return import("@modelcontextprotocol/client");
}

export function mcpStreamableHttpClientOptions(params: {
  firstParty: boolean;
  codexApps?: boolean;
}): Pick<MCPServerStreamableHttpOptions, "mcpClientModule" | "versionNegotiation"> {
  return {
    mcpClientModule: loadMcpClientModule,
    versionNegotiation: { mode: params.firstParty || params.codexApps ? "legacy" : "auto" },
  };
}
