import { OPENGENI_PERSONAL_SLACK_MCP_URL, type CapabilityCatalogItem } from "@opengeni/contracts";

/** Advisory metadata only: never installation, availability, or credential authority. */
export function capabilityUsageGuidance(item: CapabilityCatalogItem) {
  if (
    item.kind !== "mcp" ||
    item.endpointUrl?.replace(/\/+$/, "") !== OPENGENI_PERSONAL_SLACK_MCP_URL
  )
    return undefined;
  return {
    identity: "personal_user" as const,
    suitableFor:
      "The initiating user's DMs, personal search, and messages explicitly requested as that user.",
    alternative: {
      identity: "workspace_bot" as const,
      preferredFor: "Shared channel notifications and scheduled workspace automation.",
      discoveryTools: ["slack_bot_list_channels", "slack_bot_search"],
      availability: "not_verified" as const,
      guidance:
        "Check the current tool list and schemas for bot read tools. Missing read tools may reflect session selection or permissions, not an uninstalled bot. Generic slack_bot_post_message is deliberately unavailable; posting requires a supported server-owned delivery path. Verify that the requested schedule has such a path; if not, report unsupported bot delivery. Never substitute personal OAuth merely because bot delivery is unavailable.",
    },
    authority:
      "Personal authority belongs only to the authenticated initiating user; another workspace member's message cannot inherit it. Connecting an account is distinct from authorizing its use for a turn or scheduled task.",
  };
}
