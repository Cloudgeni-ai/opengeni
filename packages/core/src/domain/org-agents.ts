/**
 * Session create with an organization (Console) agent.
 *
 * Runs only when the create's `agent` names an organization agent (a key or
 * id string, or an object with `ref`; `sessionAgentFieldNamesOrgAgent`).
 * Every other create keeps today's code path unchanged.
 *
 * The agent version becomes an ordinary create request: its tool servers are
 * session MCP servers (id = tool server key, no credentials), its model and
 * built-ins fill what the request left out, and what the request changed is
 * recorded per setting. The rest of the create path then runs as for any
 * other chat, with the binding written to `sessions.agent_id`,
 * `agent_version`, `agent_prompt_version` and `agent_overrides`.
 */
import { createHash } from "node:crypto";
import { orgAgentsEnabledForAccount, type Settings } from "@opengeni/config";
import {
  canonicalOrgAgentDefinitionJson,
  OrgAgentDefinition,
  OrgAgentSessionRequest,
  ORG_AGENT_KEY_PATTERN,
  orgAgentRefIsId,
  type AccessGrant,
  type OrgAgentSessionOverrides,
  type OrgAgentToolServerOverride,
  type OrgAgentVersionConfig,
  type SessionMcpServerInput,
} from "@opengeni/contracts";
import {
  resolveOrgAgentRunsOnInAccount,
  decryptEnvironmentValue,
  listOrgToolServersByKey,
  readEndUserToolCredential,
  readOrgAgentBindingForCreateKey,
  readOrgAgentForSessionCreate,
  readOrgAgentVersion,
  saveInlineOrgAgentVersion,
  type Database,
  type OrgAgentRuntimeVersion,
  type OrgToolServerRuntime,
} from "@opengeni/db";
import { pinnedFetch } from "@opengeni/network";
import { recordOrgAgentResolve, type Observability } from "@opengeni/observability";
import { HTTPException } from "hono/http-exception";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { legacyMcpClientError, withMcpStreamableHttpClient } from "./mcp-streamable-http-client";
import {
  effectiveOrgToolServerConfig,
  materializeOrgToolServer,
  mergeOrgAgentCapabilities,
  orgAgentCatalogToolNames,
  orgToolServerOverrideWidening,
  orgToolServerSessionInput,
  parseOrgAgentVersionConfig,
  sameSetting,
  sessionMcpServerSetting,
  toolServerOverrideChanges,
  withoutUndefined,
  type MaterializedOrgToolServer,
} from "./org-agent-config";
import {
  applyOrgAgentRunsOn,
  assertOrgAgentChatMachine,
  OrgAgentRunsOnError,
  type OrgAgentRunsOnDeps,
} from "./org-agent-runs-on";

type OrgAgentCreateGrant = Pick<AccessGrant, "accountId" | "subjectId" | "permissions"> &
  Partial<Pick<AccessGrant, "metadata" | "subjectLabel">>;

/**
 * What the caller may do beyond running the agent, decided by the caller of
 * `prepareOrgAgentSessionCreate` from organization-level authority only
 * (`authorizationHoldsOrganizationPermission(..., "agents:manage")`), never
 * from workspace permissions.
 */
export type OrgAgentCreateAuthority = {
  /** Save agents or versions from inline config, and widen the agent's tools or approvals. */
  manageAgents: boolean;
};

function agentsManageRequired(message: string): OrgAgentSessionCreateError {
  return new OrgAgentSessionCreateError(403, "agents_manage_required", message);
}

/** A refused create: `details.code` is one of `ORG_AGENT_ERROR_CODES`. */
export class OrgAgentSessionCreateError extends HTTPException {
  constructor(
    readonly httpStatus: 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(httpStatus, { message });
    this.name = "OrgAgentSessionCreateError";
  }
}

/**
 * Refuses the machine an organization agent chat (named or inherited by a
 * worker) would finally run on when it is a Personal (Only me) machine or one
 * this caller can't read; see {@link assertOrgAgentChatMachine}.
 */
