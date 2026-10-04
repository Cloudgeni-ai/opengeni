/*
 * Connected agents: outside MCP clients (Claude Code, Cursor, Codex, ...)
 * a person signed in to the organization MCP server. Each acts as that
 * person, capped by its access setting; the server is the authority.
 */

import type { OrganizationMcpConnection, OrganizationMcpConnectionList } from "@opengeni/sdk";

import type { OrganizationAccessPolicy } from "@/lib/organization-access";

export type McpConnection = OrganizationMcpConnection;

export type McpConnectionsApi = {
  list: () => Promise<OrganizationMcpConnectionList>;
  update: (id: string, change: { policy: OrganizationAccessPolicy }) => Promise<McpConnection>;
  disconnect: (id: string) => Promise<void>;
};

export type McpConnectionStatus = "active" | "expired" | "revoked";

export function mcpConnectionStatus(
  connection: McpConnection,
  now = Date.now(),
): McpConnectionStatus {
  if (connection.revokedAt) return "revoked";
  if (connection.expiresAt && Date.parse(connection.expiresAt) <= now) return "expired";
  return "active";
}

export type McpClientSetup = { id: "claude" | "cursor" | "codex" | "other"; label: string };

export const MCP_CLIENT_SETUPS: readonly McpClientSetup[] = [
  { id: "claude", label: "Claude" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "other", label: "Other" },
];

/** What to paste into each client. Every one signs in through the browser. */
export function mcpClientSnippet(client: McpClientSetup["id"], url: string): string {
  switch (client) {
    case "claude":
      return `claude mcp add --transport http opengeni ${url}`;
    case "cursor":
      return JSON.stringify({ mcpServers: { opengeni: { url } } }, null, 2);
    case "codex":
      return `codex mcp add opengeni --url ${url}\ncodex mcp login opengeni`;
    case "other":
      return url;
  }
}

export function mcpClientHint(client: McpClientSetup["id"]): string {
  switch (client) {
    case "claude":
      return "Run it in a terminal, then type /mcp in Claude Code to sign in.";
    case "cursor":
      return "Add it to .cursor/mcp.json, or to Cursor Settings > MCP, then select Connect.";
    case "codex":
      return "Run both lines in a terminal. The second opens your browser to sign in.";
    case "other":
      return "Any MCP client with Streamable HTTP and OAuth sign-in can connect.";
  }
}
