import type { FirstPartyMcpToolName, CapabilityCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";

/** Catalog tool discovery may be lazy; selecting the installed server does not
 * require its individual tool inventory to have been fetched. */
export function sessionCapabilityTools(item: CapabilityCatalogItem) {
  const serverId = item.kind === "mcp" ? item.runtime?.mcpServerId : undefined;
  return serverId && !item.tools.some((tool) => tool.kind === "mcp" && tool.id === serverId)
    ? [...item.tools, { kind: "mcp" as const, id: serverId }]
    : item.tools;
}

/** A connection never resets the human's existing tool selection. Default-mode
 * sessions discover newly enabled servers at admission; explicit/inherited
 * policies add only this reviewed capability, with the existing CAS fence. */
export async function attachSessionCapability(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  item: CapabilityCatalogItem,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  const tools = sessionCapabilityTools(item);
  if (item.kind === "skill" || tools.length === 0) return;
  if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
  const session = await client.getSession(workspaceId, sessionId);
  if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
  // Session.tools includes mandatory runtime servers, which must never be
  // echoed into the human's explicit selection.
  let existing = session.tools.filter(
    (tool) => !session.effectiveToolPolicy?.mandatoryIds?.includes(tool.id),
  );
  if (session.toolPolicy.mode === "workspace_default") {
    const policy = session.effectiveToolPolicy;
    if (!policy || policy.idsTruncated)
      throw new Error(
        "Connected, but the full session tool selection could not be read. Review the Tools picker before continuing.",
      );
    // A workspace may choose a restricted default instead of all enabled servers.
    // Preserve that exact selection if this connection needs an explicit addition.
    existing = policy.selectedIds.map((id) => ({ kind: "mcp" as const, id }));
  }
  const additions = tools.filter(
    (tool) => !existing.some((current) => current.kind === tool.kind && current.id === tool.id),
  );
  const recommended = Array.isArray(item.metadata?.firstPartyMcpTools)
    ? (item.metadata.firstPartyMcpTools.filter(
        (name): name is string => typeof name === "string",
      ) as FirstPartyMcpToolName[])
    : [];
  const firstParty = [...new Set([...session.firstPartyMcpTools, ...recommended])];
  if (additions.length === 0 && firstParty.length === session.firstPartyMcpTools.length) return;
  await client.updateSessionToolPolicy(workspaceId, sessionId, {
    mode: "explicit",
    tools: [...existing, ...additions],
    firstPartyMcpTools: firstParty,
    expectedVersion: session.toolPolicyVersion,
  });
}

/** Native OAuth callbacks have already saved the provider connection. Finish
 * the separate, version-fenced session tool selection before reporting success. */
export async function completeSessionCapabilityOAuth(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  capabilityId: string | null,
): Promise<void> {
  if (!capabilityId)
    throw new Error(
      "The authorized integration could not be identified. Review its connection card to finish setup.",
    );
  const connected = (await client.listCapabilities(workspaceId)).items.find(
    (item) => item.id === capabilityId,
  );
  if (!connected?.enabled)
    throw new Error("The connection was authorized, but enabling its tools could not be verified.");
  await attachSessionCapability(client, workspaceId, sessionId, connected);
}
