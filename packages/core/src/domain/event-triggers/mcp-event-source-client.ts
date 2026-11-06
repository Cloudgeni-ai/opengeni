import { createHash } from "node:crypto";
import { ProtocolError, SdkHttpError } from "@modelcontextprotocol/client";
import { createPinnedIntegrationTransport } from "@opengeni/capabilities";
import type { McpServerConfig, Settings } from "@opengeni/config";
import { stableJson, type McpConnectionAccountBinding } from "@opengeni/contracts";
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
  openMcpStreamableHttpSession,
  withMcpStreamableHttpClient,
  type McpStreamableHttpConnectInput,
  type McpStreamableHttpClient,
  type McpStreamableHttpSession,
} from "../mcp-streamable-http-client";
import { visibleMcpAccountConnections } from "../personal-connection-delegations";
import {
  classifyMcpEventsError,
  MCP_EVENTS_CLIENT_CAPABILITIES,
  withMcpEventNameHeader,
} from "./mcp-events-protocol";
import type { McpEventTypesMemo } from "./mcp-event-types";
import { EventSourceBlockedError, eventStatusReason } from "./status-reason";
import {
  eventSubscriptionCredentialHeaders,
  type EventSubscriptionCredentialDeps,
} from "./event-subscription-credentials";

/**
 * Connects to the MCP server behind an event source as the source's owner:
 * the same server configuration and the same sign-in the owner's chats use.
 * A connector source belongs to one person, so nothing here widens access. A
 * workspace source that listens by URL is signed in by the workspace
 * credential provider instead.
 */

export type McpEventsFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type McpEventSourceClientDeps = {
  db: Database;
  settings: Settings;
  /** Replaces the pinned integration transport, for tests. */
  fetch?: McpEventsFetch;
} & Pick<EventSubscriptionCredentialDeps, "providerFetch">;

