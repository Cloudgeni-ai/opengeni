import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { environmentsEncryptionKeyBytes, type McpServerConfig } from "@opengeni/config";
import {
  prefixedMcpToolName,
  type AccessGrant,
  type McpPersonalConnectionDelegation,
  type SessionTurn,
  type ToolRef,
} from "@opengeni/contracts";
import {
  hasPermission,
  withFrozenPersonalConnectionDelegations,
  settingsWithEnabledCapabilityMcpServers,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  buildHostConnectionTokenResolver,
  clearPendingSessionToolspaceCall,
  getActiveSessionTurnForExecution,
  getSessionRootId,
  getWorkspaceGrant,
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  registerPendingSessionToolCall,
  requireSession,
  reserveToolspaceCallForAttempt,
  type ResolveConnectionCredentialResult,
} from "@opengeni/db";
import { appendAndPublishEvents, appendAndPublishTurnEventsFenced } from "@opengeni/events";
import { undiciFetch, type FetchLike } from "@opengeni/network";
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
  mcpJsonRpcErrorPayloadForRequest,
  mcpRequestReplayInfo,
  mcpSerializedSizeBytes,
  type McpRequestReplayInfo,
} from "@opengeni/runtime/mcp-network";
import { Buffer } from "node:buffer";

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
const TOOLSPACE_AUTH_NEEDED_ERROR = {
  // OpenGeni application-defined JSON-RPC code. Keep this positive so it cannot
  // collide with MCP SDK transport errors such as RequestTimeout (-32001).
  code: 40_101,
  message: "Authentication required - a connection link was posted to the session.",
} as const;
const TOOLSPACE_TOOL_OUTCOME_UNCERTAIN_ERROR = {
  code: 40_102,
  message:
    "Tool outcome uncertain: the provider returned 401 after receiving the request. OpenGeni did not replay this call. Do not retry automatically; verify provider state before any new attempt.",
} as const;
const TOOLSPACE_NO_ACTIVE_TURN_MESSAGE =
  "no active turn - toolspace calls require an in-flight turn";
