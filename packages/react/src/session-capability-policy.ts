import type {
  FirstPartyMcpToolName,
  CapabilityCatalogItem,
  Session,
  UpdateSessionToolPolicyRequest,
} from "@opengeni/sdk";
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
  const request = capabilityToolPolicyUpdate(session, item);
  if (request) await client.updateSessionToolPolicy(workspaceId, sessionId, request);
}

function capabilityToolPolicyUpdate(
  session: Session,
  item: CapabilityCatalogItem,
): UpdateSessionToolPolicyRequest | null {
  const tools = sessionCapabilityTools(item);
  if (item.kind === "skill" || tools.length === 0) return null;
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
    // selectedIds contains only explicit additions, and is normally empty for
    // automatic selection. Compare against the resolved defaults instead.
    existing = policy.effectiveIds
      .filter((id) => !policy.mandatoryIds.includes(id))
      .map(
        (id) =>
          session.tools.find((tool) => tool.kind === "mcp" && tool.id === id) ?? {
            kind: "mcp" as const,
            id,
            optional: true,
          },
      );
  }
  const additions = tools.filter(
    (tool) =>
      !session.effectiveToolPolicy?.mandatoryIds.includes(tool.id) &&
      !existing.some((current) => current.kind === tool.kind && current.id === tool.id),
  );
  const recommended = Array.isArray(item.metadata?.firstPartyMcpTools)
    ? (item.metadata.firstPartyMcpTools.filter(
        (name): name is string => typeof name === "string",
      ) as FirstPartyMcpToolName[])
    : [];
  const firstParty = [...new Set([...session.firstPartyMcpTools, ...recommended])];
  if (additions.length === 0 && firstParty.length === session.firstPartyMcpTools.length)
    return null;
  return {
    mode: "explicit",
    tools: [...existing, ...additions],
    firstPartyMcpTools: firstParty,
    expectedVersion: session.toolPolicyVersion,
  };
}

/** Read-only review. Hosts must show ancestor changes and obtain a separate
 * explicit click before applying. This plan is never authorization. */
export type SessionCapabilityAccessPlan = {
  workspaceId: string;
  sessionId: string;
  capabilityId: string;
  sessions: Array<{
    id: string;
    title: string | null;
    parentSessionId: string | null;
    toolPolicyVersion: number;
    request: UpdateSessionToolPolicyRequest | null;
  }>;
};

export async function prepareSessionCapabilityAccess(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  item: CapabilityCatalogItem,
  stillCurrent: () => boolean = () => true,
): Promise<SessionCapabilityAccessPlan> {
  const sessions: SessionCapabilityAccessPlan["sessions"] = [];
  if (item.kind === "skill" || sessionCapabilityTools(item).length === 0)
    return { workspaceId, sessionId, capabilityId: item.id, sessions };
  const visited = new Set<string>();
  let id: string | null = sessionId;
  while (id) {
    if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
    if (visited.has(id)) throw new Error("The parent chat chain could not be verified.");
    visited.add(id);
    const session = await client.getSession(workspaceId, id);
    if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
    const request = capabilityToolPolicyUpdate(session, item);
    sessions.push({
      id,
      title: session.title ?? null,
      parentSessionId: session.parentSessionId ?? null,
      toolPolicyVersion: session.toolPolicyVersion,
      request,
    });
    // An unchanged immediate parent already supplies this capability's ceiling.
    // Do not read or broaden ancestors irrelevant to this addition.
    if (!request) break;
    id = session.parentSessionId ?? null;
  }
  return { workspaceId, sessionId, capabilityId: item.id, sessions: sessions.reverse() };
}

/** Preflight the entire review, then apply ordinary CAS-fenced API writes root
 * first. A partial failure may leave approved ancestor changes committed; never
 * claim success or roll back another person's edits. Prepare a new review. */
export async function applySessionCapabilityAccess(
  client: OpenGeniClient,
  plan: SessionCapabilityAccessPlan,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  for (const reviewed of plan.sessions) {
    if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
    const current = await client.getSession(plan.workspaceId, reviewed.id);
    if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
    if (
      current.toolPolicyVersion !== reviewed.toolPolicyVersion ||
      (current.parentSessionId ?? null) !== reviewed.parentSessionId
    )
      throw new Error("Chat access changed. Click Add tools to review the current choices again.");
  }
  for (const reviewed of plan.sessions) {
    if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
    if (reviewed.request) {
      const updated = await client.updateSessionToolPolicy(
        plan.workspaceId,
        reviewed.id,
        reviewed.request,
      );
      if (
        reviewed.request.mode === "explicit" &&
        reviewed.request.firstPartyMcpTools.some(
          (tool) => !updated.firstPartyMcpTools.includes(tool),
        )
      )
        throw new Error(
          "This chat's capabilities do not allow these tools. Review its capability settings before adding tools again.",
        );
    }
  }
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
