import type { AttemptToolCatalog, Permission } from "@opengeni/contracts";

export const PREPARED_MCP_PERMISSIONS = [
  "connections:read",
  "connections:write",
  "capabilities:manage",
] as const satisfies readonly Permission[];

/** Only the existing native Connect resource can receive setup permissions.
 * This never expands SDK access to unrelated credential or settings routes. */
export function isPreparedMcpConnectPath(path: string, method: string): boolean {
  const match =
    /^\/v1\/workspaces\/[^/]+\/connect\/attempts(?:\/([0-9a-f-]{36})(?:\/(advance|cancel))?)?$/.exec(
      path,
    );
  return Boolean(
    match && (method === "GET" ? !match[2] : method === "POST" && (!match[1] || match[2])),
  );
}

/** The accepted tool must be present without an outstanding human-review gate.
 * A session/settings edit can remove authority but cannot add it to this attempt. */
export function preparedMcpProxyPermissions(
  catalog: AttemptToolCatalog,
  livePermissions: readonly Permission[],
): Permission[] {
  const entry = catalog.entries.find(
    (item) =>
      item.identity.serverId === "opengeni" &&
      item.identity.toolName === "custom_mcp_setup_request",
  );
  if (!entry || entry.approval !== "none") return [];
  return PREPARED_MCP_PERMISSIONS.filter(
    (permission) =>
      catalog.firstPartyMcpPermissions?.includes(permission) &&
      livePermissions.includes(permission),
  );
}
