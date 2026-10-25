import type { McpServerConfig } from "@opengeni/config";
import {
  readyEventSourceKey,
  readyEventSourceRequest,
  type ReadyEventSource,
  type ReadyEventSourceRequest,
} from "@opengeni/contracts";
import { listEventSources, type EventSourceRecord } from "@opengeni/db";
import { isOfficialGmailMcpConfig } from "@opengeni/runtime/gmail-rest-mcp";
import { HTTPException } from "hono/http-exception";
import { accountIdentity } from "../mcp-account-routes";
import { createGmailEventSource } from "./gmail-source";
import {
  mcpServerDisplayName,
  ownerConnectionBindings,
  withMcpEventSourceClient,
  workspaceMcpServers,
  type EventSourceOwner,
  type McpEventSourceClientDeps,
} from "./mcp-event-source-client";
import { serverOffersMcpEvents } from "./mcp-events-protocol";
import { addMcpEventSource, eventTriggersEnabled } from "./sources";
import { createWorkspaceEventSource, WORKSPACE_EVENT_SOURCE_NAME } from "./workspace-source";

/**
 * Sources that need no setting up. A person signed in to an MCP server that
 * offers events, a Gmail account they connected and "This workspace" are each
 * usable at once: they are listed by key until used, and the person's own
 * source is added the first time a trigger or a read names the key. Whether a
 * server offers events is learned by connecting to it as the person, and
 * remembered for a while so listing stays quick.
 */

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_TTL_MS = 10 * 60_000;
/** An unreachable server is asked again sooner. */
const PROBE_FAILURE_TTL_MS = 60_000;
const PROBE_CACHE_MAX = 2_000;

type Probe = { offers: boolean; expiresAt: number };
const probes = new Map<string, Probe>();
const probing = new Map<string, Promise<boolean>>();

/** Forget what servers were found to offer, for tests. */
export function forgetReadyEventSourceProbes(): void {
  probes.clear();
  probing.clear();
}

function remember(key: string, probe: Probe): void {
  probes.delete(key);
  probes.set(key, probe);
  while (probes.size > PROBE_CACHE_MAX) {
    const oldest = probes.keys().next().value;
    if (oldest === undefined) break;
    probes.delete(oldest);
  }
}

/** Whether `server` offers events to `owner`; false when it can't be reached right now. */
async function serverOffersEventsTo(
  deps: McpEventSourceClientDeps,
  owner: EventSourceOwner,
  server: McpServerConfig,
): Promise<boolean> {
  const key = JSON.stringify([owner.workspaceId, owner.ownerSubjectId, server.id, server.url]);
  const cached = probes.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.offers;
  const pending = probing.get(key);
  if (pending) return await pending;
  const probe = withMcpEventSourceClient(
    deps,
    { kind: "mcp", ...owner, mcpServerId: server.id, connectionId: null },
    async (client) => await serverOffersMcpEvents(client, { timeout: PROBE_TIMEOUT_MS }),
    { timeoutMs: PROBE_TIMEOUT_MS },
  ).then(
    (offers) => {
      remember(key, { offers, expiresAt: Date.now() + PROBE_TTL_MS });
      return offers;
    },
    () => {
      remember(key, { offers: false, expiresAt: Date.now() + PROBE_FAILURE_TTL_MS });
      return false;
    },
  );
  probing.set(key, probe);
  try {
    return await probe;
  } finally {
    probing.delete(key);
  }
}

function ownSources(sources: EventSourceRecord[], subjectId: string): EventSourceRecord[] {
  return sources.filter((source) => source.ownerSubjectId === subjectId);
}

/**
 * The sources `ownerSubjectId` can use without setting them up and doesn't
 * have yet: MCP servers by name, then Gmail accounts, then This workspace. A
 * workspace-level caller owns none.
 */