/** The source cannot reach its server until a person acts; its reason says what to do. */
export class McpEventSourceUnavailableError extends EventSourceBlockedError {
  constructor(...reason: Parameters<typeof eventStatusReason>) {
    super(eventStatusReason(...reason));
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
> & { id?: string; mcpServerUrl?: string | null };

/** What a connection reached: the server and the owner's account it signed in with. */
export type McpEventSourceConnection = {
  server: McpServerConfig;
  /** The connection used, or null for a server that needs no sign-in. */
  connectionId: string | null;
  /** Where a kept session remembers the event types it read; absent on a one-off connection. */
  eventTypes?: McpEventTypesMemo;
};

type ResolvedServer = McpEventSourceConnection & {
  headers: (forceRefresh: boolean) => Promise<Record<string, string>>;
  refreshable: boolean;
};

/** The person a source listens as, in the source's workspace. */
export type EventSourceOwner = {
  accountId: string;
  workspaceId: string;
  ownerSubjectId: string;
};

/** The workspace's MCP servers: the deployment's and the connectors added to it. */
export async function workspaceMcpServers(
  deps: Pick<McpEventSourceClientDeps, "db" | "settings">,
  workspaceId: string,
  only?: { serverIds: readonly string[] },
): Promise<McpServerConfig[]> {
  const enabled = await listEnabledMcpCapabilityServers(
    deps.db,
    workspaceId,
    only ? { capabilityIds: [], serverIds: only.serverIds } : undefined,
  );
  const servers = settingsWithMcpCapabilityServers(deps.settings, enabled).mcpServers;
  return only ? servers.filter((server) => only.serverIds.includes(server.id)) : servers;
}

/** The owner's sign-ins to `servers`, exactly as the owner's own chats would attach them. */
export async function ownerConnectionBindings(
  deps: Pick<McpEventSourceClientDeps, "db">,
  owner: EventSourceOwner,
  servers: McpServerConfig[],
): Promise<McpConnectionAccountBinding[]> {
  const visible = await visibleMcpAccountConnections(deps.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    source: { kind: "subject", subjectId: owner.ownerSubjectId, accountId: owner.accountId },
  });
  return mcpAccountBindingsFromVisibleConnections({
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.ownerSubjectId,
    servers,
    connections: visible,
  });
}

/**
 * Request headers for `destinationUrl`, signed in with one of the owner's
 * connections. A credential that cannot be resolved means the owner has to
 * reconnect: `reconnect` says so.
 */
export function ownerConnectionHeaders(
  deps: Pick<McpEventSourceClientDeps, "db" | "settings">,
  owner: EventSourceOwner,
  server: McpServerConfig,
  binding: McpConnectionAccountBinding,
  request: { toolName: string; destinationUrl: string; reconnect: string },
): (forceRefresh: boolean) => Promise<Record<string, string>> {
  const resolve = buildConnectionTokenResolver(deps.db, deps.settings);
  return async (forceRefresh) => {
    const result = await resolve({
      workspaceId: binding.originWorkspaceId,
      ...(binding.subjectScope === "subject" ? { subjectId: owner.ownerSubjectId } : {}),
      serverId: server.id,
      toolName: request.toolName,
      connectionRef: binding.connectionRef,
      destinationUrl: request.destinationUrl,
      ...(forceRefresh ? { forceRefresh: true } : {}),
    });
    if (result.status !== "ok") {
      throw new McpEventSourceUnavailableError("reconnect", request.reconnect);
    }
    return { ...server.headers, ...result.headers };
  };
}

async function resolveServer(
  deps: McpEventSourceClientDeps,
  source: McpEventSourceTarget,
): Promise<ResolvedServer> {
  const serverId = source.mcpServerId;
  const owner = source.ownerSubjectId;
  if (source.kind === "mcp" && serverId && source.mcpServerUrl) {
    const server: McpServerConfig = {
      id: serverId,
      name: serverId,
      url: source.mcpServerUrl,
      cacheToolsList: false,
    };
    const target = {
      // A source being created is signed in under its server URL alone.
      sourceId: source.id ?? "new",
      accountId: source.accountId,
      workspaceId: source.workspaceId,
      serverId,
      serverUrl: source.mcpServerUrl,
    };
    return {
      server,
      connectionId: null,
      refreshable: true,
      headers: (forceRefresh) => eventSubscriptionCredentialHeaders(deps, target, forceRefresh),
    };
  }
  if (source.kind !== "mcp" || !serverId || !owner) {
    throw new McpEventSourceUnavailableError("unavailable", "This source is not an MCP connector");
  }
  const [server] = await workspaceMcpServers(deps, source.workspaceId, { serverIds: [serverId] });
  if (!server) {
    throw new McpEventSourceUnavailableError(
      "connector_removed",
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
      "host_sign_in",
      `${mcpServerDisplayName(server)} signs in through the app Opengeni runs in, which automations can't use for events`,
    );
  }
  const listener = {
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    ownerSubjectId: owner,
  };
  const bindings = await ownerConnectionBindings(deps, listener, [server]);
  const binding = source.connectionId
    ? bindings.find((candidate) => candidate.connectionId === source.connectionId)
    : bindings[0];
  if (!binding) throw new McpEventSourceUnavailableError("reconnect", reconnect);
  return {
    server,
    connectionId: binding.connectionId,
    refreshable: true,
    headers: ownerConnectionHeaders(deps, listener, server, binding, {
      toolName: "events",
      destinationUrl: server.url,
      reconnect,
    }),
  };
}

/**
 * Run `use` against the source's server, connected with the events extension
 * declared. A rejected credential is refreshed and the call tried once more.
 *
 * With `keepSession`, the MCP session stays open for the next call instead of
 * being closed (see {@link keptSessions}).
 */
export async function withMcpEventSourceClient<T>(
  deps: McpEventSourceClientDeps,
  source: McpEventSourceTarget,
  use: (client: McpStreamableHttpClient, connection: McpEventSourceConnection) => Promise<T>,
  options: { timeoutMs?: number; keepSession?: boolean } = {},
): Promise<T> {
  const resolved = await resolveServer(deps, source);
  const timeoutMs = Math.min(resolved.server.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000);
  const transport =
    deps.fetch ?? createPinnedIntegrationTransport({ network: deps.settings }).fetch;
  const bounded: McpEventsFetch = async (url, init) =>
    boundMcpResponseBody(await transport(url.toString(), init), MCP_MAX_RESPONSE_BYTES);
  const connectInput = {
    url: resolved.server.url,
    clientName: "opengeni-events",
    clientVersion: "0.1.0",
    timeoutMs: options.timeoutMs ?? timeoutMs,
    capabilities: MCP_EVENTS_CLIENT_CAPABILITIES,
  } satisfies Partial<McpStreamableHttpConnectInput>;
  const connection = { server: resolved.server, connectionId: resolved.connectionId };
  if (options.keepSession && source.id) {
    return await withKeptSession(
      sessionKey(source.id, resolved),
      resolved,
      (headers) => ({
        ...connectInput,
        // A kept session reads the current credential on every request, so a
        // refreshed token does not end it.
        fetch: withMcpEventNameHeader(async (url, init) => {
          // It only polls and subscribes: it never reads server-sent messages,
          // so it holds no stream open for them.
          if ((init?.method ?? "GET").toUpperCase() === "GET") {
            return new Response(null, { status: 405 });
          }
          const merged = new Headers(headers());
          new Headers(init?.headers).forEach((value, name) => merged.set(name, value));
          return await bounded(url, { ...init, headers: merged });
        }),
      }),
      (client, session) => use(client, { ...connection, eventTypes: session.eventTypes }),
    );
  }
  const attempt = async (forceRefresh: boolean) =>
    await withMcpStreamableHttpClient(
      {
        ...connectInput,
        requestInit: { headers: await resolved.headers(forceRefresh) },
        fetch: withMcpEventNameHeader(bounded),
      },
      (client) => use(client, connection),
    );
  try {
    return await attempt(false);
  } catch (error) {
    if (!resolved.refreshable || classifyMcpEventsError(error).kind !== "unauthorized") throw error;
  }
  return await attempt(true);
}

/**
 * MCP sessions kept open between subscription steps, one per source: one
 * server reached with one sign-in, shared by every subscription on it. A
 * step that finds one sends only its own requests, where a fresh connection
 * would first repeat the handshake (`server/discover`, `initialize`,
 * `notifications/initialized`) and re-read the event types.
 *
 * A session the server has forgotten (it answers 404, or 400 for a session it
 * doesn't know) is replaced by a new one and the step runs again on it, once.
 * A session that fails any other way below the protocol is dropped, so the
 * next step starts afresh. One unused for {@link KEPT_SESSION_IDLE_MS} is
 * ended. Sessions are per process: after a restart, or on another replica,
 * the first step opens a new one.
 */
type KeptSession = {
  key: string;
  /** The map entry that holds this session. */
  entry: Promise<KeptSession>;
  session: McpStreamableHttpSession;
  headers: Record<string, string>;
  eventTypes: McpEventTypesMemo;
  users: number;
  lastUsedAt: number;
  retired: boolean;
  /** Whether closing it should also end it on the server, which may still hold it. */
  terminate: boolean;
};

const KEPT_SESSION_IDLE_MS = 15 * 60_000;
const keptSessions = new Map<string, Promise<KeptSession>>();

function sessionKey(sourceId: string, resolved: ResolvedServer): string {
  return createHash("sha256")
    .update(
      stableJson([
        sourceId,
        resolved.server.url,
        resolved.connectionId,
        resolved.server.headers ?? {},
      ]),
    )
    .digest("hex");
}

/** No later step gets this session; whoever uses it last closes it. */
function retire(kept: KeptSession, options: { terminate: boolean }): void {
  kept.retired = true;
  kept.terminate = options.terminate;
  if (keptSessions.get(kept.key) === kept.entry) keptSessions.delete(kept.key);
}

function closeIdleSessions(now: number): void {
  for (const pending of keptSessions.values()) {
    void pending.then(
      (kept) => {
        if (kept.retired || kept.users > 0 || now - kept.lastUsedAt < KEPT_SESSION_IDLE_MS) return;
        retire(kept, { terminate: true });
        void kept.session.close({ terminate: true });
      },
      () => undefined,
    );
  }
}

/** End every kept session, as a process shutting down should. */
export async function closeKeptMcpEventSessions(): Promise<void> {
  const pending = [...keptSessions.values()];
  keptSessions.clear();
  await Promise.all(
    pending.map(async (entry) => {
      const kept = await entry.catch(() => null);
      if (!kept) return;
      kept.retired = true;
      await kept.session.close({ terminate: true });
    }),
  );
}

/** The server no longer has the session, or never had it. */
function sessionLost(error: unknown): boolean {
  if (!SdkHttpError.isInstance(error)) return false;
  const status = (error.data as { status?: unknown } | undefined)?.status;
  return status === 404 || status === 400;
}

function openKeptSession(
  key: string,
  connectInput: (headers: () => Record<string, string>) => McpStreamableHttpConnectInput,
  headers: Record<string, string>,
): Promise<KeptSession> {
  const holder: { kept?: KeptSession } = {};
  const pending: Promise<KeptSession> = openMcpStreamableHttpSession(
    connectInput(() => holder.kept?.headers ?? headers),
  ).then((session) => {
    holder.kept = {
      key,
      entry: pending,
      session,
      headers,
      eventTypes: { read: null, generation: null },
      users: 0,
      lastUsedAt: Date.now(),
      retired: false,
      terminate: false,
    };
    return holder.kept;
  });
  keptSessions.set(key, pending);
  pending.catch(() => {
    if (keptSessions.get(key) === pending) keptSessions.delete(key);
  });
  return pending;
}

async function withKeptSession<T>(
  key: string,
  resolved: ResolvedServer,
  connectInput: (headers: () => Record<string, string>) => McpStreamableHttpConnectInput,
  use: (client: McpStreamableHttpClient, kept: KeptSession) => Promise<T>,
): Promise<T> {
  closeIdleSessions(Date.now());
  let headers = await resolved.headers(false);
  let refreshed = false;
  let renewed = false;
  for (;;) {
    const existing = keptSessions.get(key);
    let kept: KeptSession | null = null;
    try {
      kept = await (existing ?? openKeptSession(key, connectInput, headers));
      // Ended while this step waited for it (it sat idle too long): take another.
      if (kept.retired) {
        kept = null;
        continue;
      }
      const using = kept;
      using.headers = headers;
      using.users += 1;
      try {
        return await using.session.use((client) => use(client, using));
      } finally {
        using.users -= 1;
        using.lastUsedAt = Date.now();
      }
    } catch (error) {
      const unauthorized =
        resolved.refreshable && classifyMcpEventsError(error).kind === "unauthorized";
      // A JSON-RPC error answer and Opengeni's own refusals leave the session sound.
      const sound =
        !unauthorized &&
        (ProtocolError.isInstance(error) || error instanceof EventSourceBlockedError);
      if (kept && !sound) retire(kept, { terminate: !sessionLost(error) });
      if (unauthorized && !refreshed) {
        refreshed = true;
        headers = await resolved.headers(true);
        continue;
      }
      if (existing && !renewed && sessionLost(error)) {
        renewed = true;
        continue;
      }
      throw error;
    } finally {
      if (kept?.retired && kept.users === 0) {
        void kept.session.close({ terminate: kept.terminate });
      }
    }
  }
}
