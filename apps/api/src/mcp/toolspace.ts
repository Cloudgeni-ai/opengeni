import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { environmentsEncryptionKeyBytes, type McpServerConfig } from "@opengeni/config";
import { prefixedMcpToolName, type AccessGrant, type ToolRef } from "@opengeni/contracts";
import { hasPermission, settingsWithEnabledCapabilityMcpServers, type ApiRouteDeps } from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  requireSession,
  reserveToolspaceCallForTurn,
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
const TOOLSPACE_NO_ACTIVE_TURN_MESSAGE = "no active turn - toolspace calls require an in-flight turn";
// First-party OpenGeni MCP proxies (files/docs) route back through the same
// /mcp mount. They are excluded from the toolspace surface by construction so a
// toolspace principal can never re-enter /mcp as a first-party caller, even if
// a future grant carried files:read / documents:search (see docs invariants).
const FIRST_PARTY_PROXY_IDS = new Set(["files", "docs"]);
// In-process cache of the per-session upstream tool listing. Keyed on the set of
// proxyable server ids + their credential versions, so a credential rotation
// busts the entry; a short TTL bounds staleness for everything else. This is
// what keeps list-type /mcp requests (initialize, tools/list) from fanning out
// to every upstream on every call.
const TOOLSPACE_TOOL_LIST_TTL_MS = 30_000;
const TOOLSPACE_TOOL_LIST_CACHE_MAX_ENTRIES = 2_000;
const toolListCache = new Map<string, { expiresAt: number; entries: ToolListingEntry[] }>();

type ToolListingEntry = {
  serverId: string;
  tool: McpTool;
  requireApproval: McpServerConfig["requireApproval"];
};

export function isToolspaceGrant(settings: ApiRouteDeps["settings"], grant: AccessGrant): boolean {
  return settings.toolspaceEnabled
    && hasPermission(grant.permissions, "toolspace:call")
    && typeof grant.metadata?.sessionId === "string";
}

export async function prepareToolspaceMcpSurface(input: {
  deps: ApiRouteDeps;
  grant: AccessGrant;
}): Promise<ToolspaceMcpSurface | null> {
  const { deps, grant } = input;
  if (!isToolspaceGrant(deps.settings, grant)) {
    return null;
  }
  const sessionId = grant.metadata!.sessionId as string;
  const session = await requireSession(deps.db, grant.workspaceId, sessionId);
  const selectedIds = selectedMcpServerIds(session.tools, session.mcpServers.map((server) => server.id));
  // Proxyable ids: everything selected except the first-party OpenGeni tool
  // server and the first-party MCP proxies, both of which would re-enter /mcp.
  const proxyableIds = [...selectedIds].filter((id) => toolspaceCanProxyServerId(id));
  if (proxyableIds.length === 0) {
    return emptyToolspaceSurface(sessionId, grant.subjectId);
  }

  // The registry (decrypted session servers + capability/pack expansion) is a
  // handful of DB reads with no upstream dials. Build it at most once per
  // request, and only when we actually need it (a cache-miss listing or a real
  // tools/call), so a cache-hit request does no registry work.
  let registryPromise: Promise<Map<string, McpServerConfig>> | null = null;
  const getRegistry = () => (registryPromise ??= buildToolspaceRegistry(deps, grant.workspaceId, sessionId));

  const listing = await resolveToolListing({
    deps,
    grant,
    sessionId,
    proxyableIds,
    activeTurnId: session.activeTurnId ?? null,
    getRegistry,
  });
  const tools = listing.map((entry) => toolspaceToolFor({ deps, grant, sessionId, entry, getRegistry }));

  return {
    sessionId,
    subjectId: grant.subjectId,
    tools,
    // Connections are opened lazily and closed inline (per listing pass, per
    // call), so there is nothing persistent to tear down here.
    close: async () => {},
  };
}

function emptyToolspaceSurface(sessionId: string, subjectId: string): ToolspaceMcpSurface {
  return { sessionId, subjectId, tools: [], close: async () => {} };
}