export async function refuseOrgAgentChatMachine(
  db: Database,
  access: { accountId: string; workspaceId: string; subjectId: string },
  sandboxId: string,
): Promise<void> {
  try {
    await assertOrgAgentChatMachine({ db }, access, sandboxId);
  } catch (error) {
    if (error instanceof OrgAgentRunsOnError) {
      throw new OrgAgentSessionCreateError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}

function notFound(): OrgAgentSessionCreateError {
  return new OrgAgentSessionCreateError(
    404,
    "agent_not_found",
    "No such agent here: it does not exist, was archived, or is not available in this workspace.",
  );
}

/** What the session row records for an organization agent chat. */
export type OrgAgentSessionBinding = {
  agentId: string;
  key: string;
  version: number;
  /** The version whose Instructions are in the system prompt. */
  promptVersion: number;
  overrides: OrgAgentSessionOverrides | null;
};

export type PreparedOrgAgentSessionCreate = {
  /** The create body the ordinary path parses: no organization agent fields left. */
  payload: Record<string, unknown>;
  binding: OrgAgentSessionBinding;
  /** The agent's own servers: attached without `mcp_servers:attach`. */
  agentServerIds: ReadonlySet<string>;
};

export type OrgAgentSessionCreateDeps = {
  db: Database;
  settings: Settings;
  observability?: Observability | null;
  /** Test seam: the tools a server offers now, or null when unknown. */
  listToolServerTools?: OrgToolServerToolLister;
  /** Test seams for Runs on (machine and environment lookups). */
  runsOn?: Omit<OrgAgentRunsOnDeps, "db" | "settings">;
};

export type OrgToolServerToolLister = (input: {
  server: OrgToolServerRuntime;
  headers: Record<string, string>;
}) => Promise<string[] | null>;

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function orgAgentConfigHash(definition: OrgAgentDefinition): string {
  return `sha256:${createHash("sha256").update(canonicalOrgAgentDefinitionJson(definition)).digest("hex")}`;
}

/**
 * Resolve the organization agent a create names and rewrite the body into an
 * ordinary create. Throws {@link OrgAgentSessionCreateError} (404 unknown,
 * archived, out of reach or Console agents off; 409 unpublished or Console
 * managed with inline config; 422 conflicting or rejected changes).
 */
export async function prepareOrgAgentSessionCreate(
  deps: OrgAgentSessionCreateDeps,
  grant: OrgAgentCreateGrant,
  workspaceId: string,
  rawPayload: Record<string, unknown>,
  authority: OrgAgentCreateAuthority = { manageAgents: false },
): Promise<PreparedOrgAgentSessionCreate> {
  try {
    const prepared = await prepare(deps, grant, workspaceId, rawPayload, authority);
    recordOrgAgentResolve(deps.observability, "resolved");
    return prepared;
  } catch (error) {
    recordOrgAgentResolve(
      deps.observability,
      error instanceof OrgAgentSessionCreateError ? error.code : "error",
    );
    throw error;
  }
}

async function prepare(
  deps: OrgAgentSessionCreateDeps,
  grant: OrgAgentCreateGrant,
  workspaceId: string,
  raw: Record<string, unknown>,
  authority: OrgAgentCreateAuthority,
): Promise<PreparedOrgAgentSessionCreate> {
  if (raw["agentId"] !== undefined && raw["agentId"] !== null) {
    throw new OrgAgentSessionCreateError(
      422,
      "agent_ref_conflict",
      "Name either agentId (a workspace agent) or agent (an organization agent), not both.",
    );
  }
  if (!orgAgentsEnabledForAccount(deps.settings, grant.accountId)) throw notFound();
  const agentField = raw["agent"];
  const requestObject: Record<string, unknown> =
    typeof agentField === "string" ? { ref: agentField } : (agentField as Record<string, unknown>);
  const parsed = OrgAgentSessionRequest.safeParse(requestObject);
  if (!parsed.success) {
    throw new HTTPException(422, {
      message: `invalid agent: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "agent"}: ${issue.message}`)
        .join("; ")}`,
    });
  }
  const request = parsed.data;
  const ref = orgAgentRefIsId(request.ref)
    ? { id: request.ref.toLowerCase() }
    : ORG_AGENT_KEY_PATTERN.test(request.ref)
      ? { key: request.ref }
      : null;
  if (!ref) throw notFound();
  const { agent, reach } = await readOrgAgentForSessionCreate(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    ref,
  });
  // A keyed retry of a create that already made its chat binds the version
  // that chat runs, before any check or inline save: the agent may have been
  // republished or archived since, and the existing create replay must see
  // the same body to return the original chat.
  const replayed = await replayedOrgAgentBinding(deps, grant, workspaceId, raw, request, agent);
  if (replayed && agent) {
    return await bind(deps, grant, workspaceId, raw, request, agent, replayed, authority);
  }
  const inTestWorkspace = reach.managedSource === "console_test";
  if (agent && (agent.archived || !(reach.managedSource !== null || reach.access)))
    throw notFound();

  let version: OrgAgentRuntimeVersion;
  if (request.config) {
    // Inline code agent: a version of a code-managed agent, by config hash.
    if (!agent && reach.managedSource === null) throw notFound();
    if (agent && agent.managedBy !== "code") {
      throw new OrgAgentSessionCreateError(
        409,
        "agent_managed_in_console",
        "This agent is edited in Console; start the chat without config.",
      );
    }
    const definition = request.config;
    const serverKeys = definition.config.toolServers.map((server) => server.server);
    const known = await listOrgToolServersByKey(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      keys: serverKeys,
    });
    const missing = serverKeys.filter((key) => !known.has(key));
    if (missing.length > 0) {
      throw new OrgAgentSessionCreateError(
        422,
        "tool_server_not_found",
        `This organization has no tool server ${missing.map((key) => `'${key}'`).join(", ")}.`,
      );
    }
    const runsOn = await resolveOrgAgentRunsOnInAccount(
      deps.db,
      grant.accountId,
      definition.config.runsOn,
    );
    if ("problem" in runsOn) {
      throw new OrgAgentSessionCreateError(422, runsOn.problem.code, runsOn.problem.message);
    }
    const saved = await saveInlineOrgAgentVersion(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      ref: agent ? { id: agent.id } : ref,
      definition: {
        name: definition.name,
        description: definition.description,
        instructions: definition.instructions,
        config: definition.config,
      },
      toolCatalog: {},
      configHash: orgAgentConfigHash(definition),
      runsOnTarget: runsOn.target,
      subjectId: grant.subjectId ?? null,
      actorLabel: grant.subjectLabel ?? null,
      mayWrite: authority.manageAgents,
    });
    switch (saved.outcome) {
      case "not_found":
      case "archived":
        throw notFound();
      case "forbidden":
        throw agentsManageRequired(
          "Saving an agent from config needs agents:manage for the organization: an organization key, or an owner or admin.",
        );
      case "managed_in_console":
        throw new OrgAgentSessionCreateError(
          409,
          "agent_managed_in_console",
          "This agent is edited in Console; start the chat without config.",
        );
      default:
        version = saved.version;
        return await bind(deps, grant, workspaceId, raw, request, saved.agent, version, authority);
    }
  }
  if (!agent) throw notFound();
  let versionNumber: number;
  if (request.version !== undefined) {
    if (request.version !== agent.publishedVersion && !inTestWorkspace) throw notFound();
    versionNumber = request.version;
  } else if (agent.publishedVersion !== null) {
    versionNumber = agent.publishedVersion;
  } else if (inTestWorkspace) {
    versionNumber = agent.currentVersion;
  } else {
    throw new OrgAgentSessionCreateError(
      409,
      "agent_not_published",
      "This agent has no published version yet.",
    );
  }
  const loaded = await readOrgAgentVersion(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    agentId: agent.id,
    version: versionNumber,
  });
  if (!loaded) {
    throw new OrgAgentSessionCreateError(
      404,
      "agent_version_not_found",
      `This agent has no version ${versionNumber}.`,
    );
  }
  return await bind(deps, grant, workspaceId, raw, request, agent, loaded, authority);
}

/**
 * The version an earlier create with this request's idempotency key bound,
 * or null when there is no key, no such chat, or it runs no organization
 * agent. A retry naming another agent, another `version` or another inline
 * config is a different request: 409, as for any reused key.
 */
async function replayedOrgAgentBinding(
  deps: OrgAgentSessionCreateDeps,
  grant: OrgAgentCreateGrant,
  workspaceId: string,
  raw: Record<string, unknown>,
  request: OrgAgentSessionRequest,
  agent: { id: string } | null,
): Promise<OrgAgentRuntimeVersion | null> {
  const key = raw["idempotencyKey"];
  if (typeof key !== "string" || key.length === 0) return null;
  const existing = await readOrgAgentBindingForCreateKey(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    createIdempotencyKey: key,
    subjectId: grant.subjectId ?? null,
  });
  if (!existing) return null;
  const conflict = () =>
    new HTTPException(409, {
      message: "Session create idempotency key was reused with a different request",
    });
  if (!agent || agent.id !== existing.agentId) throw conflict();
  if (request.version !== undefined && request.version !== existing.version) throw conflict();
  const version = await readOrgAgentVersion(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    agentId: existing.agentId,
    version: existing.version,
  });
  if (!version) throw conflict();
  if (request.config && version.configHash !== orgAgentConfigHash(request.config)) {
    throw conflict();
  }
  return version;
}

async function bind(
  deps: OrgAgentSessionCreateDeps,
  grant: OrgAgentCreateGrant,
  workspaceId: string,
  raw: Record<string, unknown>,
  request: OrgAgentSessionRequest,
  agent: { id: string; key: string },
  version: OrgAgentRuntimeVersion,
  authority: OrgAgentCreateAuthority,
): Promise<PreparedOrgAgentSessionCreate> {
  const config = parseOrgAgentVersionConfig(version.config);
  const toolServers = await listOrgToolServersByKey(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    keys: config.toolServers.map((server) => server.server),
  });
  const plan = await planOrgAgentSessionCreate({
    raw,
    request,
    config,
    toolCatalog: version.toolCatalog,
    toolServers,
    mayWiden: authority.manageAgents,
    liveTools: async (server, chatHeaders) =>
      await liveToolNames(deps, grant, workspaceId, server, chatHeaders),
  });
  // Where the chat runs: the version's Runs on, with the request on top.
  const placed = await applyOrgAgentRunsOn({
    deps: { db: deps.db, settings: deps.settings, ...deps.runsOn },
    grant,
    workspaceId,
    payload: plan.payload,
    runsOn: config.runsOn,
    target: version.runsOnTarget,
  }).catch((error: unknown) => {
    if (error instanceof OrgAgentRunsOnError) {
      throw new OrgAgentSessionCreateError(error.httpStatus, error.code, error.message);
    }
    throw error;
  });
  const overrides =
    plan.overrides || Object.keys(placed.overrides).length > 0
      ? { ...plan.overrides, ...placed.overrides }
      : null;
  if (raw["agentOverrides"] === "reject" && overrides) {
    throw new OrgAgentSessionCreateError(
      422,
      "agent_override_rejected",
      `This request changes the agent's settings (${Object.keys(overrides).sort().join(", ")}) and agentOverrides is "reject".`,
    );
  }
  return {
    payload: placed.payload,
    binding: {
      agentId: agent.id,
      key: agent.key,
      version: version.version,
      promptVersion: version.version,
      overrides,
    },
    agentServerIds: plan.agentServerIds,
  };
}

/**
 * The create body, overrides and agent server ids for one version and request.
 * Field presence comes from the raw body: a parsed default is not a change.
 */
export async function planOrgAgentSessionCreate(input: {
  raw: Record<string, unknown>;
  request: OrgAgentSessionRequest;
  config: OrgAgentVersionConfig;
  toolCatalog: unknown;
  toolServers: ReadonlyMap<
    string,
    { key: string; name: string; url: string } & Partial<OrgToolServerRuntime>
  >;
  liveTools?: (
    server: OrgToolServerRuntime,
    chatHeaders: Record<string, string> | undefined,
  ) => Promise<string[] | null>;
  /**
   * Whether the chat may give more than the agent: turn on tools the agent
   * left off, take "Ask first" away, or replace an agent's tool server with
   * its own. Without it a chat may only narrow (organization-level
   * `agents:manage` only).
   */
  mayWiden?: boolean;
  /**
   * One deadline for every live tool list of the create, fetched in parallel;
   * a list not back in time counts as unavailable (default 5 seconds).
   */
  liveToolsDeadlineMs?: number;
}): Promise<{
  payload: Record<string, unknown>;
  overrides: OrgAgentSessionOverrides | null;
  agentServerIds: ReadonlySet<string>;
}> {
  const { raw, request, config } = input;
  const requestObject =
    raw["agent"] && typeof raw["agent"] === "object"
      ? (raw["agent"] as Record<string, unknown>)
      : {};
  const overrides: OrgAgentSessionOverrides = {};
  const serverOverrides = new Map<string, OrgAgentToolServerOverride>(
    (request.toolServers ?? []).map((override) => [override.server, override]),
  );

  // Tool servers: the version's, with this chat's changes. Live tool lists
  // are fetched in parallel under one deadline after this loop.
  const planned: {
    server: { key: string; name: string; url: string } & Partial<OrgToolServerRuntime>;
    serverConfig: OrgAgentVersionConfig["toolServers"][number];
    effective: NonNullable<ReturnType<typeof effectiveOrgToolServerConfig>>;
    live: Promise<string[] | null> | null;
  }[] = [];
  const loginHeaders = new Map<string, Record<string, string>>();
  for (const serverConfig of config.toolServers) {
    const server = input.toolServers.get(serverConfig.server);
    // A tool server deleted after the version was saved is skipped.
    if (!server) continue;
    const override = serverOverrides.get(serverConfig.server);
    const { server: _key, headers, ...change } = override ?? { server: serverConfig.server };
    if (override && !input.mayWiden) {
      const widening = orgToolServerOverrideWidening(serverConfig, change);
      if (widening) {
        throw agentsManageRequired(
          `This chat ${widening}. A chat may turn the agent's tools off or ask first for more of them; giving more needs agents:manage for the organization.`,
        );
      }
    }
    if (override && toolServerOverrideChanges(serverConfig, change)) {
      overrides[`toolServers.${serverConfig.server}`] = {
        agent: serverConfig,
        chat: withoutUndefined(change as Record<string, unknown>),
      };
    }
    const effective = effectiveOrgToolServerConfig(serverConfig, override ? change : undefined);
    if (!effective) continue;
    const needsLive =
      (effective.config.tools.mode === "selected" && effective.config.newTools !== "off") ||
      (effective.config.tools.mode === "all" &&
        (effective.disableTools.length > 0 || effective.config.newTools === "on_with_approval"));
    const live =
      needsLive && input.liveTools
        ? input.liveTools(server as OrgToolServerRuntime, headers).catch(() => null)
        : null;
    planned.push({ server, serverConfig, effective, live });
    if (headers && Object.keys(headers).length > 0) loginHeaders.set(serverConfig.server, headers);
  }
  const liveLists = await withinDeadline(
    planned.map((entry) => entry.live),
    input.liveToolsDeadlineMs ?? LIVE_TOOLS_DEADLINE_MS,
  );
  const materialized: MaterializedOrgToolServer[] = planned.map((entry, index) =>
    materializeOrgToolServer({
      server: entry.server,
      effective: entry.effective,
      catalogNames: orgAgentCatalogToolNames(input.toolCatalog, entry.serverConfig.server),
      liveNames: liveLists[index] ?? null,
    }),
  );

  // The request's own MCP servers: a new id adds one, an agent server's id replaces it.
  const requestServers = Array.isArray(raw["mcpServers"])
    ? (raw["mcpServers"] as SessionMcpServerInput[])
    : [];
  const replaced = new Set(requestServers.map((server) => server?.id).filter(Boolean));
  if (!input.mayWiden) {
    const agentKeys = new Set(config.toolServers.map((server) => server.server));
    const replacing = [...replaced].filter((id) => agentKeys.has(id as string));
    if (replacing.length > 0) {
      throw agentsManageRequired(
        `mcpServers replaces the agent's tool server ${replacing.map((id) => `'${id}'`).join(", ")}. Change it with agent.toolServers, or add your own server under another id; replacing it needs agents:manage for the organization.`,
      );
    }
  }
  for (const server of requestServers) {
    if (!server || typeof server !== "object" || typeof server.id !== "string") continue;
    const agentServer = materialized.find((candidate) => candidate.id === server.id);
    overrides[`mcpServers.${server.id}`] = {
      agent: agentServer ?? null,
      chat: sessionMcpServerSetting(server),
    };
  }
  const agentServers = materialized.filter((server) => !replaced.has(server.id));
  const mcpServers = [
    ...agentServers.map((server) => orgToolServerSessionInput(server, loginHeaders.get(server.id))),
    ...requestServers,
  ];

  // Scalars: the request wins.
  for (const key of ["model", "reasoningEffort"] as const) {
    if (hasOwn(raw, key) && raw[key] !== undefined && !sameSetting(raw[key], config[key] ?? null)) {
      overrides[key] = { agent: config[key] ?? null, chat: raw[key] };
    }
  }
  const extraInstructions =
    (typeof raw["instructions"] === "string" && raw["instructions"].trim()) ||
    (typeof request.instructions === "string" && request.instructions.trim()) ||
    "";
  if (extraInstructions) overrides["instructions"] = { agent: null, chat: extraInstructions };

  const agentRequest: Record<string, unknown> = {};
  if (request.capabilities !== undefined) {
    const merged = mergeOrgAgentCapabilities(config.capabilities, request.capabilities);
    agentRequest["capabilities"] = merged;
    if (!sameSetting(merged, config.capabilities ?? null)) {
      overrides["capabilities"] = { agent: config.capabilities ?? null, chat: merged };
    }
  } else if (config.capabilities !== undefined) {
    agentRequest["capabilities"] = config.capabilities;
  }
  for (const key of ["identity", "renderer", "titleInstructions"] as const) {
    if (hasOwn(requestObject, key)) {
      agentRequest[key] = request[key];
      if (!sameSetting(request[key] ?? null, config[key] ?? null)) {
        overrides[key] = { agent: config[key] ?? null, chat: request[key] ?? null };
      }
    } else if (config[key] !== undefined && config[key] !== null) {
      agentRequest[key] = config[key];
    }
  }
  if (request.instructions !== undefined) agentRequest["instructions"] = request.instructions;
  if (request.vaultPolicy !== undefined) agentRequest["vaultPolicy"] = request.vaultPolicy;

  const payload: Record<string, unknown> = { ...raw };
  delete payload["agentOverrides"];
  if (Object.keys(agentRequest).length > 0) payload["agent"] = agentRequest;
  else delete payload["agent"];
  for (const key of ["model", "reasoningEffort"] as const) {
    if (!hasOwn(raw, key) && config[key] !== undefined) payload[key] = config[key];
  }
  if (mcpServers.length > 0) payload["mcpServers"] = mcpServers;
  return {
    payload,
    overrides: Object.keys(overrides).length > 0 ? overrides : null,
    agentServerIds: new Set(agentServers.map((server) => server.id)),
  };
}

/* ------------------------------------------------------- live tool lists */

/** One deadline for all of a create's live tool lists, which run in parallel. */
const LIVE_TOOLS_DEADLINE_MS = 5_000;

/**
 * Settle every pending list together; a list still running at the deadline
 * (or failed) is null, which materializes the version's catalog as saved.
 */
async function withinDeadline(
  pending: readonly (Promise<string[] | null> | null)[],
  deadlineMs: number,
): Promise<(string[] | null)[]> {
  if (pending.every((entry) => entry === null)) return pending.map(() => null);
  const results: (string[] | null)[] = pending.map(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  try {
    await Promise.race([
      Promise.all(
        pending.map(async (entry, index) => {
          if (!entry) return;
          const names = await entry.catch(() => null);
          results[index] = names;
        }),
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return [...results];
}

const LIVE_TOOLS_TTL_MS = 60_000;
const LIVE_TOOLS_TIMEOUT_MS = 5_000;
const LIVE_TOOLS_CACHE_MAX = 256;
const liveToolsCache = new Map<string, { at: number; names: string[] }>();

/**
 * The tools a tool server offers now, for `newTools`: fetched with the login
 * this chat would use (none, the shared key, the chat's own headers, or the
 * end user's stored login) and cached briefly. Null when it cannot be listed;
 * the chat then gets only the version's listed tools.
 */
async function liveToolNames(
  deps: OrgAgentSessionCreateDeps,
  grant: Pick<AccessGrant, "accountId" | "subjectId">,
  workspaceId: string,
  server: OrgToolServerRuntime,
  chatHeaders: Record<string, string> | undefined,
): Promise<string[] | null> {
  const headers = await liveListHeaders(deps, grant, workspaceId, server, chatHeaders);
  if (headers === null) return null;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(Object.entries(headers).sort()))
    .digest("hex");
  const cacheKey = `${server.id}:${server.version}:${server.url}:${fingerprint}`;
  const cached = liveToolsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LIVE_TOOLS_TTL_MS) return cached.names;
  const lister = deps.listToolServerTools ?? ((input) => listToolsOverHttp(deps.settings, input));
  const names = await lister({ server, headers }).catch(() => null);
  if (names) {
    if (liveToolsCache.size >= LIVE_TOOLS_CACHE_MAX) {
      const oldest = liveToolsCache.keys().next().value;
      if (oldest !== undefined) liveToolsCache.delete(oldest);
    }
    liveToolsCache.set(cacheKey, { at: Date.now(), names });
  }
  return names;
}

async function liveListHeaders(
  deps: OrgAgentSessionCreateDeps,
  grant: Pick<AccessGrant, "accountId" | "subjectId">,
  workspaceId: string,
  server: OrgToolServerRuntime,
  chatHeaders: Record<string, string> | undefined,
): Promise<Record<string, string> | null> {
  if (server.authMode === "none") return {};
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (server.authMode === "shared_key") {
    if (!server.sharedHeadersEncrypted || !key) return null;
    try {
      return JSON.parse(decryptEnvironmentValue(key, server.sharedHeadersEncrypted)) as Record<
        string,
        string
      >;
    } catch {
      return null;
    }
  }
  if (chatHeaders && Object.keys(chatHeaders).length > 0) return chatHeaders;
  const subjectId = grant.subjectId;
  if (!key || !subjectId || !subjectId.startsWith("external_user:")) return null;
  const stored = await readEndUserToolCredential(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    subjectId,
    toolServerId: server.id,
  }).catch(() => null);
  if (!stored || (stored.expiresAt && stored.expiresAt.getTime() <= Date.now())) return null;
  return endUserLoginHeaders(decryptEnvironmentValue(key, stored.materialEncrypted));
}

/** Request headers for a decrypted end-user login (`{kind: "headers"|"oauth", ...}`). */
export function endUserLoginHeaders(material: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(material) as Record<string, unknown>;
    if (
      parsed["kind"] === "headers" &&
      parsed["headers"] &&
      typeof parsed["headers"] === "object"
    ) {
      return Object.fromEntries(
        Object.entries(parsed["headers"] as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
    if (parsed["kind"] === "oauth" && typeof parsed["accessToken"] === "string") {
      const tokenType =
        typeof parsed["tokenType"] === "string" && parsed["tokenType"].trim()
          ? parsed["tokenType"].trim()
          : "Bearer";
      return {
        Authorization: `${/^bearer$/i.test(tokenType) ? "Bearer" : tokenType} ${parsed["accessToken"]}`,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function listToolsOverHttp(
  settings: Settings,
  input: { server: OrgToolServerRuntime; headers: Record<string, string> },
): Promise<string[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_TOOLS_TIMEOUT_MS);
  try {
    return await withMcpStreamableHttpClient(
      {
        url: input.server.url,
        clientName: "opengeni-org-agent-tools",
        clientVersion: "0.1.0",
        timeoutMs: LIVE_TOOLS_TIMEOUT_MS,
        requestInit: { signal: controller.signal, headers: input.headers },
        fetch: (url, init) =>
          pinnedFetch(url, init, settings, {
            label: "Organization tool server tool list",
            requireHttpsOutsideLocalTest: true,
          }),
      },
      async (client) => {
        const names: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page += 1) {
          const result = await client
            .listTools(cursor ? { cursor } : undefined, {
              timeout: LIVE_TOOLS_TIMEOUT_MS,
              maxTotalTimeout: LIVE_TOOLS_TIMEOUT_MS,
            })
            .catch((error: unknown) => {
              throw legacyMcpClientError(error);
            });
          names.push(...result.tools.map((tool) => tool.name));
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        return [...new Set(names)];
      },
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** @internal Tests reset the live tool list cache. */
export function resetOrgToolServerLiveToolsCacheForTests(): void {
  liveToolsCache.clear();
}