// First-party OpenGeni MCP proxies (files/docs) route back through the same
// /mcp mount. They are excluded from the toolspace surface by construction so a
// toolspace principal can never re-enter /mcp as a first-party caller, even if
// a future grant carried files:read / documents:search (see docs invariants).
// Codex Apps is also excluded: its dynamic designated-owner authorization and
// wire sanitizer live on the model MCP path and must never degrade into static
// Toolspace headers.
const FIRST_PARTY_PROXY_IDS = new Set(["files", "docs", "codex_apps"]);
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
    const sizeBytes = Buffer.byteLength(key) + mcpSerializedSizeBytes(entries);
    if (sizeBytes > this.maxBytes) return false;
    // A rejected replacement is a no-op: preserve the current safe value
    // until the candidate has passed its own size check.
    this.delete(key);
    for (const [existingKey, value] of this.values) {
      if (value.expiresAt <= now) this.delete(existingKey);
    }
    while (this.values.size >= this.maxEntries || this.retainedBytes + sizeBytes > this.maxBytes) {
      const oldestKey = this.values.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
    this.values.set(key, { expiresAt: now + this.ttlMs, entries, sizeBytes });
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

type ToolspaceAuthority = {
  sessionId: string;
};

type ToolspaceAttemptAuthority = ToolspaceAuthority & {
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

function toolspaceAuthorityForGrant(grant: AccessGrant): ToolspaceAuthority | null {
  const sessionId = grant.metadata?.sessionId;
  return typeof sessionId === "string" ? { sessionId } : null;
}

export function isToolspaceGrant(settings: ApiRouteDeps["settings"], grant: AccessGrant): boolean {
  return (
    settings.toolspaceEnabled &&
    hasPermission(grant.permissions, "toolspace:call") &&
    toolspaceAuthorityForGrant(grant) !== null
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
  const authority = toolspaceAuthorityForGrant(grant);
  if (!authority) {
    return null;
  }
  const { sessionId } = authority;
  const activeTurn = await getActiveSessionTurnForExecution(deps.db, grant.workspaceId, sessionId);
  // Recovering/waiting-capacity attempts retain ownership pointers, but they
  // are not currently executing model code. Do not even enumerate upstream
  // tools until the turn has returned to the running state.
  if (!activeTurn?.activeAttemptId || activeTurn.status !== "running") {
    return emptyToolspaceSurface(sessionId, grant.subjectId);
  }
  const attemptAuthority: ToolspaceAttemptAuthority = {
    sessionId,
    turnId: activeTurn.id,
    attemptId: activeTurn.activeAttemptId,
    executionGeneration: activeTurn.executionGeneration,
  };
  const session = await requireSession(deps.db, grant.workspaceId, sessionId);
  const personalConnectionDelegations = activeTurn.personalConnectionDelegations;
  let rootSessionId = sessionId;
  if (deps.connectionCredentials?.mcpCredentials) {
    const resolvedRootSessionId = await getSessionRootId(deps.db, grant.workspaceId, sessionId);
    if (!resolvedRootSessionId) {
      throw new Error(`cannot resolve host MCP credentials for missing session ${sessionId}`);
    }
    rootSessionId = resolvedRootSessionId;
  }
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
  const registryPromises = new Map<string, Promise<Map<string, McpServerConfig>>>();
  const getRegistry = (attemptId: string) => {
    const existing = registryPromises.get(attemptId);
    if (existing) {
      return existing;
    }
    const created = buildToolspaceRegistry(deps, grant.workspaceId, sessionId, attemptId);
    registryPromises.set(attemptId, created);
    return created;
  };

  const listing = await resolveToolListing({
    deps,
    grant,
    sessionId,
    rootSessionId,
    proxyableIds,
    activeTurn,
    personalConnectionDelegations,
    getRegistry: () => getRegistry(attemptAuthority.attemptId),
  });
  const tools = listing.map((entry) =>
    toolspaceToolFor({
      deps,
      grant,
      authority: attemptAuthority,
      rootSessionId,
      entry,
      personalConnectionDelegations,
      getRegistry,
    }),
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
  attemptId: string,
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
    attemptId,
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
  rootSessionId: string;
  proxyableIds: string[];
  activeTurn: SessionTurn;
  personalConnectionDelegations: McpPersonalConnectionDelegation[];
  getRegistry: () => Promise<Map<string, McpServerConfig>>;
}): Promise<ToolListingEntry[]> {
  const {
    deps,
    grant,
    sessionId,
    rootSessionId,
    proxyableIds,
    activeTurn,
    personalConnectionDelegations,
    getRegistry,
  } = input;
  // Host credentials can be initiator-specific. A prior turn's tool list must
  // never be reused under a different frozen authority in the same session.
  const cacheKey = await toolListCacheKey(
    deps,
    grant.workspaceId,
    sessionId,
    proxyableIds,
    activeTurn,
  );
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
  const entries: ToolListingEntry[] = [];
  // Each mapper commits its source contribution synchronously immediately
  // after the upstream result is bounded. No per-provider result arrays are
  // retained by boundedParallelMap, and a failed aggregate replacement never
  // reaches the cache or the exposed MCP surface.
  await boundedParallelMap(proxyableIds, MCP_MAX_CONCURRENT_SERVER_OPERATIONS, async (serverId) => {
    const config = registry.get(serverId);
    if (!config || !toolspaceCanProxyServer(config)) {
      aggregateBudget.replace(serverId, []);
      return;
    }
    const connection = await connectToolspaceServer({
      deps,
      grant,
      config,
      sessionId,
      rootSessionId,
      turn: activeTurn,
      personalConnectionDelegations,
    }).catch((error) => {
      deps.observability?.warn(
        "toolspace upstream connection failed",
        toolspacePublicErrorFields(error),
      );
      return null;
    });
    if (!connection) {
      aggregateBudget.replace(serverId, []);
      return;
    }
    try {
      const listed = await connection.client
        .listTools(undefined, toolspaceRequestOptions(config))
        .catch((error) => {
          deps.observability?.warn(
            "toolspace upstream tool list failed",
            toolspacePublicErrorFields(error),
          );
          return { tools: [] };
        });
      let boundedTools: readonly McpTool[];
      try {
        boundedTools = assertMcpToolListWithinBounds(listed.tools as McpTool[]) as McpTool[];
      } catch (error) {
        deps.observability?.warn(
          "toolspace upstream tool list exceeded safety limit",
          toolspacePublicErrorFields(error, "tool_list_too_large"),
        );
        aggregateBudget.replace(serverId, []);
        return;
      }
      const sourceEntries = boundedTools
        .filter((tool) => Boolean(tool?.name) && allowedByConfig(config, tool.name))
        .map((tool) => ({
          serverId,
          tool,
          requireApproval: config.requireApproval,
        }));
      aggregateBudget.replace(serverId, sourceEntries);
      entries.push(...sourceEntries);
    } finally {
      await connection.close();
    }
  });
  writeToolListCache(cacheKey, entries);
  return entries;
}

async function toolListCacheKey(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
  proxyableIds: string[],
  turn: SessionTurn,
): Promise<string> {
  const metadata = await listSessionMcpServerMetadata(deps.db, workspaceId, sessionId);
  const versions = new Map(metadata.map((server) => [server.id, server.credentialVersion]));
  const signature = proxyableIds
    .slice()
    .sort()
    .map((id) => `${id}@${versions.get(id) ?? 0}`)
    .join(",");
  const authority = JSON.stringify({
    turnId: turn.id,
    executionGeneration: turn.executionGeneration,
    attemptId: turn.activeAttemptId,
    initiator: turn.initiator,
  });
  return `${workspaceId}:${sessionId}:${signature}:${authority}`;
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
  attemptId: string,
  settings: ApiRouteDeps["settings"],
): Promise<ApiRouteDeps["settings"]> {
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!encryptionKey) {
    const metadata = await listSessionMcpServerMetadata(deps.db, workspaceId, sessionId);
    if (metadata.length === 0) {
      return settings;
    }
    if (metadata.some((server) => server.headerNames.length > 0)) {
      throw new Error(
        "session MCP server credentials require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
      );
    }
  }
  const servers = await listSessionMcpServersForRun(
    deps.db,
    workspaceId,
    sessionId,
    attemptId,
    encryptionKey ?? null,
  );
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
        ...(server.connectionRef ? { connectionRef: server.connectionRef } : {}),
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
  rootSessionId: string;
  turn: SessionTurn;
  personalConnectionDelegations: McpPersonalConnectionDelegation[];
}): Promise<ConnectedToolspaceServer> {
  // npm Undici's dispatcher transport is not reliable under Bun. The worker's
  // model-visible MCP path already uses Bun's native fetch while retaining the
  // same pre-request destination-policy check; Toolspace must do the same or an
  // embedded Bun API can expose a server to the model while silently dropping
  // that exact server from `ogtool list`.
  const useBunNativeFetch = !!process.versions.bun;
  const mcpFetchImpl: FetchLike = useBunNativeFetch
    ? globalThis.fetch.bind(globalThis)
    : undiciFetch;
  const guardedFetch = guardedMcpFetch(input.deps.settings, mcpFetchImpl, {
    ...(useBunNativeFetch ? { pinResolvedDestination: false } : {}),
  });
  const baseFetch: FetchLike = input.config.connectionRef
    ? connectionBrokerFetch(guardedFetch, input)
    : guardedFetch;
  const client = new Client(
    { name: `opengeni-toolspace-${input.config.id}`, version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(input.config.url), {
    ...(baseFetch !== globalThis.fetch ? { fetch: baseFetch } : {}),
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
  authority: ToolspaceAttemptAuthority;
  rootSessionId: string;
  entry: ToolListingEntry;
  personalConnectionDelegations: McpPersonalConnectionDelegation[];
  getRegistry: (attemptId: string) => Promise<Map<string, McpServerConfig>>;
}): ToolspaceRegisteredTool {
  const {
    deps,
    grant,
    authority,
    rootSessionId,
    entry,
    personalConnectionDelegations,
    getRegistry,
  } = input;
  const { sessionId } = authority;
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
      const reservation = await reserveExactAttemptCall(deps, grant, authority);
      if (reservation.status === "no_active_turn") {
        return mcpError(TOOLSPACE_NO_ACTIVE_TURN_MESSAGE);
      }
      if (reservation.status === "budget_exhausted") {
        return mcpError(
          `toolspace call budget exhausted (${deps.settings.toolspaceMaxCallsPerTurn}/turn)`,
        );
      }
      const turnId = reservation.turn.id;
      // Dial only the ONE server this tool belongs to, from the freshly-built
      // exact-attempt registry. Listing policy is descriptive only; a stale MCP
      // surface can never decide authorization for a successor attempt.
      const registry = await getRegistry(authority.attemptId);
      const config = registry.get(serverId);
      if (!config || !toolspaceCanProxyServer(config) || !allowedByConfig(config, tool.name)) {
        return mcpError(`upstream tool failed: ${name}`);
      }
      if (mcpToolRequiresApproval(config.requireApproval, tool.name)) {
        return mcpError(APPROVAL_REQUIRED_MESSAGE);
      }
      let connection: ConnectedToolspaceServer;
      try {
        connection = await connectToolspaceServer({
          deps,
          grant,
          config,
          sessionId,
          rootSessionId,
          turn: reservation.turn,
          personalConnectionDelegations,
        });
      } catch (error) {
        return mcpError(exactErrorMessage(error));
      }
      try {
        const callId = crypto.randomUUID();
        const receipt = {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          turnId,
          executionGeneration: authority.executionGeneration,
          attemptId: authority.attemptId,
          callId,
        };
        const registered = await registerPendingSessionToolCall(deps.db, {
          ...receipt,
          callType: "toolspace_call",
          callItem: {
            type: "toolspace_call",
            id: callId,
            name,
            arguments: args,
            serverId,
            toolName: tool.name,
          },
        });
        if (!registered.accepted || !registered.registered) {
          return mcpError(TOOLSPACE_NO_ACTIVE_TURN_MESSAGE);
        }
        const created = await appendAndPublishTurnEventsFenced(
          deps.db,
          deps.bus,
          grant.workspaceId,
          sessionId,
          turnId,
          authority.executionGeneration,
          authority.attemptId,
          [
            {
              type: "agent.toolCall.created",
              turnId,
              turnGeneration: authority.executionGeneration,
              turnAttemptId: authority.attemptId,
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
            },
          ],
        );
        if (!created.accepted) {
          return mcpError(TOOLSPACE_NO_ACTIVE_TURN_MESSAGE);
        }
        const output = await callRemoteTool(deps, connection, tool.name, args);
        const completed = await appendAndPublishTurnEventsFenced(
          deps.db,
          deps.bus,
          grant.workspaceId,
          sessionId,
          turnId,
          authority.executionGeneration,
          authority.attemptId,
          [
            {
              type: "agent.toolCall.output",
              turnId,
              turnGeneration: authority.executionGeneration,
              turnAttemptId: authority.attemptId,
              producerId: grant.subjectId,
              payload: {
                id: callId,
                output,
                origin: "toolspace",
                subjectId: grant.subjectId,
              },
            },
          ],
        );
        if (completed.accepted) {
          await clearPendingSessionToolspaceCall(deps.db, receipt);
        }
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
      deps.observability?.warn(
        "toolspace upstream tool result exceeded safety limit",
        toolspacePublicErrorFields(error, "tool_result_too_large"),
      );
      return mcpError("upstream tool result exceeded the safety limit");
    }
    if (isToolspaceAuthNeededError(error)) {
      return mcpError(TOOLSPACE_AUTH_NEEDED_ERROR.message);
    }
    if (isToolspaceOutcomeUncertainError(error)) {
      return mcpError(TOOLSPACE_TOOL_OUTCOME_UNCERTAIN_ERROR.message);
    }
    const message = exactErrorMessage(error);
    // The exact provider diagnostic remains the internal/model-facing tool
    // result. Public observability receives only allowlisted metadata.
    deps.observability?.warn(
      "toolspace upstream tool call failed",
      toolspacePublicErrorFields(error),
    );
    return mcpError(message);
  }
}

function exactErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ToolspacePublicErrorFields = {
  errorClass: "ToolspaceOperationError";
  errorCode: ToolspacePublicFailureCode;
  status?: number;
  origin: "toolspace";
};

type ToolspacePublicFailureCode =
  | "toolspace_operation_failed"
  | "tool_list_too_large"
  | "tool_result_too_large";

/** Allowlisted projection for public telemetry; product data stays exact. */
export function toolspacePublicErrorFields(
  error: unknown,
  errorCode: ToolspacePublicFailureCode = "toolspace_operation_failed",
): ToolspacePublicErrorFields {
  const fields: ToolspacePublicErrorFields = {
    errorClass: "ToolspaceOperationError",
    errorCode,
    origin: "toolspace",
  };
  const status =
    error && typeof error === "object"
      ? Number(
          (error as { status?: unknown; statusCode?: unknown }).status ??
            (error as { statusCode?: unknown }).statusCode,
        )
      : Number.NaN;
  if (Number.isInteger(status) && status >= 100 && status <= 599) fields.status = status;
  return fields;
}

type ToolspaceReservation =
  | { status: "ok"; turn: SessionTurn }
  | { status: "no_active_turn" }
  | { status: "budget_exhausted" };

async function reserveExactAttemptCall(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  authority: ToolspaceAttemptAuthority,
): Promise<ToolspaceReservation> {
  const reservation = await reserveToolspaceCallForAttempt(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    executionGeneration: authority.executionGeneration,
    attemptId: authority.attemptId,
    limit: deps.settings.toolspaceMaxCallsPerTurn,
  });
  if (!reservation.reserved) {
    return reservation.reason === "budget_exhausted"
      ? { status: "budget_exhausted" }
      : { status: "no_active_turn" };
  }
  return { status: "ok", turn: reservation.turn };
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
// The first-party OpenGeni tool server and files/docs proxies are excluded by
// construction because they route back through /mcp (recursion guard). Codex
// Apps is excluded because Toolspace does not own its dynamic authorization.
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

function mcpRequestDestinationUrl(input: string | URL | Request): string {
  return new URL(input instanceof Request ? input.url : input.toString()).toString();
}

export function connectionBrokerFetch(
  baseFetch: FetchLike,
  input: {
    deps: ApiRouteDeps;
    grant: AccessGrant;
    config: McpServerConfig;
    sessionId: string;
    rootSessionId: string;
    turn: SessionTurn;
    personalConnectionDelegations?: McpPersonalConnectionDelegation[];
  },
): FetchLike {
  const connectionRef = input.config.connectionRef;
  if (!connectionRef) {
    return baseFetch;
  }
  const hostCredentialPort = input.deps.connectionCredentials?.mcpCredentials;
  const rawResolveCredential = hostCredentialPort
    ? buildHostConnectionTokenResolver(hostCredentialPort, {
        accountId: input.grant.accountId,
        workspaceId: input.grant.workspaceId,
        sessionId: input.sessionId,
        rootSessionId: input.rootSessionId,
        turnId: input.turn.id,
        attemptId: input.turn.activeAttemptId,
        executionGeneration: input.turn.executionGeneration,
        initiator: input.turn.initiator,
        initiatorContext: input.turn.initiatorContext,
        surface: "toolspace",
      })
    : buildConnectionTokenResolver(input.deps.db, input.deps.settings);
  const personalDelegations = input.personalConnectionDelegations ?? [];
  const delegatedMembershipChecks = new Map<string, Promise<boolean>>();
  const delegatedOwnerHasMembership = async (subjectId: string): Promise<boolean> => {
    const existing = delegatedMembershipChecks.get(subjectId);
    if (existing) return await existing;
    const check = getWorkspaceGrant(input.deps.db, subjectId, input.grant.workspaceId).then(
      Boolean,
    );
    delegatedMembershipChecks.set(subjectId, check);
    return await check;
  };
  const resolveCredential = withFrozenPersonalConnectionDelegations({
    resolveCredential: rawResolveCredential,
    settings: { mcpServers: [input.config] },
    personalConnectionDelegations: personalDelegations,
    ownerHasWorkspaceMembership: delegatedOwnerHasMembership,
  });
  return async (requestInput, init) => {
    const request = await mcpRequestReplayInfo(requestInput, init);
    const destinationUrl = mcpRequestDestinationUrl(requestInput);
    const resolverSubjectId =
      connectionRef.subjectScope !== "subject" && hostCredentialPort
        ? input.grant.subjectId
        : undefined;
    const resolve = async (forceRefresh: boolean) => {
      const result = await resolveCredential({
        workspaceId: input.grant.workspaceId,
        serverId: input.config.id,
        connectionRef,
        destinationUrl,
        forceRefresh,
        ...(request.toolName ? { toolName: request.toolName } : {}),
        ...(resolverSubjectId ? { subjectId: resolverSubjectId } : {}),
      });
      return result;
    };
    const first = await resolve(false);
    if (first.status === "auth_needed") {
      return await authNeededFetchResponse(input, request, first);
    }
    const response = await baseFetch(
      fetchInputForAttempt(requestInput),
      withConnectionHeaders(requestInput, init, first.headers),
    );
    if (response.status === 401) {
      await cancelMcpResponseBody(response);
      let refreshed: ResolveConnectionCredentialResult;
      try {
        refreshed = await resolve(true);
      } catch {
        refreshed = authNeededFromStatus(input.config, first, "refresh_failed");
      }
      if (refreshed.status === "auth_needed") {
        if (!request.replaySafeAfter401) {
          await publishToolspaceAuthNeeded(input, request, refreshed);
          return toolspaceMcpOutcomeUncertainResponse(request);
        }
        return await authNeededFetchResponse(input, request, refreshed);
      }
      if (!request.replaySafeAfter401) {
        return toolspaceMcpOutcomeUncertainResponse(request);
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
        await cancelMcpResponseBody(retry);
        return await authNeededFetchResponse(
          input,
          request,
          authNeededFromStatus(input.config, refreshed, "insufficient_scope"),
        );
      }
      return retry;
    }
    if (response.status === 403) {
      await cancelMcpResponseBody(response);
      return await authNeededFetchResponse(
        input,
        request,
        authNeededFromStatus(input.config, first, "insufficient_scope"),
      );
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
    ...(connectionRef.provider ? { provider: connectionRef.provider } : {}),
    ...(connectionRef.subjectScope === "subject" ? {} : { connectionId: first.connectionId }),
    ...(connectionRef.scopes ? { scopes: connectionRef.scopes } : {}),
    ...(connectionRef.resource ? { resource: connectionRef.resource } : {}),
    ...(connectionRef.selectedResources
      ? { selectedResources: connectionRef.selectedResources }
      : {}),
  };
}

async function authNeededFetchResponse(
  input: {
    deps: ApiRouteDeps;
    grant: AccessGrant;
    config: McpServerConfig;
    sessionId: string;
    turn: SessionTurn;
  },
  request: McpRequestReplayInfo,
  auth: Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }>,
): Promise<Response> {
  await publishToolspaceAuthNeeded(input, request, auth);
  if (request.method === "tools/call") {
    return toolspaceMcpErrorResponse(request.id, TOOLSPACE_AUTH_NEEDED_ERROR);
  }
  return new Response("Authentication required for MCP server connection", { status: 401 });
}

async function publishToolspaceAuthNeeded(
  input: {
    deps: ApiRouteDeps;
    grant: AccessGrant;
    config: McpServerConfig;
    sessionId: string;
    turn: SessionTurn;
  },
  request: McpRequestReplayInfo,
  auth: Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }>,
): Promise<void> {
  await appendAndPublishEvents(
    input.deps.db,
    input.deps.bus,
    input.grant.workspaceId,
    input.sessionId,
    [
      {
        type: "tool.auth_needed",
        producerId: input.grant.subjectId,
        payload: {
          serverId: input.config.id,
          toolName: request.toolName ?? null,
          providerDomain: auth.providerDomain,
          ...(auth.provider ? { provider: auth.provider } : {}),
          reason: auth.reason,
          ...(auth.connectionId ? { connectionId: auth.connectionId } : {}),
          ...(auth.scopes ? { scopes: auth.scopes } : {}),
          ...(auth.resource ? { resource: auth.resource } : {}),
          ...(auth.selectedResources ? { selectedResources: auth.selectedResources } : {}),
          ...(auth.authorizationUrl ? { authorizationUrl: auth.authorizationUrl } : {}),
          subjectId: input.grant.subjectId,
        },
      },
    ],
  ).catch(() => undefined);
}

function toolspaceMcpErrorResponse(
  id: string | number | null | undefined,
  error: { code: number; message: string },
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function toolspaceMcpOutcomeUncertainResponse(request: McpRequestReplayInfo): Response {
  return new Response(
    JSON.stringify(
      mcpJsonRpcErrorPayloadForRequest(request, TOOLSPACE_TOOL_OUTCOME_UNCERTAIN_ERROR),
    ),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function withConnectionHeaders(
  input: string | URL | Request,
  init: RequestInit | undefined,
  authHeaders: Record<string, string>,
): RequestInit {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  for (const [name, value] of Object.entries(authHeaders)) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

function fetchInputForAttempt(input: string | URL | Request): string | URL | Request {
  return input instanceof Request ? input.clone() : input;
}

function isToolspaceAuthNeededError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === TOOLSPACE_AUTH_NEEDED_ERROR.code &&
    (error.message === TOOLSPACE_AUTH_NEEDED_ERROR.message ||
      error.message ===
        `MCP error ${TOOLSPACE_AUTH_NEEDED_ERROR.code}: ${TOOLSPACE_AUTH_NEEDED_ERROR.message}`)
  );
}

function isToolspaceOutcomeUncertainError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === TOOLSPACE_TOOL_OUTCOME_UNCERTAIN_ERROR.code &&
    (error.message === TOOLSPACE_TOOL_OUTCOME_UNCERTAIN_ERROR.message ||
      error.message ===
        `MCP error ${TOOLSPACE_TOOL_OUTCOME_UNCERTAIN_ERROR.code}: ${TOOLSPACE_TOOL_OUTCOME_UNCERTAIN_ERROR.message}`)
  );
}
