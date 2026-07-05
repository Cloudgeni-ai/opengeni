import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { environmentsEncryptionKeyBytes, firstPartyMcpWorkspaceUrl, type McpServerConfig } from "@opengeni/config";
import { prefixedMcpToolName, type AccessGrant, type ToolRef } from "@opengeni/contracts";
import { hasPermission, settingsWithEnabledCapabilityMcpServers, type ApiRouteDeps } from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  countToolspaceCallsForTurn,
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  requireSession,
  type ResolveConnectionCredentialResult,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";

export type ToolspaceCallResult = CallToolResult;

export type ToolspaceRegisteredTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<ToolspaceCallResult>;
};

export type ToolspaceMcpSurface = {
  sessionId: string;
  subjectId: string;
  tools: ToolspaceRegisteredTool[];
  close: () => Promise<void>;
};

type ConnectedToolspaceServer = {
  config: McpServerConfig;
  client: Client;
  close: () => Promise<void>;
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

const APPROVAL_REQUIRED_MESSAGE = "requires approval - invoke via the agent";
const TOOLSPACE_AUTH_NEEDED_ERROR_CODE = -32001;
const TOOLSPACE_AUTH_NEEDED_MESSAGE = "Authentication required - a connection link was posted to the session.";
const FIRST_PARTY_PROXY_IDS = new Set(["files", "docs"]);

export function isToolspaceGrant(settings: ApiRouteDeps["settings"], grant: AccessGrant): boolean {
  return settings.toolspaceEnabled
    && hasPermission(grant.permissions, "toolspace:call")
    && typeof grant.metadata?.sessionId === "string";
}

export async function prepareToolspaceMcpSurface(input: {
  deps: ApiRouteDeps;
  grant: AccessGrant;
  authorizationHeader?: string | null;
}): Promise<ToolspaceMcpSurface | null> {
  const { deps, grant } = input;
  if (!isToolspaceGrant(deps.settings, grant)) {
    return null;
  }
  const sessionId = grant.metadata!.sessionId as string;
  const session = await requireSession(deps.db, grant.workspaceId, sessionId);
  const selectedIds = selectedMcpServerIds(session.tools, session.mcpServers.map((server) => server.id));
  if (selectedIds.size === 0) {
    return {
      sessionId,
      subjectId: grant.subjectId,
      tools: [],
      close: async () => {},
    };
  }

  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(deps.db, grant.workspaceId, deps.settings);
  const withSessionServers = await settingsWithSessionMcpServersForToolspace(deps, grant.workspaceId, sessionId, runtimeSettings);
  const registry = new Map(withSessionServers.mcpServers.map((server) => [server.id, server]));
  const connected: ConnectedToolspaceServer[] = [];
  const tools: ToolspaceRegisteredTool[] = [];

  for (const serverId of selectedIds) {
    if (serverId === "opengeni") {
      continue;
    }
    const config = registry.get(serverId);
    if (!config || !toolspaceCanProxyServer(grant, config)) {
      continue;
    }
    const connection = await connectToolspaceServer({
      deps,
      grant,
      config,
      authorizationHeader: input.authorizationHeader ?? null,
      sessionId,
    }).catch(() => null);
    if (!connection) {
      continue;
    }
    connected.push(connection);
    const listed = await connection.client.listTools(undefined, toolspaceRequestOptions(config)).catch(() => ({ tools: [] }));
    for (const tool of listed.tools as McpTool[]) {
      if (!tool?.name || !allowedByConfig(config, tool.name)) {
        continue;
      }
      tools.push(toolspaceToolFor({
        deps,
        grant,
        sessionId,
        server: connection,
        tool,
      }));
    }
  }

  return {
    sessionId,
    subjectId: grant.subjectId,
    tools,
    close: async () => {
      await Promise.allSettled(connected.map((server) => server.close()));
    },
  };
}

async function settingsWithSessionMcpServersForToolspace(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
  settings: ApiRouteDeps["settings"],
): Promise<ApiRouteDeps["settings"]> {
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!encryptionKey) {
    const metadata = await listSessionMcpServerMetadata(deps.db, workspaceId, sessionId);
    if (metadata.length === 0) {
      return settings;
    }
    throw new Error("session MCP server credentials require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
  }
  const servers = await listSessionMcpServersForRun(deps.db, workspaceId, sessionId, encryptionKey);
  if (servers.length === 0) {
    return settings;
  }
  const sessionIds = new Set(servers.map((server) => server.id));
  return {
    ...settings,
    mcpServers: [
      ...settings.mcpServers.filter((server) => !sessionIds.has(server.id)),
      ...servers.map((server) => ({
        id: server.id,
        ...(server.name ? { name: server.name } : {}),
        url: server.url,
        ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
        cacheToolsList: server.cacheToolsList ?? false,
        ...(server.requireApproval !== undefined ? { requireApproval: server.requireApproval } : {}),
        headers: server.headers,
      })),
    ],
  };
}

async function connectToolspaceServer(input: {
  deps: ApiRouteDeps;
  grant: AccessGrant;
  config: McpServerConfig;
  authorizationHeader: string | null;
  sessionId: string;
}): Promise<ConnectedToolspaceServer> {
  const url = toolspaceServerUrl(input.deps, input.grant.workspaceId, input.config);
  const baseFetch: FetchLike = input.config.connectionRef
    ? connectionBrokerFetch(globalThis.fetch, input)
    : globalThis.fetch;
  const client = new Client({ name: `opengeni-toolspace-${input.config.id}`, version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(baseFetch !== globalThis.fetch ? { fetch: baseFetch } : {}),
    requestInit: {
      headers: toolspaceServerHeaders(input),
    },
  });
  await client.connect(transport as unknown as Transport, toolspaceRequestOptions(input.config));
  return {
    config: input.config,
    client,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

function toolspaceToolFor(input: {
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  server: ConnectedToolspaceServer;
  tool: McpTool;
}): ToolspaceRegisteredTool {
  const { deps, grant, sessionId, server, tool } = input;
  const name = prefixedMcpToolName(server.config.id, tool.name);
  const approvalRequired = mcpToolRequiresApproval(server.config.requireApproval, tool.name);
  const description = approvalRequired
    ? `${tool.description ?? tool.name} (unavailable: ${APPROVAL_REQUIRED_MESSAGE})`
    : tool.description;
  return {
    name,
    ...(description ? { description } : {}),
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    call: async (args) => {
      if (approvalRequired) {
        return mcpError(APPROVAL_REQUIRED_MESSAGE);
      }
      const turnId = await activeTurnWithinBudget(deps, grant.workspaceId, sessionId);
      if (!turnId) {
        return mcpError(`toolspace call budget exhausted (${deps.settings.toolspaceMaxCallsPerTurn}/turn)`);
      }
      const callId = crypto.randomUUID();
      await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [{
        type: "agent.toolCall.created",
        turnId,
        producerId: grant.subjectId,
        payload: {
          id: callId,
          name,
          arguments: args,
          origin: "toolspace",
          subjectId: grant.subjectId,
          raw: {
            type: "toolspace_call",
            serverId: server.config.id,
            toolName: tool.name,
          },
        },
      }]);
      const output = await callRemoteTool(server, tool.name, args);
      await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [{
        type: "agent.toolCall.output",
        turnId,
        producerId: grant.subjectId,
        payload: {
          id: callId,
          output,
          origin: "toolspace",
          subjectId: grant.subjectId,
        },
      }]);
      return output;
    },
  };
}

async function callRemoteTool(
  server: ConnectedToolspaceServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolspaceCallResult> {
  try {
    return await server.client.callTool({
      name: toolName,
      arguments: args,
    }, undefined, toolspaceRequestOptions(server.config)) as ToolspaceCallResult;
  } catch (error) {
    if (isToolspaceAuthNeededError(error)) {
      return mcpError(TOOLSPACE_AUTH_NEEDED_MESSAGE);
    }
    return mcpError(error instanceof Error ? error.message : String(error));
  }
}

async function activeTurnWithinBudget(deps: ApiRouteDeps, workspaceId: string, sessionId: string): Promise<string | null> {
  const session = await requireSession(deps.db, workspaceId, sessionId);
  if (!session.activeTurnId) {
    return null;
  }
  const used = await countToolspaceCallsForTurn(deps.db, workspaceId, sessionId, session.activeTurnId);
  return used < deps.settings.toolspaceMaxCallsPerTurn ? session.activeTurnId : null;
}

function selectedMcpServerIds(tools: ToolRef[], sessionServerIds: string[]): Set<string> {
  const out = new Set<string>(sessionServerIds);
  for (const tool of tools) {
    if (tool.kind === "mcp") {
      out.add(tool.id);
    }
  }
  return out;
}

function toolspaceCanProxyServer(grant: AccessGrant, config: McpServerConfig): boolean {
  if (config.id === "opengeni") {
    return false;
  }
  if (config.id === "docs") {
    return hasPermission(grant.permissions, "documents:search");
  }
  if (config.id === "files") {
    return hasPermission(grant.permissions, "files:read");
  }
  return true;
}

function toolspaceServerUrl(deps: ApiRouteDeps, workspaceId: string, config: McpServerConfig): string {
  if (FIRST_PARTY_PROXY_IDS.has(config.id)) {
    const base = firstPartyMcpWorkspaceUrl(deps.settings, workspaceId);
    if (config.id === "docs") {
      const url = new URL(base);
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/docs`;
      return url.toString();
    }
    return base;
  }
  return config.url;
}

function toolspaceServerHeaders(input: {
  deps: ApiRouteDeps;
  config: McpServerConfig;
  authorizationHeader: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (FIRST_PARTY_PROXY_IDS.has(input.config.id)) {
    if (input.deps.settings.authRequired && input.deps.settings.accessKey) {
      headers["x-opengeni-access-key"] = input.deps.settings.accessKey;
    }
    if (input.authorizationHeader) {
      headers.authorization = input.authorizationHeader;
    }
  }
  for (const [name, value] of Object.entries(input.config.headers ?? {})) {
    headers[name] = value;
  }
  return headers;
}

function allowedByConfig(config: McpServerConfig, toolName: string): boolean {
  return !config.allowedTools || config.allowedTools.includes(toolName);
}

function mcpToolRequiresApproval(policy: McpServerConfig["requireApproval"], unprefixedName: string): boolean {
  if (policy === true) {
    return true;
  }
  return Array.isArray(policy) && policy.includes(unprefixedName);
}

function mcpError(message: string): ToolspaceCallResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function toolspaceRequestOptions(config: McpServerConfig): { timeout?: number; maxTotalTimeout?: number } {
  return config.timeoutMs ? { timeout: config.timeoutMs, maxTotalTimeout: config.timeoutMs } : {};
}

type McpRequestInfo = {
  method?: string;
  id?: string | number | null;
  toolName?: string;
};

function connectionBrokerFetch(
  baseFetch: FetchLike,
  input: {
    deps: ApiRouteDeps;
    grant: AccessGrant;
    config: McpServerConfig;
    sessionId: string;
  },
): FetchLike {
  const connectionRef = input.config.connectionRef;
  if (!connectionRef) {
    return baseFetch;
  }
  const resolveCredential = buildConnectionTokenResolver(input.deps.db, input.deps.settings);
  return async (requestInput, init) => {
    const request = await mcpRequestInfo(requestInput, init);
    const first = await resolveCredential({
      workspaceId: input.grant.workspaceId,
      serverId: input.config.id,
      connectionRef,
      forceRefresh: false,
      ...(request.toolName ? { toolId: request.toolName } : {}),
      subjectId: input.grant.subjectId,
    });
    if (first.status === "auth_needed") {
      return await authNeededFetchResponse(input, request, first);
    }
    const response = await baseFetch(fetchInputForAttempt(requestInput), withConnectionHeaders(requestInput, init, first.headers));
    if (response.status === 401) {
      const refreshed = await resolveCredential({
        workspaceId: input.grant.workspaceId,
        serverId: input.config.id,
        connectionRef,
        forceRefresh: true,
        ...(request.toolName ? { toolId: request.toolName } : {}),
        subjectId: input.grant.subjectId,
      });
      if (refreshed.status === "auth_needed") {
        return await authNeededFetchResponse(input, request, refreshed);
      }
      return await baseFetch(fetchInputForAttempt(requestInput), withConnectionHeaders(requestInput, init, refreshed.headers));
    }
    if (response.status === 403) {
      return await authNeededFetchResponse(input, request, authNeededFromStatus(input.config, first, "insufficient_scope"));
    }
    return response;
  };
}

function authNeededFromStatus(
  config: McpServerConfig,
  first: Extract<ResolveConnectionCredentialResult, { status: "ok" }>,
  reason: Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }>["reason"],
): Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }> {
  const connectionRef = config.connectionRef!;
  return {
    status: "auth_needed",
    reason,
    providerDomain: connectionRef.providerDomain,
    connectionId: first.connectionId,
    ...(connectionRef.scopes ? { scopes: connectionRef.scopes } : {}),
    ...(connectionRef.resource ? { resource: connectionRef.resource } : {}),
  };
}

async function authNeededFetchResponse(
  input: {
    deps: ApiRouteDeps;
    grant: AccessGrant;
    config: McpServerConfig;
    sessionId: string;
  },
  request: McpRequestInfo,
  auth: Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }>,
): Promise<Response> {
  await appendAndPublishEvents(input.deps.db, input.deps.bus, input.grant.workspaceId, input.sessionId, [{
    type: "tool.auth_needed",
    producerId: input.grant.subjectId,
    payload: {
      serverId: input.config.id,
      toolName: request.toolName ?? null,
      providerDomain: auth.providerDomain,
      reason: auth.reason,
      ...(auth.connectionId ? { connectionId: auth.connectionId } : {}),
      ...(auth.scopes ? { scopes: auth.scopes } : {}),
      ...(auth.resource ? { resource: auth.resource } : {}),
      ...(auth.authorizationUrl ? { authorizationUrl: auth.authorizationUrl } : {}),
      subjectId: input.grant.subjectId,
    },
  }]).catch(() => undefined);
  if (request.method === "tools/call") {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: {
        code: TOOLSPACE_AUTH_NEEDED_ERROR_CODE,
        message: TOOLSPACE_AUTH_NEEDED_MESSAGE,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("Authentication required for MCP server connection", { status: 401 });
}

async function mcpRequestInfo(_input: string | URL, init?: RequestInit): Promise<McpRequestInfo> {
  const body = typeof init?.body === "string" ? init.body : "";
  if (!body) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as { id?: unknown; method?: unknown; params?: { name?: unknown } };
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    const id = typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null ? parsed.id : undefined;
    const toolName = method === "tools/call" && typeof parsed.params?.name === "string" ? parsed.params.name : undefined;
    return {
      ...(method ? { method } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(toolName ? { toolName } : {}),
    };
  } catch {
    return {};
  }
}

function withConnectionHeaders(_input: string | URL, init: RequestInit | undefined, authHeaders: Record<string, string>): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(authHeaders)) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

function fetchInputForAttempt(input: string | URL): string | URL {
  return input;
}

function isToolspaceAuthNeededError(error: unknown): boolean {
  return error instanceof Error
    && (((error as { code?: unknown }).code === TOOLSPACE_AUTH_NEEDED_ERROR_CODE)
      || error.message.includes(TOOLSPACE_AUTH_NEEDED_MESSAGE));
}
