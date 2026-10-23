import { createPinnedIntegrationTransport } from "@opengeni/capabilities";
import type { McpServerConfig, Settings } from "@opengeni/config";
import {
  buildConnectionTokenResolver,
  listEnabledMcpCapabilityServers,
  type Database,
  type EventSourceRecord,
} from "@opengeni/db";
import { boundMcpResponseBody, MCP_MAX_RESPONSE_BYTES } from "@opengeni/runtime/mcp-network";
import { settingsWithMcpCapabilityServers } from "../capabilities";
import { mcpAccountBindingsFromVisibleConnections } from "../mcp-account-bindings";
import {
  withMcpStreamableHttpClient,
  type McpStreamableHttpClient,
} from "../mcp-streamable-http-client";
import { visibleMcpAccountConnections } from "../personal-connection-delegations";
import {
  classifyMcpEventsError,
  MCP_EVENTS_CLIENT_CAPABILITIES,
  withMcpEventNameHeader,
} from "./mcp-events-protocol";

/**
 * Connects to the MCP server behind an event source as the source's owner:
 * the same server configuration and the same sign-in the owner's chats use.
 * An MCP source always belongs to one person, so nothing here widens access.
 */

export type McpEventsFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type McpEventSourceClientDeps = {
  db: Database;
  settings: Settings;
  /** Replaces the pinned integration transport, for tests. */
  fetch?: McpEventsFetch;
};

/** The source cannot reach its server until a person acts; the message says what to do. */
export class McpEventSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpEventSourceUnavailableError";
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function mcpServerDisplayName(server: Pick<McpServerConfig, "id" | "name">): string {
  return server.name?.trim() || server.id;
}

/** The fields of an MCP source a connection needs; a source being created has no id yet. */
export type McpEventSourceTarget = Pick<
  EventSourceRecord,
  "kind" | "accountId" | "workspaceId" | "ownerSubjectId" | "mcpServerId" | "connectionId"
>;

/** What a connection reached: the server and the owner's account it signed in with. */
export type McpEventSourceConnection = {
  server: McpServerConfig;
  /** The connection used, or null for a server that needs no sign-in. */
  connectionId: string | null;
};

type ResolvedServer = McpEventSourceConnection & {
  headers: (forceRefresh: boolean) => Promise<Record<string, string>>;
  refreshable: boolean;
};

async function resolveServer(
  deps: McpEventSourceClientDeps,
  source: McpEventSourceTarget,
): Promise<ResolvedServer> {
  const serverId = source.mcpServerId;
  const owner = source.ownerSubjectId;
  if (source.kind !== "mcp" || !serverId || !owner) {
    throw new McpEventSourceUnavailableError("This source is not an MCP connector");
  }
  const enabled = await listEnabledMcpCapabilityServers(deps.db, source.workspaceId, {
    capabilityIds: [],
    serverIds: [serverId],
  });
  const settings = settingsWithMcpCapabilityServers(deps.settings, enabled);
  const server = settings.mcpServers.find((candidate) => candidate.id === serverId);
  if (!server) {
    throw new McpEventSourceUnavailableError(
      "The connector this source listens to is no longer added to the workspace",
    );
  }
  const ref = server.connectionRef;
  if (!ref) {
    return {
      server,
      connectionId: null,
      headers: async () => ({ ...server.headers }),
      refreshable: false,
    };
  }
  const reconnect = `Reconnect ${mcpServerDisplayName(server)} to keep its events coming`;
  if (ref.authoritySource === "host") {
    throw new McpEventSourceUnavailableError(
      `${mcpServerDisplayName(server)} signs in through the app Opengeni runs in, which automations can't use for events`,
    );
  }
  const visible = await visibleMcpAccountConnections(deps.db, {
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    source: { kind: "subject", subjectId: owner, accountId: source.accountId },
  });
  const bindings = mcpAccountBindingsFromVisibleConnections({
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    subjectId: owner,
    servers: [server],
    connections: visible,
  });
  const binding = source.connectionId
    ? bindings.find((candidate) => candidate.connectionId === source.connectionId)
    : bindings[0];
  if (!binding) throw new McpEventSourceUnavailableError(reconnect);
  const resolve = buildConnectionTokenResolver(deps.db, deps.settings);
  return {
    server,
    connectionId: binding.connectionId,
    refreshable: true,
    headers: async (forceRefresh) => {
      const result = await resolve({
        workspaceId: binding.originWorkspaceId,
        ...(binding.subjectScope === "subject" ? { subjectId: owner } : {}),
        serverId: server.id,
        toolName: "events",
        connectionRef: binding.connectionRef,
        destinationUrl: server.url,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      });
      if (result.status !== "ok") throw new McpEventSourceUnavailableError(reconnect);
      return { ...server.headers, ...result.headers };
    },
  };
}

/**
 * Run `use` against the source's server, connected with the events extension
 * declared. A rejected credential is refreshed and the call tried once more.
 */
export async function withMcpEventSourceClient<T>(
  deps: McpEventSourceClientDeps,
  source: McpEventSourceTarget,
  use: (client: McpStreamableHttpClient, connection: McpEventSourceConnection) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const resolved = await resolveServer(deps, source);
  const timeoutMs = Math.min(resolved.server.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000);
  const transport =
    deps.fetch ?? createPinnedIntegrationTransport({ network: deps.settings }).fetch;
  const bounded: McpEventsFetch = async (url, init) =>
    boundMcpResponseBody(await transport(url.toString(), init), MCP_MAX_RESPONSE_BYTES);
  const attempt = async (forceRefresh: boolean) =>
    await withMcpStreamableHttpClient(
      {
        url: resolved.server.url,
        clientName: "opengeni-events",
        clientVersion: "0.1.0",
        timeoutMs: options.timeoutMs ?? timeoutMs,
        requestInit: { headers: await resolved.headers(forceRefresh) },
        fetch: withMcpEventNameHeader(bounded),
        capabilities: MCP_EVENTS_CLIENT_CAPABILITIES,
      },
      (client) => use(client, { server: resolved.server, connectionId: resolved.connectionId }),
    );
  try {
    return await attempt(false);
  } catch (error) {
    if (!resolved.refreshable || classifyMcpEventsError(error).kind !== "unauthorized") throw error;
  }
  return await attempt(true);
}
