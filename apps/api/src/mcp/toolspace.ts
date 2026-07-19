import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { environmentsEncryptionKeyBytes, type McpServerConfig } from "@opengeni/config";
import { prefixedMcpToolName, type AccessGrant, type ToolRef } from "@opengeni/contracts";
import {
  hasPermission,
  settingsWithEnabledCapabilityMcpServers,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  admitToolspaceTurnAttempt,
  buildConnectionTokenResolver,
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  requireSession,
  reserveToolspaceCallForTurn,
  type ResolveConnectionCredentialResult,
  type ToolspaceTurnAttemptClaims,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced } from "@opengeni/events";
import { undiciFetch } from "@opengeni/network";
import {
  MCP_MAX_AGGREGATE_TOOL_LIST_BYTES,
  MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES,
  MCP_MAX_CONCURRENT_SERVER_OPERATIONS,
  MCP_MAX_TOOL_RESULT_BYTES,
  McpAggregateToolListBudget,
  McpPayloadTooLargeError,
  assertMcpPayloadWithinBytes,
  assertMcpServerSelectionWithinBounds,
  assertMcpToolListWithinBounds,
  boundedParallelMap,
  cancelMcpResponseBody,
  guardedMcpFetch,
  mcpSerializedSizeBytes,
} from "@opengeni/runtime/mcp-network";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

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
const TOOLSPACE_AUTH_NEEDED_MESSAGE =
  "Authentication required - a connection link was posted to the session.";
const TOOLSPACE_NO_ACTIVE_TURN_MESSAGE =
  "no active turn - toolspace calls require an in-flight turn";
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
const TOOLSPACE_TOOL_LIST_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export type ToolListingEntry = {
  serverId: string;
  tool: McpTool;
  requireApproval: McpServerConfig["requireApproval"];
};

type ToolListCacheValue = {
  expiresAt: number;
  entries: ToolListingEntry[];
  sizeBytes: number;
};

/** Deterministic LRU bounded by both key count and serialized retained bytes. */
export class ToolspaceToolListCache {
  private readonly values = new Map<string, ToolListCacheValue>();
  private retainedBytes = 0;

  constructor(
    private readonly maxEntries = TOOLSPACE_TOOL_LIST_CACHE_MAX_ENTRIES,
    private readonly maxBytes = TOOLSPACE_TOOL_LIST_CACHE_MAX_BYTES,
    private readonly ttlMs = TOOLSPACE_TOOL_LIST_TTL_MS,
  ) {
    if (maxEntries < 1 || maxBytes < 1 || ttlMs < 1) {
      throw new Error("toolspace cache limits must be positive");
    }
  }

  read(key: string, now = Date.now()): ToolListingEntry[] | null {
    const hit = this.values.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now) {
      this.delete(key);
      return null;
    }
    this.values.delete(key);
    this.values.set(key, hit);
    return hit.entries;
  }

  write(key: string, entries: ToolListingEntry[], now = Date.now()): boolean {
    this.delete(key);
    const sizeBytes = Buffer.byteLength(key) + mcpSerializedSizeBytes(entries);
    if (sizeBytes > this.maxBytes) return false;

    for (const [existingKey, value] of this.values) {
      if (value.expiresAt <= now) this.delete(existingKey);
    }
    while (this.values.size >= this.maxEntries || this.retainedBytes + sizeBytes > this.maxBytes) {
      const oldestKey = this.values.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
    this.values.set(key, {
      expiresAt: now + this.ttlMs,
      entries,
      sizeBytes,
    });
    this.retainedBytes += sizeBytes;
    return true;
  }

  clear(): void {
    this.values.clear();
    this.retainedBytes = 0;
  }

  snapshot(): { entries: number; bytes: number; keys: string[] } {
    return {
      entries: this.values.size,
      bytes: this.retainedBytes,
      keys: [...this.values.keys()],
    };
  }

  private delete(key: string): void {
    const existing = this.values.get(key);
    if (!existing) return;
    this.values.delete(key);
    this.retainedBytes -= existing.sizeBytes;
  }
}

const toolListCache = new ToolspaceToolListCache();

