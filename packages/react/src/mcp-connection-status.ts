import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import { type OpenGeniText } from "./messages/runtime";

/** Status only; runtime use is authorized for the authenticated initiating user. */
export function matchingActiveMcpConnections(
  item: CapabilityCatalogItem,
  connections: ConnectionMetadata[],
) {
  return matchingMcpConnections(item, connections).filter((entry) => entry.status === "active");
}

function matchingMcpConnections(item: CapabilityCatalogItem, connections: ConnectionMetadata[]) {
  const ref = item.connectionRef;
  if (!item.enabled || !ref) return [];
  return connections.filter(
    (entry) =>
      entry.status !== "revoked" &&
      entry.kind === "oauth2" &&
      entry.metadata.mcpUrl === (item.mcpUrl ?? item.endpointUrl) &&
      (ref.subjectScope !== "subject"
        ? entry.id === ref.connectionId && entry.subjectId === null
        : entry.subjectId !== null),
  );
}

/** Installation availability is not account readiness. Revoked history is not actionable. */
export function mcpConnectionDiscoveryState(
  t: OpenGeniText,
  item: CapabilityCatalogItem,
  connections: ConnectionMetadata[],
) {
  const matching = matchingMcpConnections(item, connections);
  const active = matching.filter((entry) => entry.status === "active");
  if (active.length === 1)
    return { status: "added", label: t("mcpConnectionStatus.connected") } as const;
  if (matching.length > 0)
    return { status: "attention", label: t("mcpConnectionStatus.reviewConnection") } as const;
  return { status: "available", label: t("mcpConnectionStatus.connect") } as const;
}