async function buildToolspaceRegistry(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
): Promise<Map<string, McpServerConfig>> {
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(deps.db, workspaceId, deps.settings);
  const withSessionServers = await settingsWithSessionMcpServersForToolspace(deps, workspaceId, sessionId, runtimeSettings);
  return new Map(withSessionServers.mcpServers.map((server) => [server.id, server]));
}

// Resolve the toolspace tool listing for a request. Serves from the in-process
// cache when warm; otherwise dials the proxyable upstreams ONCE to (re)list, but
// only while a turn is active — a request with no active turn never dials an
// upstream (fix: unbudgeted fan-out). tools/call still funnels through here to
// register its tool, but with the cache warm that costs no upstream dials.
async function resolveToolListing(input: {
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  proxyableIds: string[];
  activeTurnId: string | null;
  getRegistry: () => Promise<Map<string, McpServerConfig>>;
}): Promise<ToolListingEntry[]> {
  const { deps, grant, sessionId, proxyableIds, activeTurnId, getRegistry } = input;
  const cacheKey = await toolListCacheKey(deps, grant.workspaceId, sessionId, proxyableIds);
  const cached = readToolListCache(cacheKey);
  if (cached) {
    return cached;
  }
  if (!activeTurnId) {
    return [];
  }
  const registry = await getRegistry();
  const entries: ToolListingEntry[] = [];
  for (const serverId of proxyableIds) {
    const config = registry.get(serverId);
    if (!config || !toolspaceCanProxyServer(config)) {
      continue;
    }
    const connection = await connectToolspaceServer({ deps, grant, config, sessionId }).catch(() => null);
    if (!connection) {
      continue;
    }
    try {
      const listed = await connection.client.listTools(undefined, toolspaceRequestOptions(config)).catch(() => ({ tools: [] }));
      for (const tool of listed.tools as McpTool[]) {
        if (!tool?.name || !allowedByConfig(config, tool.name)) {
          continue;
        }
        entries.push({ serverId, tool, requireApproval: config.requireApproval });
      }
    } finally {
      await connection.close();
    }
  }
  writeToolListCache(cacheKey, entries);
  return entries;
}

async function toolListCacheKey(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
  proxyableIds: string[],
): Promise<string> {
  const metadata = await listSessionMcpServerMetadata(deps.db, workspaceId, sessionId);
  const versions = new Map(metadata.map((server) => [server.id, server.credentialVersion]));
  const signature = proxyableIds
    .slice()
    .sort()
    .map((id) => `${id}@${versions.get(id) ?? 0}`)
    .join(",");
  return `${workspaceId}:${sessionId}:${signature}`;
}

function readToolListCache(key: string): ToolListingEntry[] | null {
  const hit = toolListCache.get(key);
  if (!hit) {
    return null;
  }
  if (hit.expiresAt <= Date.now()) {
    toolListCache.delete(key);
    return null;
  }
  return hit.entries;
}

