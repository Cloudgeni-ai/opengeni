import {
  CORE_INTEGRATION_DEFINITIONS,
  integrationDefinitionById,
  type IntegrationDefinition,
} from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import type { AccessGrant, CapabilityCatalogItem, Session } from "@opengeni/contracts";
import {
  integrationDefinitionCapabilityRecommendations,
  integrationDefinitionIdFromCapabilityId,
  requireLiveAgentAttemptAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  apiIntegrationConnected,
  getSession,
  listInstalledApiIntegrations,
  type ApiIntegrationRuntime,
  type Database,
} from "@opengeni/db";
import { curatedOAuthReadiness } from "../integrations/provider-oauth";
import { integrationAvailable } from "../integrations/teams-rollout";

/**
 * Reviewed integration definitions a person can connect from a chat card in
 * this workspace: enabled for it (the Teams rollout gate) and with the
 * deployment's OAuth client and encryption configured. The Connect catalog
 * offers the same set as providers.
 */
export function connectableIntegrationDefinitions(
  settings: Settings,
  workspaceId: string,
): IntegrationDefinition[] {
  return CORE_INTEGRATION_DEFINITIONS.filter(
    (definition) =>
      integrationAvailable(settings, workspaceId, definition.id) &&
      curatedOAuthReadiness(settings, definition).configured,
  );
}

function providerName(definition: IntegrationDefinition | undefined): string {
  return definition?.provider.id === "google" ? "Google" : "Microsoft";
}

/** What setup status needs to know, read once per catalog search or authorization request. */
export type IntegrationDefinitionSetupContext = {
  /** The integration instances of the person this attempt acts for. */
  instances: readonly ApiIntegrationRuntime[];
  /**
   * Whether this chat's tool selection can include a runtime server: false
   * when the chat is limited to an exact tool list without it, or excludes it.
   */
  chatIncludes: (serverId: string) => boolean;
};

/**
 * Read the setup context for this attempt. Personal accounts belong to the
 * person the attempt acts for, not the agent.
 */
export async function integrationDefinitionSetupContext(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
): Promise<IntegrationDefinitionSetupContext> {
  const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
  const [instances, session] = await Promise.all([
    listInstalledApiIntegrations(
      deps.db,
      grant.workspaceId,
      attempt.initiatingHumanSubjectId ?? grant.subjectId,
    ),
    getSession(deps.db, grant.workspaceId, sessionId),
  ]);
  return { instances, chatIncludes: chatToolSelectionIncludes(session) };
}

/**
 * Whether a chat's tool selection can include a newly connected runtime
 * server: a chat following the workspace defaults unless it excludes the
 * server; any other chat (an explicit list, or one inherited from a parent
 * with a fixed list) only when its selected tools list the server.
 */
export function chatToolSelectionIncludes(
  session: Pick<Session, "toolPolicy" | "tools"> | null,
): (serverId: string) => boolean {
  if (!session) return () => true;
  const policy = session.toolPolicy;
  if (policy.mode === "workspace_default") {
    const excluded = new Set(policy.excludedMcpServerIds ?? []);
    return (serverId) => !excluded.has(serverId);
  }
  const selected = new Set((session.tools ?? []).map((tool) => tool.id));
  return (serverId) => selected.has(serverId);
}

/**
 * Setup status of an integration definition for the person this attempt acts
 * for. Ready only when one of their signed-in instances has tools in this
 * turn's catalog. A signed-in instance this chat's tool selection includes
 * loads in the next turn, which is not a reason for another card; one the
 * chat leaves out needs the person to add it to the chat. An expired or
 * revoked account needs the card again.
 */
export function integrationDefinitionSetup(
  item: CapabilityCatalogItem,
  context: IntegrationDefinitionSetupContext,
  availableServerIds: ReadonlySet<string>,
):
  | { status: "ready"; action: null; detail: string }
  | { status: "authorization_required"; action: "connect"; detail: string }
  | { status: "unavailable"; action: null; detail: string } {
  const definitionId = integrationDefinitionIdFromCapabilityId(item.id);
  const definition = definitionId ? integrationDefinitionById(definitionId) : undefined;
  if (!definition) {
    return {
      status: "unavailable",
      action: null,
      detail: "This integration is not available on this deployment.",
    };
  }
  const connected = context.instances.filter(
    (instance) => instance.definitionId === definition.id && apiIntegrationConnected(instance),
  );
  if (connected.some((instance) => availableServerIds.has(instance.serverId))) {
    return {
      status: "ready",
      action: null,
      detail: `${item.name} is connected and its tools are available in this turn.`,
    };
  }
  if (connected.some((instance) => context.chatIncludes(instance.serverId))) {
    return {
      status: "unavailable",
      action: null,
      detail: `${item.name} is connected, but its tools are not in this turn. They load in the next turn; do not request another card.`,
    };
  }
  if (connected.length > 0) {
    return {
      status: "unavailable",
      action: null,
      detail: `${item.name} is connected, but this chat uses a fixed tool list that does not include it. Ask the person to add ${item.name} to this chat's tools, then continue.`,
    };
  }
  return {
    status: "authorization_required",
    action: "connect",
    detail: `Not connected. The person signs in with their own ${providerName(definition)} account from the Connect card; if their organization requires admin approval, the card gives them an approval link for their admin.`,
  };
}

/** What capability_authorization_request tells the model after posting the card. */
export function integrationDefinitionCardPostedMessage(item: CapabilityCatalogItem): string {
  const definitionId = integrationDefinitionIdFromCapabilityId(item.id);
  const provider = providerName(definitionId ? integrationDefinitionById(definitionId) : undefined);
  return `The ${item.name} Connect card was posted. It handles the ${provider} sign-in and any admin approval link, so do not repeat its steps; nothing is connected yet. When the person finishes connecting, you get an update and its tools are available then.`;
}

/**
 * The person's signed-in instances of an integration definition as one
 * catalog item, for judging whether setup from its chat card is finished:
 * enabled, with each connected instance's server as a tool. Undefined while
 * nothing is connected or the definition is not connectable here.
 */
export async function integrationDefinitionSetupItem(
  db: Database,
  settings: Settings,
  workspaceId: string,
  subjectId: string,
  capabilityId: string,
): Promise<CapabilityCatalogItem | undefined> {
  const definitionId = integrationDefinitionIdFromCapabilityId(capabilityId);
  const definition = connectableIntegrationDefinitions(settings, workspaceId).find(
    (entry) => entry.id === definitionId,
  );
  if (!definition) return undefined;
  const connected = (await listInstalledApiIntegrations(db, workspaceId, subjectId)).filter(
    (instance) => instance.definitionId === definition.id && apiIntegrationConnected(instance),
  );
  if (connected.length === 0) return undefined;
  const [item] = integrationDefinitionCapabilityRecommendations([definition]);
  return {
    ...item!,
    enabled: true,
    tools: connected.map((instance) => ({
      kind: "mcp" as const,
      id: instance.serverId,
      optional: true,
    })),
  };
}
