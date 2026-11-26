import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import type { ChatClient } from "@opengeni/sdk";
import type { CapabilityCatalogItem } from "../types";
import { t } from "../lib/console-text";
import {
  catalogConnectionAccountSelection,
  oauthConnectionOwnership,
  oauthConnectionRef,
  oauthResumeAction,
} from "../lib/capabilities";
import {
  attachSessionCapability,
  continueAfterCapabilitySetup,
} from "../components/capabilities/attach-session-capability";
import {
  completeDriveConnectReturn,
  DRIVE_MCP_URL,
  resolveDriveConnectReturn,
} from "../lib/drive-connect-return";

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
  client: ChatClient<OpenGeniClient>;
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
  // The sign-in callback usually turned the capability on already
  // (`capability=enabled|on`); enable here only when it is not on with this
  // account yet.
  const current = params.get("capability")
    ? ((await client.listCapabilities(workspaceId)).items.find(
        (candidate) => candidate.id === item.id,
      ) ?? item)
    : item;
  if (oauthResumeAction(current, connectionId) !== "reconnect") {
    await client.enableCapability(workspaceId, item.id, {
      connectionRef: oauthConnectionRef(
        ownership,
        connectionId,
        providerDomain,
        catalogConnectionAccountSelection(current),
      ),
    });
  }
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

/**
 * Finish a Google Drive connect started from a chat. Drive returns to the
 * exact chat URL with only its `drive_connect_return` nonce, so the account
 * comes from the saved Connect attempt; the rest is an ordinary OAuth return.
 */
export async function finishDriveConnectReturnInChat(input: {
  client: ChatClient<OpenGeniClient>;
  workspaceId: string;
  sessionId: string;
  nonce: string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  refreshCatalog: (workspaceId: string) => Promise<unknown>;
}): Promise<McpCapabilityOAuthReturn> {
  const { client, workspaceId, nonce, storage } = input;
  const { itemId, connectionId } = await resolveDriveConnectReturn({
    client,
    workspaceId,
    nonce,
    storage,
  });
  // The card may have just created the catalog entry; read it fresh.
  const catalog = (await client.listCapabilities(workspaceId)).items;
  const item = catalog.find((candidate) => candidate.id === itemId);
  if ((item?.mcpUrl ?? item?.endpointUrl) !== DRIVE_MCP_URL)
    throw new Error("The Google Drive connector changed. Open Drive to finish setup.");
  const finished = await finishMcpCapabilityOAuthReturn({
    client,
    workspaceId,
    sessionId: input.sessionId,
    capabilityId: itemId,
    params: new URLSearchParams({
      connectionId,
      providerDomain: new URL(DRIVE_MCP_URL).hostname,
      ownership: "personal",
    }),
    catalog,
    refreshCatalog: input.refreshCatalog,
  });
  completeDriveConnectReturn(workspaceId, nonce, storage);
  return finished;
}
