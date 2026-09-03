import {
  createGraphqlMcpServer,
  createOpenApiMcpServer,
  createPinnedIntegrationTransport,
  directIntegrationTransport,
  IntegrationInvocationError,
  type IntegrationCredentialResolver,
  type IntegrationInvocationAuthority,
  type IntegrationTransport,
} from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import type { ToolAuthNeededPayload } from "@opengeni/contracts";
import type {
  ApiIntegrationRuntime,
  ResolveConnectionCredentialInput,
  ResolveConnectionCredentialResult,
} from "@opengeni/db";
import type { FetchLike } from "@opengeni/network";
import type { LocalMcpServerRegistration } from "@opengeni/runtime";

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
 * Compile active persisted API facets into ordinary in-process MCP providers.
 * The caller supplies its authority resolver, so agent attempts and current
 * humans use the same provider assembly without sharing credentials or policy.
 */
export function buildApiIntegrationMcpServers(
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
    const buildServer = (serverTransport: IntegrationTransport) =>
      integration.revision.protocol === "openapi"
        ? createOpenApiMcpServer({
            revision: integration.revision,
            transport: serverTransport,
            authority,
            ...(credentialResolver ? { credentialResolver } : {}),
          })
        : createGraphqlMcpServer({
            revision: integration.revision,
            endpoint: integration.baseUrl,
            transport: serverTransport,
            authority,
            ...(credentialResolver ? { credentialResolver } : {}),
          });
    const server = buildServer(transport);
    const preflightServer = credentialResolver
      ? buildServer(providerBlockingPreflightTransport)
      : null;
    return {
      id: integration.serverId,
      server,
      ...(integration.connectionRef?.connectionId
        ? { resolvedConnectionId: integration.connectionRef.connectionId }
        : {}),
      ...(credentialResolver
        ? {
            preflightCall: async (
              toolName: string,
              args: Record<string, unknown>,
              options?: { signal?: AbortSignal },
            ) => await preflightApiIntegrationCall(preflightServer!, toolName, args, options),
          }
        : {}),
    };
  });
}

/** @deprecated Use buildApiIntegrationMcpServers. */
export const buildApiIntegrationServersForTurn = buildApiIntegrationMcpServers;

const providerBlockingPreflightTransport = directIntegrationTransport(async () => {
  throw new Error("integration provider request blocked by preflight");
});

async function preflightApiIntegrationCall(
  server: LocalMcpServerRegistration["server"],
  toolName: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<void> {
  try {
    await server.callTool(toolName, args, null, options);
  } catch (error) {
    if (error instanceof IntegrationInvocationError && error.code === "request_failed") return;
    throw error;
  }
  throw new Error("integration preflight unexpectedly crossed the provider request boundary");
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
        credentialTarget: "http_api",
        forceRefresh: request.forceRefresh === true,
      });
      if (result.status === "auth_needed") {
        await publishAuthNeeded(
          input,
          integration.serverId,
          request.operationKey,
          result,
          connectionRef,
        );
        return null;
      }
      const destination = new URL(request.destinationUrl);
      return {
        audience: { origin: destination.origin, pathPrefix: "/" },
        placements:
          result.placements ??
          Object.entries(result.headers).map(([name, value]) => ({
            carrier: "header" as const,
            name,
            value,
          })),
        ...(result.authorizeProviderRequest
          ? { authorizeProviderRequest: result.authorizeProviderRequest }
          : {}),
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
  connectionRef: NonNullable<ApiIntegrationRuntime["connectionRef"]>,
): Promise<void> {
  try {
    await input.onAuthNeeded?.({
      serverId,
      toolName,
      providerDomain: result.providerDomain,
      ...(result.provider ? { provider: result.provider } : {}),
      reason: result.reason,
      ...(result.connectionId ? { connectionId: result.connectionId } : {}),
      ...(result.authoritySource === "host" || connectionRef.authoritySource === "host"
        ? { authoritySource: "host" as const }
        : {}),
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
