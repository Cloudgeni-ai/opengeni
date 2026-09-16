import { OPENGENI_PERSONAL_SLACK_MCP_URL, type CapabilityCatalogItem } from "@opengeni/contracts";

/** Canonical connector metadata, shared by catalog UI and agent discovery. */
export function withCapabilityDescription(item: CapabilityCatalogItem): CapabilityCatalogItem {
  if (
    item.kind !== "mcp" ||
    item.endpointUrl?.replace(/\/+$/, "") !== OPENGENI_PERSONAL_SLACK_MCP_URL
  )
    return item;
  return {
    ...item,
    name: "Slack (personal account)",
    description:
      "Read the connected user's DMs and accessible conversations, search Slack, and send messages to channels or DMs as that user. Uses that user's personal account. Scheduled tasks require that user's ongoing authorization, or authorization for the exact destination chat.",
  };
}
