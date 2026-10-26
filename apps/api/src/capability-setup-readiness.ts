import type { CapabilityCatalogItem, Session } from "@opengeni/contracts";

/**
 * Whether a capability the person just set up from an agent's card is usable
 * in this chat, judged from the live catalog and the chat's effective tool
 * policy. A projection only: it never resolves credentials or grants access.
 *
 * - `ready`: enabled, and every tool the setup selects is in the chat.
 * - `assumed_ready`: enabled, but the chat's tool list is too long to prove
 *   the tools are in it; the client verified its own attach.
 * - `not_ready`: not (yet) enabled or not (yet) selected in the chat.
 * - `not_applicable`: cards that finish through their own flow and send the
 *   person's message themselves (connected machines, GitHub).
 */
export type CapabilitySetupReadiness = "ready" | "assumed_ready" | "not_ready" | "not_applicable";

const SELF_REPORTING_CAPABILITY_IDS = new Set(["api:connected-machine", "api:github-app"]);

/** Built-in servers are not tool-policy ids; their tools are chosen by name. */
const BUILT_IN_SERVER_IDS = new Set(["opengeni", "files", "docs"]);

export function capabilitySetupReadiness(
  capabilityId: string,
  item: CapabilityCatalogItem | undefined,
  session: Pick<Session, "tools" | "firstPartyMcpTools" | "effectiveToolPolicy">,
): CapabilitySetupReadiness {
  if (
    SELF_REPORTING_CAPABILITY_IDS.has(capabilityId) ||
    item?.surfaceType === "first_party_github"
  ) {
    return "not_applicable";
  }
  if (!item) return "not_ready";
  if (!item.enabled) return "not_ready";
  // A Fiken tile stays enabled while its connection needs reconnection.
  if (item.surfaceType === "first_party_fiken" && item.metadata.connectionStatus !== "active") {
    return "not_ready";
  }
  if (item.kind === "skill") return "ready";
  // The same selection the clients write when attaching a capability to a chat.
  const serverIds = new Set(item.tools.map((tool) => tool.id));
  if (item.kind === "mcp" && item.runtime.mcpServerId) serverIds.add(item.runtime.mcpServerId);
  for (const id of BUILT_IN_SERVER_IDS) serverIds.delete(id);
  const recommended = Array.isArray(item.metadata.firstPartyMcpTools)
    ? item.metadata.firstPartyMcpTools.filter((name): name is string => typeof name === "string")
    : [];
  const firstParty = new Set<string>(session.firstPartyMcpTools);
  if (recommended.some((name) => !firstParty.has(name))) return "not_ready";
  if (serverIds.size === 0) return "ready";
  const policy = session.effectiveToolPolicy;
  // A truncated id list cannot prove absence; the client verified the attach.
  if (policy?.idsTruncated) return "assumed_ready";
  const selected = new Set<string>(
    policy
      ? [...policy.effectiveIds, ...policy.mandatoryIds]
      : session.tools.map((tool) => tool.id),
  );
  for (const id of serverIds) if (!selected.has(id)) return "not_ready";
  return "ready";
}
