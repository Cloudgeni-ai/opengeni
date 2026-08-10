import {
  createGraphqlMcpServer,
  createOpenApiMcpServer,
  createPinnedIntegrationTransport,
  type IntegrationCredentialResolver,
  type IntegrationInvocationAuthority,
} from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import type { ToolAuthNeededPayload } from "@opengeni/contracts";
import type {
  ApiIntegrationRuntime,
  ResolveConnectionCredentialInput,
  ResolveConnectionCredentialResult,
} from "@opengeni/db";
import type { LocalMcpServerRegistration } from "@opengeni/runtime";
import type { FetchLike } from "@opengeni/network";

export type BuildApiIntegrationServersInput = {
  settings: Settings;
  integrations: readonly ApiIntegrationRuntime[];
  authority: Omit<IntegrationInvocationAuthority, "connectionRef">;
  resolveCredential: (
    input: ResolveConnectionCredentialInput,
  ) => Promise<ResolveConnectionCredentialResult>;
  onAuthNeeded?: (payload: ToolAuthNeededPayload) => Promise<void> | void;
  fetchImpl?: FetchLike;
};

/**
 * Compile active persisted API facets into ordinary in-process MCP servers for
 * one exact attempt. Connection resolution remains request-time, destination-
 * bound, personal-delegation-fenced, and refreshable through the same worker
 * resolver used by remote MCP servers.
 */
export function buildApiIntegrationServersForTurn(
  input: BuildApiIntegrationServersInput,
): LocalMcpServerRegistration[] {
  const transport = createPinnedIntegrationTransport({
    network: input.settings,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  return input.integrations.map((integration) => {
    const authority: IntegrationInvocationAuthority = {
      ...input.authority,
      ...(integration.connectionRef?.connectionId
        ? { connectionRef: integration.connectionRef.connectionId }
        : {}),
    };
    const credentialResolver = integration.connectionRef
      ? integrationCredentialResolver(input, integration)
      : undefined;
    const server =
      integration.revision.protocol === "openapi"
        ? createOpenApiMcpServer({
            revision: integration.revision,
            transport,
            authority,
            ...(credentialResolver ? { credentialResolver } : {}),
          })
        : createGraphqlMcpServer({
            revision: integration.revision,
            endpoint: integration.baseUrl,
            transport,
            authority,
            ...(credentialResolver ? { credentialResolver } : {}),
          });
    return {
      id: integration.serverId,
      server,
      ...(integration.connectionRef?.connectionId
        ? { resolvedConnectionId: integration.connectionRef.connectionId }
        : {}),
    };
  });
}

function integrationCredentialResolver(
  input: BuildApiIntegrationServersInput,
  integration: ApiIntegrationRuntime,
): IntegrationCredentialResolver {
  const connectionRef = integration.connectionRef;
  if (!connectionRef) throw new Error("Integration credential resolver requires a connection");
  return {
    resolve: async (request) => {
      const result = await input.resolveCredential({
        workspaceId: input.authority.workspaceId,
        serverId: integration.serverId,
        toolName: request.operationKey,
        connectionRef,
        destinationUrl: request.destinationUrl,
        forceRefresh: request.forceRefresh === true,
      });
      if (result.status === "auth_needed") {
        await publishAuthNeeded(input, integration.serverId, request.operationKey, result);
        return null;
      }
      const destination = new URL(request.destinationUrl);
      return {
        audience: { origin: destination.origin, pathPrefix: "/" },
        placements: Object.entries(result.headers).map(([name, value]) => ({
          carrier: "header" as const,
          name,
          value,
        })),
        ...(result.expiresAt ? { expiresAt: result.expiresAt.toISOString() } : {}),
        ...(connectionRef.scopes ? { scope: [...connectionRef.scopes] } : {}),
      };
    },
  };
}

async function publishAuthNeeded(
  input: BuildApiIntegrationServersInput,
  serverId: string,
  toolName: string,
  result: Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }>,
): Promise<void> {
  try {
    await input.onAuthNeeded?.({
      serverId,
      toolName,
      providerDomain: result.providerDomain,
      ...(result.provider ? { provider: result.provider } : {}),
      reason: result.reason,
      ...(result.connectionId ? { connectionId: result.connectionId } : {}),
      ...(result.scopes ? { scopes: result.scopes } : {}),
      ...(result.resource ? { resource: result.resource } : {}),
      ...(result.selectedResources ? { selectedResources: result.selectedResources } : {}),
      ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
    });
  } catch {
    // Authentication notices are advisory UI/audit signals. The local tool
    // still returns the fixed connection-required result when publication fails.
  }
}