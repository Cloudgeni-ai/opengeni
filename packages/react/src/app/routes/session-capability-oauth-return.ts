import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem } from "../types";
import { t } from "../lib/console-text";
import {
  catalogConnectionAccountSelection,
  oauthConnectionOwnership,
  oauthConnectionRef,
} from "../lib/capabilities";
import {
  attachSessionCapability,
  continueAfterCapabilitySetup,
} from "../components/capabilities/attach-session-capability";

export type McpCapabilityOAuthReturn = {
  name: string;
  /** A personal account still needs its own review on the card before this chat may use it. */
  needsPersonalReview: boolean;
};

/**
 * Finish an MCP capability's OAuth redirect back into a chat: bind the new
 * connection, verify the capability is enabled, add its tools to this chat
 * and let the agent continue the request that asked for it. Throws when any
 * step cannot be verified, so a failed setup never wakes the agent.
 */
export async function finishMcpCapabilityOAuthReturn(input: {
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  capabilityId: string;
  params: URLSearchParams;
  catalog: readonly CapabilityCatalogItem[];
  refreshCatalog: (workspaceId: string) => Promise<unknown>;
}): Promise<McpCapabilityOAuthReturn> {
  const { client, workspaceId, sessionId, params } = input;
  const item = input.catalog.find((candidate) => candidate.id === input.capabilityId);
  const connectionId = params.get("connectionId");
  const providerDomain = params.get("providerDomain");
  const ownership = oauthConnectionOwnership(params.get("ownership"));
  if (!item || item.kind !== "mcp" || !connectionId || !providerDomain || !ownership) {
    throw new Error("The authorized capability could not be resolved from the live catalog.");
  }
  await client.enableCapability(workspaceId, item.id, {
    connectionRef: oauthConnectionRef(
      ownership,
      connectionId,
      providerDomain,
      catalogConnectionAccountSelection(item),
    ),
  });
  await input.refreshCatalog(workspaceId);
  const connected = (await client.listCapabilities(workspaceId)).items.find(
    (candidate) => candidate.id === item.id,
  );
  if (!connected?.enabled)
    throw new Error("The connection was authorized, but enabling its tools could not be verified.");
  if (connected.connectionRef?.subjectScope === "subject")
    return { name: item.name, needsPersonalReview: true };
  await attachSessionCapability(t, client, workspaceId, sessionId, connected);
  continueAfterCapabilitySetup(client, workspaceId, sessionId, connected.id);
  return { name: item.name, needsPersonalReview: false };
}