export function isToolspaceGrant(settings: ApiRouteDeps["settings"], grant: AccessGrant): boolean {
  return (
    settings.toolspaceEnabled &&
    hasPermission(grant.permissions, "toolspace:call") &&
    isUuid(grant.metadata?.sessionId) &&
    isUuid(grant.metadata.turnId) &&
    isUuid(grant.metadata.attemptId) &&
    Number.isInteger(grant.metadata.executionGeneration) &&
    (grant.metadata.executionGeneration as number) > 0
  );
}

export async function prepareToolspaceMcpSurface(input: {
  deps: ApiRouteDeps;
  grant: AccessGrant;
}): Promise<ToolspaceMcpSurface | null> {
  const { deps, grant } = input;
  if (!isToolspaceGrant(deps.settings, grant)) {
    return null;
  }
  const claims = toolspaceClaims(grant);
  const sessionId = claims.sessionId;
  if (!(await admitToolspaceTurnAttempt(deps.db, grant.workspaceId, claims))) {
    return emptyToolspaceSurface(sessionId, grant.subjectId);
  }
  const session = await requireSession(deps.db, grant.workspaceId, sessionId);
  const selectedIds = selectedMcpServerIds(
    session.tools,
    session.mcpServers.map((server) => server.id),
  );
  // Proxyable ids: everything selected except the first-party OpenGeni tool
  // server and the first-party MCP proxies, both of which would re-enter /mcp.
  const proxyableIds = [...selectedIds].filter((id) => toolspaceCanProxyServerId(id));
  assertMcpServerSelectionWithinBounds(proxyableIds);
  if (proxyableIds.length === 0) {
    return emptyToolspaceSurface(sessionId, grant.subjectId);
  }

  // The registry (decrypted session servers + capability/pack expansion) is a
  // handful of DB reads with no upstream dials. Build it at most once per
  // request, and only when we actually need it (a cache-miss listing or a real
  // tools/call), so a cache-hit request does no registry work.
  let registryPromise: Promise<Map<string, McpServerConfig>> | null = null;
  const getRegistry = () =>
    (registryPromise ??= buildToolspaceRegistry(deps, grant.workspaceId, sessionId));

  const listing = await resolveToolListing({
    deps,
    grant,
    sessionId,
    proxyableIds,
    getRegistry,
  });
  const tools = listing.map((entry) =>
    toolspaceToolFor({ deps, grant, claims, entry, getRegistry }),
  );

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
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
    deps.db,
    workspaceId,
    deps.settings,
  );
  const withSessionServers = await settingsWithSessionMcpServersForToolspace(
    deps,
    workspaceId,
    sessionId,
    runtimeSettings,
  );
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
  getRegistry: () => Promise<Map<string, McpServerConfig>>;
}): Promise<ToolListingEntry[]> {
  const { deps, grant, sessionId, proxyableIds, getRegistry } = input;
  const cacheKey = await toolListCacheKey(deps, grant.workspaceId, sessionId, proxyableIds);
  const cached = readToolListCache(cacheKey);
  if (cached) {
    return cached;
  }
  const registry = await getRegistry();
  const aggregateBudget = new McpAggregateToolListBudget(
    "aggregate Toolspace tool list",
    MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES,
    MCP_MAX_AGGREGATE_TOOL_LIST_BYTES,
  );
  const perServer = await boundedParallelMap(
    proxyableIds,
    MCP_MAX_CONCURRENT_SERVER_OPERATIONS,
    async (serverId) => {
      const config = registry.get(serverId);
      if (!config || !toolspaceCanProxyServer(config)) {
        return { serverId, entries: [] as ToolListingEntry[] };
      }
      const connection = await connectToolspaceServer({ deps, grant, config, sessionId }).catch(
        () => null,
      );
      if (!connection) {
        return { serverId, entries: [] as ToolListingEntry[] };
      }
      try {
        const listed = await connection.client
          .listTools(undefined, toolspaceRequestOptions(config))
          .catch(() => ({ tools: [] }));
        let boundedTools: readonly McpTool[];
        try {
          boundedTools = assertMcpToolListWithinBounds(listed.tools as McpTool[]) as McpTool[];
        } catch (error) {
          deps.observability?.warn("toolspace upstream tool list exceeded safety limit", {
            serverId,
            errorClass: error instanceof Error ? error.name : typeof error,
          });
          return { serverId, entries: [] as ToolListingEntry[] };
        }
        const entries = boundedTools
          .filter((tool) => Boolean(tool?.name) && allowedByConfig(config, tool.name))
          .map((tool) => ({
            serverId,
            tool,
            requireApproval: config.requireApproval,
          }));
        return { serverId, entries };
      } finally {
        await connection.close();
      }
    },
  );
  const entries: ToolListingEntry[] = [];
  for (const result of perServer) {
    aggregateBudget.replace(result.serverId, result.entries);
    entries.push(...result.entries);
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
  return toolListCache.read(key);
}

function writeToolListCache(key: string, entries: ToolListingEntry[]): void {
  toolListCache.write(key, entries);
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
        ...(server.requireApproval !== undefined
          ? { requireApproval: server.requireApproval }
          : {}),
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
  // Credential resolution wraps the pinned transport. This keeps the guard as
  // the final network call after headers have been resolved.
  const baseFetch = guardedMcpFetch(input.deps.settings, undiciFetch);
  const credentialFetch: FetchLike = input.config.connectionRef
    ? connectionBrokerFetch(baseFetch, input)
    : baseFetch;
  const client = new Client(
    { name: `opengeni-toolspace-${input.config.id}`, version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(input.config.url), {
    fetch: credentialFetch,
    requestInit: {
      headers: toolspaceServerHeaders(input.config),
    },
  });
  try {
    await client.connect(transport as unknown as Transport, toolspaceRequestOptions(input.config));
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
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
  claims: ToolspaceTurnAttemptClaims;
  entry: ToolListingEntry;
  getRegistry: () => Promise<Map<string, McpServerConfig>>;
}): ToolspaceRegisteredTool {
  const { deps, grant, claims, entry, getRegistry } = input;
  const { sessionId } = claims;
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
      const reservation = await reserveActiveTurnCall(deps, grant.workspaceId, claims);
      if (reservation.status === "no_active_turn") {
        return mcpError(TOOLSPACE_NO_ACTIVE_TURN_MESSAGE);
      }
      if (reservation.status === "budget_exhausted") {
        return mcpError(
          `toolspace call budget exhausted (${deps.settings.toolspaceMaxCallsPerTurn}/turn)`,
        );
      }
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
      const callId = crypto.randomUUID();
      const created = await appendAndPublishTurnEventsFenced(
        deps.db,
        deps.bus,
        grant.workspaceId,
        sessionId,
        claims.turnId,
        claims.executionGeneration,
        claims.attemptId,
        [
          {
            type: "agent.toolCall.created",
            producerId: grant.subjectId,
            payload: {
              id: callId,
              name,
              arguments: toolspaceAuditSummary(args),
              origin: "toolspace",
              subjectId: grant.subjectId,
              raw: {
                type: "toolspace_call",
                serverId,
                toolName: tool.name,
              },
            },
          },
        ],
      );
      if (!created.accepted) {
        return mcpError(TOOLSPACE_NO_ACTIVE_TURN_MESSAGE);
      }
      const connection = await connectToolspaceServer({ deps, grant, config, sessionId }).catch(
        () => null,
      );
      if (!connection) {
        return mcpError(`upstream tool failed: ${name}`);
      }
      try {
        const output = await callRemoteTool(deps, connection, tool.name, args);
        const appended = await appendAndPublishTurnEventsFenced(
          deps.db,
          deps.bus,
          grant.workspaceId,
          sessionId,
          claims.turnId,
          claims.executionGeneration,
          claims.attemptId,
          [
            {
              type: "agent.toolCall.output",
              producerId: grant.subjectId,
              payload: {
                id: callId,
                output: toolspaceAuditSummary(output),
                origin: "toolspace",
                subjectId: grant.subjectId,
              },
            },
          ],
        );
        return appended.accepted ? output : mcpError(TOOLSPACE_NO_ACTIVE_TURN_MESSAGE);
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
    const output = (await server.client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      undefined,
      toolspaceRequestOptions(server.config),
    )) as ToolspaceCallResult;
    assertMcpPayloadWithinBytes(output, MCP_MAX_TOOL_RESULT_BYTES, "MCP tool result");
    return output;
  } catch (error) {
    if (error instanceof McpPayloadTooLargeError) {
      deps.observability?.warn("toolspace upstream tool result exceeded safety limit", {
        serverId: server.config.id,
        toolName,
        errorClass: error.name,
      });
      return mcpError("upstream tool result exceeded the safety limit");
    }
    if (isToolspaceAuthNeededError(error)) {
      return mcpError(TOOLSPACE_AUTH_NEEDED_MESSAGE);
    }
    // Raw provider messages can contain echoed request/credential material.
    // Keep only a stable error class in logs and return a generic result.
    deps.observability?.warn("toolspace upstream tool call failed", {
      serverId: server.config.id,
      toolName,
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return mcpError(`upstream tool failed: ${prefixedMcpToolName(server.config.id, toolName)}`);
  }
}

function toolspaceAuditSummary(value: unknown): {
  redacted: true;
  sizeBytes: number;
  sha256: string;
} {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    serialized = "[unserializable]";
  }
  return {
    redacted: true,
    sizeBytes: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

type ToolspaceReservation =
  | { status: "ok" }
  | { status: "no_active_turn" }
  | { status: "budget_exhausted" };

async function reserveActiveTurnCall(
  deps: ApiRouteDeps,
  workspaceId: string,
  claims: ToolspaceTurnAttemptClaims,
): Promise<ToolspaceReservation> {
  const reservation = await reserveToolspaceCallForTurn(
    deps.db,
    workspaceId,
    claims,
    deps.settings.toolspaceMaxCallsPerTurn,
  );
  if (reservation.reserved) {
    return { status: "ok" };
  }
  return reservation.reason === "inactive"
    ? { status: "no_active_turn" }
    : { status: "budget_exhausted" };
}

function toolspaceClaims(grant: AccessGrant): ToolspaceTurnAttemptClaims {
  return {
    sessionId: grant.metadata!.sessionId as string,
    turnId: grant.metadata!.turnId as string,
    attemptId: grant.metadata!.attemptId as string,
    executionGeneration: grant.metadata!.executionGeneration as number,
  };
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
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

function mcpToolRequiresApproval(
  policy: McpServerConfig["requireApproval"],
  unprefixedName: string,
): boolean {
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

function toolspaceRequestOptions(config: McpServerConfig): {
  timeout?: number;
  maxTotalTimeout?: number;
} {
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
    const destinationUrl = new URL(requestInput.toString()).toString();
    const first = await resolveCredential({
      workspaceId: input.grant.workspaceId,
      serverId: input.config.id,
      connectionRef,
      destinationUrl,
      forceRefresh: false,
      ...(request.toolName ? { toolId: request.toolName } : {}),
      subjectId: input.grant.subjectId,
    });
    if (first.status === "auth_needed") {
      return await authNeededFetchResponse(input, request, first);
    }
    const response = await baseFetch(
      fetchInputForAttempt(requestInput),
      withConnectionHeaders(requestInput, init, first.headers),
    );
    if (response.status === 401) {
      await cancelMcpResponseBody(response);
      const refreshed = await resolveCredential({
        workspaceId: input.grant.workspaceId,
        serverId: input.config.id,
        connectionRef,
        destinationUrl,
        forceRefresh: true,
        ...(request.toolName ? { toolId: request.toolName } : {}),
        subjectId: input.grant.subjectId,
      });
      if (refreshed.status === "auth_needed") {
        return await authNeededFetchResponse(input, request, refreshed);
      }
      const retry = await baseFetch(
        fetchInputForAttempt(requestInput),
        withConnectionHeaders(requestInput, init, refreshed.headers),
      );
      if (retry.status === 401) {
        await cancelMcpResponseBody(retry);
        return await authNeededFetchResponse(
          input,
          request,
          authNeededFromStatus(input.config, refreshed, "expired"),
        );
      }
      if (retry.status === 403) {
        const auth = insufficientScopeAuth(retry.headers, connectionRef, refreshed.connectionId);
        if (auth) {
          await cancelMcpResponseBody(retry);
          return await authNeededFetchResponse(input, request, auth);
        }
      }
      return retry;
    }
    if (response.status === 403) {
      const auth = insufficientScopeAuth(response.headers, connectionRef, first.connectionId);
      if (auth) {
        await cancelMcpResponseBody(response);
        return await authNeededFetchResponse(input, request, auth);
      }
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
  const claims = toolspaceClaims(input.grant);
  const appended = await appendAndPublishTurnEventsFenced(
    input.deps.db,
    input.deps.bus,
    input.grant.workspaceId,
    input.sessionId,
    claims.turnId,
    claims.executionGeneration,
    claims.attemptId,
    [
      {
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
      },
    ],
  ).catch(() => null);
  if (!appended?.accepted) {
    return toolspaceInactiveFetchResponse(request);
  }
  if (request.method === "tools/call") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: {
          code: TOOLSPACE_AUTH_NEEDED_ERROR_CODE,
          message: TOOLSPACE_AUTH_NEEDED_MESSAGE,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return new Response("Authentication required for MCP server connection", { status: 401 });
}

function toolspaceInactiveFetchResponse(request: McpRequestInfo): Response {
  if (request.method === "tools/call") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32000, message: TOOLSPACE_NO_ACTIVE_TURN_MESSAGE },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return new Response(TOOLSPACE_NO_ACTIVE_TURN_MESSAGE, { status: 401 });
}

async function mcpRequestInfo(_input: string | URL, init?: RequestInit): Promise<McpRequestInfo> {
  const body = typeof init?.body === "string" ? init.body : "";
  if (!body) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as {
      id?: unknown;
      method?: unknown;
      params?: { name?: unknown };
    };
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    const id =
      typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null
        ? parsed.id
        : undefined;
    const toolName =
      method === "tools/call" && typeof parsed.params?.name === "string"
        ? parsed.params.name
        : undefined;
    return {
      ...(method ? { method } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(toolName ? { toolName } : {}),
    };
  } catch {
    return {};
  }
}

function withConnectionHeaders(
  _input: string | URL,
  init: RequestInit | undefined,
  authHeaders: Record<string, string>,
): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(authHeaders)) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

function fetchInputForAttempt(input: string | URL): string | URL {
  return input;
}

function insufficientScopeAuth(
  headers: Headers,
  connectionRef: NonNullable<McpServerConfig["connectionRef"]>,
  connectionId: string,
): Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }> | null {
  const challenge = parseWwwAuthenticate(headers.get("www-authenticate"));
  if (challenge.error !== "insufficient_scope") {
    return null;
  }
  return {
    status: "auth_needed",
    reason: "insufficient_scope",
    providerDomain: connectionRef.providerDomain,
    connectionId,
    ...(challenge.scope?.length
      ? { scopes: challenge.scope }
      : connectionRef.scopes
        ? { scopes: connectionRef.scopes }
        : {}),
    ...(challenge.resource
      ? { resource: challenge.resource }
      : connectionRef.resource
        ? { resource: connectionRef.resource }
        : {}),
  };
}

function parseWwwAuthenticate(header: string | null): {
  error?: string;
  scope?: string[];
  resource?: string;
} {
  if (!header) return {};
  const bearerIndex = header.toLowerCase().indexOf("bearer");
  if (bearerIndex < 0) return {};
  const params: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]+)/g;
  const paramsText = header.slice(bearerIndex + "bearer".length);
  let match: RegExpExecArray | null;
  while ((match = re.exec(paramsText)) !== null) {
    const raw = match[2]!;
    params[match[1]!.toLowerCase()] = raw.startsWith('"')
      ? raw.slice(1, -1).replace(/\\"/g, '"')
      : raw;
  }
  return {
    ...(params.error ? { error: params.error } : {}),
    ...(params.scope ? { scope: params.scope.split(/\s+/).filter(Boolean) } : {}),
    ...(params.resource ? { resource: params.resource } : {}),
  };
}

function isToolspaceAuthNeededError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as { code?: unknown }).code === TOOLSPACE_AUTH_NEEDED_ERROR_CODE ||
      error.message.includes(TOOLSPACE_AUTH_NEEDED_MESSAGE))
  );
}
