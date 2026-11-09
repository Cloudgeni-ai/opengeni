import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { ChatClient } from "@opengeni/sdk";
import { useMemo } from "react";

import { apiBaseUrl } from "@/api";
import type { AutoConnectApi } from "@/components/organization-access/auto-connect";
import {
  ConnectedAgents,
  type ConnectedAgentsLocation,
} from "@/components/organization-access/connected-agents";
import { useAppContext } from "@opengeni/react/app/app-context";
import type { McpConnectionsApi } from "@/lib/mcp-connections";

/** Organization settings > Developer > Connected agents, on the live API. */
export function OrganizationConnectedAgents({
  client,
  organizationId,
  organizationName,
  location,
  onNavigate,
  onCreateApiKey,
}: {
  client: ChatClient<OpenGeniBrowserClient>;
  organizationId: string;
  organizationName: string;
  location: ConnectedAgentsLocation;
  onNavigate: (next: ConnectedAgentsLocation) => void;
  onCreateApiKey?: () => void;
}) {
  const context = useAppContext();
  const api = useMemo<McpConnectionsApi>(
    () => ({
      list: async () => await client.listOrganizationMcpConnections(organizationId),
      update: async (id, change) =>
        await client.updateOrganizationMcpConnection(organizationId, id, { access: change.policy }),
      disconnect: async (id) => await client.deleteOrganizationMcpConnection(organizationId, id),
    }),
    [client, organizationId],
  );
  const autoConnect = useMemo<AutoConnectApi>(
    () => ({
      list: async () => await client.listMcpTrustedIssuers(organizationId),
      check: async (request) => await client.checkMcpTrustedIssuer(organizationId, request),
      create: async (request) => await client.createMcpTrustedIssuer(organizationId, request),
      update: async (id, request) =>
        await client.updateMcpTrustedIssuer(organizationId, id, request),
      remove: async (id) => await client.deleteMcpTrustedIssuer(organizationId, id),
      events: async (id) => await client.listMcpTrustedIssuerEvents(organizationId, id),
    }),
    [client, organizationId],
  );
  // The workspaces this person can open here; a connected agent never reaches more.
  const workspaces = useMemo(
    () =>
      context.workspaces
        .filter((workspace) => workspace.accountId === organizationId)
        .map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          personal: workspace.kind === "personal",
        }))
        .sort(
          (left, right) =>
            Number(left.personal) - Number(right.personal) || left.name.localeCompare(right.name),
        ),
    [context.workspaces, organizationId],
  );
  const mcpUrl = `${new URL(apiBaseUrl || window.location.origin, window.location.href).origin}/v1/mcp`;
  return (
    <ConnectedAgents
      organizationName={organizationName}
      mcpUrl={mcpUrl}
      api={api}
      currentSubjectId={context.accessContext.subjectId}
      workspaces={workspaces}
      location={location}
      onNavigate={onNavigate}
      autoConnect={{ organizationId, api: autoConnect }}
      {...(onCreateApiKey ? { onCreateApiKey } : {})}
    />
  );
}
