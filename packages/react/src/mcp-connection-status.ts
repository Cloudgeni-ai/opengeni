import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";

/** Status only; runtime use is authorized for the authenticated initiating user. */
export function matchingActiveMcpConnections(
  item: CapabilityCatalogItem,
  connections: ConnectionMetadata[],
) {
  const ref = item.connectionRef;
  if (!item.enabled || !ref) return [];
  return connections.filter(
    (entry) =>
      entry.status === "active" &&
      entry.kind === "oauth2" &&
      entry.metadata.mcpUrl === (item.mcpUrl ?? item.endpointUrl) &&
      (ref.subjectScope !== "subject"
        ? entry.id === ref.connectionId && entry.subjectId === null
        : entry.subjectId !== null),
  );
}