function writeToolListCache(key: string, entries: ToolListingEntry[]): void {
  if (toolListCache.size >= TOOLSPACE_TOOL_LIST_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [existingKey, value] of toolListCache) {
      if (value.expiresAt <= now) {
        toolListCache.delete(existingKey);
      }
    }
    if (toolListCache.size >= TOOLSPACE_TOOL_LIST_CACHE_MAX_ENTRIES) {
      toolListCache.clear();
    }
  }
  toolListCache.set(key, { expiresAt: Date.now() + TOOLSPACE_TOOL_LIST_TTL_MS, entries });
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
  sessionId: string;
}): Promise<ConnectedToolspaceServer> {
  const baseFetch: FetchLike = input.config.connectionRef
    ? connectionBrokerFetch(globalThis.fetch, input)
    : globalThis.fetch;
  const client = new Client({ name: `opengeni-toolspace-${input.config.id}`, version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(input.config.url), {
    ...(baseFetch !== globalThis.fetch ? { fetch: baseFetch } : {}),
    requestInit: {
      headers: toolspaceServerHeaders(input.config),
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
  entry: ToolListingEntry;
  getRegistry: () => Promise<Map<string, McpServerConfig>>;
}): ToolspaceRegisteredTool {
  const { deps, grant, sessionId, entry, getRegistry } = input;
  const { serverId, tool } = entry;
  const name = prefixedMcpToolName(serverId, tool.name);
  const approvalRequired = mcpToolRequiresApproval(entry.requireApproval, tool.name);
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
      const reservation = await reserveActiveTurnCall(deps, grant.workspaceId, sessionId);
      if (reservation.status === "no_active_turn") {
        return mcpError(TOOLSPACE_NO_ACTIVE_TURN_MESSAGE);
      }
      if (reservation.status === "budget_exhausted") {
        return mcpError(`toolspace call budget exhausted (${deps.settings.toolspaceMaxCallsPerTurn}/turn)`);
      }
      const turnId = reservation.turnId;
      // Dial only the ONE server this tool belongs to, from the freshly-built
      // registry, and re-check policy against that live config (the listing may
      // have been served from a slightly stale cache entry).
      const registry = await getRegistry();
      const config = registry.get(serverId);
      if (!config || !toolspaceCanProxyServer(config) || !allowedByConfig(config, tool.name)) {
        return mcpError(`upstream tool failed: ${name}`);
      }
      if (mcpToolRequiresApproval(config.requireApproval, tool.name)) {
        return mcpError(APPROVAL_REQUIRED_MESSAGE);
      }
      const connection = await connectToolspaceServer({ deps, grant, config, sessionId }).catch(() => null);
      if (!connection) {
        return mcpError(`upstream tool failed: ${name}`);
      }
      try {
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
              serverId,
              toolName: tool.name,
            },
          },
        }]);
        const output = await callRemoteTool(deps, connection, tool.name, args);
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
      } finally {
        await connection.close();
      }
    },
  };
}

async function callRemoteTool(
  deps: ApiRouteDeps,
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
    // The raw upstream error can carry provider-specific detail; log it
    // server-side and return only a generic result to the sandbox so no header
    // or credential material can ride the message back out.
    deps.observability?.warn("toolspace upstream tool call failed", {
      serverId: server.config.id,
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return mcpError(`upstream tool failed: ${prefixedMcpToolName(server.config.id, toolName)}`);
  }
}

type ToolspaceReservation =
  | { status: "ok"; turnId: string }
  | { status: "no_active_turn" }
  | { status: "budget_exhausted" };

async function reserveActiveTurnCall(deps: ApiRouteDeps, workspaceId: string, sessionId: string): Promise<ToolspaceReservation> {
  const session = await requireSession(deps.db, workspaceId, sessionId);
  if (!session.activeTurnId) {
    return { status: "no_active_turn" };
  }
  const reservation = await reserveToolspaceCallForTurn(
    deps.db,
    workspaceId,
    sessionId,
    session.activeTurnId,
    deps.settings.toolspaceMaxCallsPerTurn,
  );
  return reservation.reserved
    ? { status: "ok", turnId: session.activeTurnId }
    : { status: "budget_exhausted" };
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

// Whether a selected server id may enter the toolspace proxy at all. The
// first-party OpenGeni tool server and the files/docs proxies are excluded by
// construction: they route back through /mcp, so admitting them would let a
// toolspace principal re-enter as a first-party caller (recursion guard).
export function toolspaceCanProxyServerId(serverId: string): boolean {
  return serverId !== "opengeni" && !FIRST_PARTY_PROXY_IDS.has(serverId);
}

function toolspaceCanProxyServer(config: McpServerConfig): boolean {
  return toolspaceCanProxyServerId(config.id);
}

// Only third-party / session / pack MCP servers reach this path (first-party
// proxies are excluded above), so headers are just the server's own configured
// or broker-injected headers. The caller's `ogd_` bearer is deliberately never
// forwarded upstream.
function toolspaceServerHeaders(config: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.headers ?? {})) {
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
