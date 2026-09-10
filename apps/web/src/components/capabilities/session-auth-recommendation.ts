import type { AuthNeededItem } from "@opengeni/react/session";
import type { CapabilityCatalogItem } from "@/types";

/** Recovery events identify runtime servers/connections, while recommendation
 * events already carry a catalog id. Never guess among same-domain accounts. */
export function sessionAuthRecommendation(
  item: AuthNeededItem,
  catalog: CapabilityCatalogItem[],
): AuthNeededItem | undefined {
  if (
    item.authoritySource === "host" ||
    item.reason === "personal_authority_unavailable" ||
    item.reason === "unsupported_auth" ||
    item.reason === "resource_scope_unavailable"
  )
    return undefined;
  if (item.capability) return item;
  const matches = catalog.filter(
    (candidate) =>
      (item.serverId !== null &&
        candidate.runtime.mcpServerId === item.serverId &&
        item.serverId !== "opengeni") ||
      (item.connectionId !== null && candidate.connectionRef?.connectionId === item.connectionId),
  );
  if (matches.length !== 1) return undefined;
  const entry = matches[0]!;
  return {
    ...item,
    capability: {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      source: entry.source,
      action: "connect",
      rationale: "Reconnect this integration to use its tools in this conversation.",
      requiredVariables: [],
    },
  };
}