export async function listReadyEventSources(
  deps: McpEventSourceClientDeps,
  input: { accountId: string; workspaceId: string; ownerSubjectId: string | null },
): Promise<ReadyEventSource[]> {
  const subjectId = input.ownerSubjectId;
  if (!eventTriggersEnabled(deps.settings) || !subjectId) return [];
  const owner: EventSourceOwner = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    ownerSubjectId: subjectId,
  };
  const [own, servers] = await Promise.all([
    listEventSources(deps.db, input.workspaceId, subjectId).then((sources) =>
      ownSources(sources, subjectId),
    ),
    workspaceMcpServers(deps, input.workspaceId),
  ]);
  const gmailServers = servers.filter((server) =>
    isOfficialGmailMcpConfig(server.url, server.connectionRef),
  );
  const eventServers = servers.filter(
    (server) =>
      !gmailServers.includes(server) &&
      server.connectionRef?.authoritySource !== "host" &&
      !own.some((source) => source.kind === "mcp" && source.mcpServerId === server.id),
  );
  const bindings = await ownerConnectionBindings(deps, owner, [...gmailServers, ...eventServers]);
  const signedIn = (server: McpServerConfig) =>
    !server.connectionRef ||
    bindings.some(
      (binding) => binding.canonicalServerId === server.id || binding.serverId === server.id,
    );
  const offering = await Promise.all(
    eventServers
      .filter(signedIn)
      .map(async (server) =>
        (await serverOffersEventsTo(deps, owner, server)) ? [server] : ([] as McpServerConfig[]),
      ),
  );
  const mcp = offering
    .flat()
    .map((server) => ({
      key: readyEventSourceKey({ kind: "mcp", serverId: server.id }),
      kind: "mcp" as const,
      name: mcpServerDisplayName(server),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const gmailIds = new Set(gmailServers.map((server) => server.id));
  const gmail = new Map<string, ReadyEventSource>();
  for (const binding of bindings) {
    if (!gmailIds.has(binding.canonicalServerId) && !gmailIds.has(binding.serverId)) continue;
    if (gmail.has(binding.connectionId)) continue;
    if (
      own.some((source) => source.kind === "gmail" && source.connectionId === binding.connectionId)
    )
      continue;
    gmail.set(binding.connectionId, {
      key: readyEventSourceKey({ kind: "gmail", connectionId: binding.connectionId }),
      kind: "gmail",
      // Named as its source will be once added.
      name: `Gmail (${accountIdentity(binding)})`,
    });
  }
  const workspace: ReadyEventSource[] = own.some((source) => source.kind === "workspace")
    ? []
    : [
        {
          key: readyEventSourceKey({ kind: "workspace" }),
          kind: "workspace",
          name: WORKSPACE_EVENT_SOURCE_NAME,
        },
      ];
  return [...mcp, ...gmail.values(), ...workspace];
}

/**
 * The owner's source behind a ready source's key: the one they have, or a
 * new one added now. Throws the same errors adding it by hand would.
 */
export async function addReadyEventSource(
  deps: McpEventSourceClientDeps,
  input: {
    accountId: string;
    workspaceId: string;
    ownerSubjectId: string | null;
    /** Who is adding it, recorded as its creator. */
    createdBySubjectId: string;
    key: string;
  },
): Promise<EventSourceRecord> {
  const request: ReadyEventSourceRequest | null = readyEventSourceRequest(input.key);
  if (!request) throw new HTTPException(422, { message: `Unknown event source: ${input.key}` });
  const ownerSubjectId = input.ownerSubjectId;
  if (!ownerSubjectId) {
    throw new HTTPException(422, {
      message: `${input.key} is a person's own source. Set it up as that person.`,
    });
  }
  const own = ownSources(
    await listEventSources(deps.db, input.workspaceId, ownerSubjectId),
    ownerSubjectId,
  );
  const existing = own.find((source) =>
    request.kind === "mcp"
      ? source.kind === "mcp" && source.mcpServerId === request.serverId
      : request.kind === "gmail"
        ? source.kind === "gmail" && source.connectionId === request.connectionId
        : source.kind === "workspace",
  );
  if (existing) return existing;
  const adding = {
    ...deps,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createdBySubjectId: input.createdBySubjectId,
    ownerSubjectId,
  };
  if (request.kind === "mcp")
    return await addMcpEventSource({ ...adding, serverId: request.serverId });
  if (request.kind === "gmail") {
    return await createGmailEventSource({ ...adding, connectionId: request.connectionId });
  }
  return await createWorkspaceEventSource(adding);
}
