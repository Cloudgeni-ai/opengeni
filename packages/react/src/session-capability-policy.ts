import type {
  FirstPartyMcpToolName,
  CapabilityCatalogItem,
  Session,
  UpdateSessionToolPolicyRequest,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import { ConnectCardMessage } from "./connect-card-message";
import { type OpenGeniText } from "./messages/runtime";

/** What selecting a capability for a chat needs: its kind and tools. An
 * installed API integration has no catalog row, only its runtime server. */
export type SessionCapabilityToolSource = Pick<
  CapabilityCatalogItem,
  "kind" | "tools" | "runtime" | "metadata"
>;

/** Catalog tool discovery may be lazy; selecting the installed server does not
 * require its individual tool inventory to have been fetched. */
export function sessionCapabilityTools(item: SessionCapabilityToolSource) {
  const serverId = item.kind === "mcp" ? item.runtime?.mcpServerId : undefined;
  return serverId && !item.tools.some((tool) => tool.kind === "mcp" && tool.id === serverId)
    ? [...item.tools, { kind: "mcp" as const, id: serverId }]
    : item.tools;
}

/** A connection never resets the human's existing tool selection. Default-mode
 * sessions discover newly enabled servers at admission; explicit/inherited
 * policies add only this reviewed capability, with the existing CAS fence. */
export async function attachSessionCapability(
  t: OpenGeniText,
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  item: SessionCapabilityToolSource,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  const tools = sessionCapabilityTools(item);
  if (item.kind === "skill" || tools.length === 0) return;
  if (!stillCurrent())
    throw new ConnectCardMessage(t("sessionCapabilityPolicy.connectionSetupWasInterrupted"));
  const session = await client.getSession(workspaceId, sessionId);
  if (!stillCurrent())
    throw new ConnectCardMessage(t("sessionCapabilityPolicy.connectionSetupWasInterrupted"));
  const request = capabilityToolPolicyUpdate(t, session, item);
  if (request) await client.updateSessionToolPolicy(workspaceId, sessionId, request);
}

function capabilityToolPolicyUpdate(
  t: OpenGeniText,
  session: Session,
  item: SessionCapabilityToolSource,
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
      throw new ConnectCardMessage(t("sessionCapabilityPolicy.connectedButTheFullSession"));
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
  t: OpenGeniText,
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
    if (!stillCurrent())
      throw new ConnectCardMessage(t("sessionCapabilityPolicy.connectionSetupWasInterrupted"));
    if (visited.has(id))
      throw new ConnectCardMessage(t("sessionCapabilityPolicy.theParentChatChainCould"));
    visited.add(id);
    const session = await client.getSession(workspaceId, id);
    if (!stillCurrent())
      throw new ConnectCardMessage(t("sessionCapabilityPolicy.connectionSetupWasInterrupted"));
    const request = capabilityToolPolicyUpdate(t, session, item);
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
  t: OpenGeniText,
  client: OpenGeniClient,
  plan: SessionCapabilityAccessPlan,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  for (const reviewed of plan.sessions) {
    if (!stillCurrent())
      throw new ConnectCardMessage(t("sessionCapabilityPolicy.connectionSetupWasInterrupted"));
    const current = await client.getSession(plan.workspaceId, reviewed.id);
    if (!stillCurrent())
      throw new ConnectCardMessage(t("sessionCapabilityPolicy.connectionSetupWasInterrupted"));
    if (
      current.toolPolicyVersion !== reviewed.toolPolicyVersion ||
      (current.parentSessionId ?? null) !== reviewed.parentSessionId
    )
      throw new ConnectCardMessage(t("sessionCapabilityPolicy.chatAccessChangedClickAdd"));
  }
  for (const reviewed of plan.sessions) {
    if (!stillCurrent())
      throw new ConnectCardMessage(t("sessionCapabilityPolicy.connectionSetupWasInterrupted"));
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
        throw new ConnectCardMessage(t("sessionCapabilityPolicy.thisChatSCapabilitiesDo"));
    }
  }
}

/** Native OAuth callbacks have already saved the provider connection. Finish
 * the separate, version-fenced session tool selection before reporting success,
 * then let the agent continue the request that asked for this connection. */
export async function completeSessionCapabilityOAuth(
  t: OpenGeniText,
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  capabilityId: string | null,
): Promise<void> {
  if (!capabilityId)
    throw new ConnectCardMessage(t("sessionCapabilityPolicy.theAuthorizedIntegrationCouldNot"));
  const connected = (await client.listCapabilities(workspaceId)).items.find(
    (item) => item.id === capabilityId,
  );
  if (!connected?.enabled)
    throw new ConnectCardMessage(t("sessionCapabilityPolicy.theConnectionWasAuthorizedBut"));
  await attachSessionCapability(t, client, workspaceId, sessionId, connected);
  continueAfterCapabilitySetup(client, workspaceId, sessionId, capabilityId);
}

/**
 * After setup from an agent's capability card is verified, let the agent
 * continue the request that needed it, so the person does not have to say
 * they are done. The server sends at most one continuation per card and none
 * once the person has written since; a failure here never fails the setup the
 * person just finished, so it is swallowed. Call only on verified success.
 */
export function continueAfterCapabilitySetup(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  capabilityId: string,
): void {
  void Promise.resolve()
    .then(() => client.continueAfterCapabilitySetup(workspaceId, sessionId, { capabilityId }))
    .catch(() => undefined);
}
