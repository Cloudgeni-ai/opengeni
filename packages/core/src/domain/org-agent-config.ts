/**
 * Organization agents: how one agent version becomes a chat's settings.
 * Pure functions shared by session create (`org-agents.ts`) and the publish
 * "move running chats" workflow, so a moved chat gets exactly what a new chat
 * on the same version and request would get.
 *
 * An organization tool server becomes an ordinary session MCP server whose id
 * is the tool server key. It never carries the organization's credentials:
 * the worker resolves logins per turn. A chat's own changes (overrides) are
 * recorded as `{setting: {agent, chat}}` so Console can show what the chat
 * changed and a move can apply them again on the new version.
 */
import {
  OrgAgentToolServerOverride,
  OrgAgentVersionConfig,
  type AgentCapabilities,
  type OrgAgentSessionOverrides,
  type OrgAgentToolServerConfig,
  type SessionMcpServerInput,
  type ToolRef,
} from "@opengeni/contracts";

export type OrgToolServerRef = { key: string; name: string; url: string };

/** One tool server as the chat attaches it (no credentials). */
export type MaterializedOrgToolServer = {
  id: string;
  name: string;
  url: string;
  allowedTools?: string[];
  requireApproval?: true | string[];
  eager?: string[];
};

/** A tool server config after a chat's override; null when the chat turned it off. */
export type EffectiveOrgToolServerConfig = {
  config: OrgAgentToolServerConfig;
  disableTools: string[];
};

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sameSetting(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/** A stored version config, with defaults filled. Throws when it is not one. */
export function parseOrgAgentVersionConfig(raw: unknown): OrgAgentVersionConfig {
  return OrgAgentVersionConfig.parse(raw ?? {});
}

/** Tool names the server offered when the version was saved, or null when unknown. */
export function orgAgentCatalogToolNames(toolCatalog: unknown, key: string): string[] | null {
  if (!toolCatalog || typeof toolCatalog !== "object" || Array.isArray(toolCatalog)) return null;
  const entries = (toolCatalog as Record<string, unknown>)[key];
  if (!Array.isArray(entries)) return null;
  return entries.flatMap((entry) =>
    entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
      ? [(entry as { name: string }).name]
      : [],
  );
}

/** Apply a chat's override for one server; null when the chat turned the server off. */
export function effectiveOrgToolServerConfig(
  config: OrgAgentToolServerConfig,
  override: Omit<OrgAgentToolServerOverride, "server" | "headers"> | undefined,
): EffectiveOrgToolServerConfig | null {
  if (!override) return { config, disableTools: [] };
  if (override.enabled === false) return null;
  return {
    config: {
      ...config,
      ...(override.tools ? { tools: override.tools } : {}),
      ...(override.approval ? { approval: override.approval } : {}),
      ...(override.eager ? { eager: override.eager } : {}),
    },
    disableTools: override.disableTools ?? [],
  };
}

/**
 * One tool server as a session MCP server. `catalogNames` are the tools the
 * server offered when the version was saved and `liveNames` the tools it
 * offers now; a tool in `liveNames` but not in `catalogNames` is new and
 * follows the version's `newTools` rule. Without both lists no tool counts as
 * new (only the listed tools are on).
 */
export function materializeOrgToolServer(input: {
  server: OrgToolServerRef;
  effective: EffectiveOrgToolServerConfig;
  catalogNames: readonly string[] | null;
  liveNames: readonly string[] | null;
}): MaterializedOrgToolServer {
  const { config, disableTools } = input.effective;
  const disabled = new Set(disableTools);
  const catalog = input.catalogNames ? new Set(input.catalogNames) : null;
  const newTools =
    input.liveNames && catalog ? input.liveNames.filter((name) => !catalog.has(name)) : [];
  let allowedTools: string[] | undefined;
  if (config.tools.mode === "all") {
    const known = input.liveNames ?? input.catalogNames;
    allowedTools =
      disabled.size > 0 && known ? unique(known).filter((name) => !disabled.has(name)) : undefined;
  } else {
    allowedTools = unique([
      ...config.tools.enabled,
      ...(config.newTools === "off" ? [] : newTools),
    ]).filter((name) => !disabled.has(name));
  }
  const ask = config.approval.ask;
  const requireApproval: true | string[] | undefined =
    ask === true
      ? true
      : (() => {
          const names = unique([
            ...ask,
            ...(config.newTools === "on_with_approval" ? newTools : []),
          ]);
          return names.length > 0 ? names : undefined;
        })();
  const eager = unique(config.eager);
  return {
    id: input.server.key,
    name: input.server.name,
    url: input.server.url,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(requireApproval !== undefined ? { requireApproval } : {}),
    ...(eager.length > 0 ? { eager } : {}),
  };
}

/** The session MCP server input for a materialized server, with optional per-chat login. */
export function orgToolServerSessionInput(
  server: MaterializedOrgToolServer,
  headers?: Record<string, string>,
): SessionMcpServerInput {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    ...(server.allowedTools !== undefined ? { allowedTools: server.allowedTools } : {}),
    ...(server.eager !== undefined ? { eager: server.eager } : {}),
    ...(server.requireApproval !== undefined ? { requireApproval: server.requireApproval } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  } as SessionMcpServerInput;
}

/**
 * Built-ins merged per capability: a chat's object with the same starting
 * point adds its switches to the agent's; `all`, `none` or another starting
 * point replaces the agent's.
 */
export function mergeOrgAgentCapabilities(
  agent: AgentCapabilities | undefined,
  chat: AgentCapabilities,
): AgentCapabilities {
  if (typeof chat === "string" || agent === undefined) return chat;
  const base = typeof agent === "string" ? { from: agent } : agent;
  if (base.from !== chat.from) return chat;
  return { ...base, ...chat } as AgentCapabilities;
}

/** A tool server override as recorded (no headers), or undefined when it is not one. */
export function recordedToolServerOverride(
  value: unknown,
): Omit<OrgAgentToolServerOverride, "server" | "headers"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = OrgAgentToolServerOverride.safeParse({
    server: "x",
    ...value,
    headers: undefined,
  });
  if (!parsed.success) return undefined;
  const { server: _server, headers: _headers, ...rest } = parsed.data;
  return rest;
}

/** Whether an override changes anything (a login alone is not a change). */
export function toolServerOverrideChanges(
  config: OrgAgentToolServerConfig,
  override: Omit<OrgAgentToolServerOverride, "server" | "headers">,
): boolean {
  if (override.enabled === false) return true;
  if ((override.disableTools ?? []).length > 0) return true;
  if (override.tools && !sameSetting(override.tools, config.tools)) return true;
  if (override.approval && !sameSetting(override.approval, config.approval)) return true;
  if (override.eager && !sameSetting(unique(override.eager).sort(), unique(config.eager).sort()))
    return true;
  return false;
}

export function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * What a chat's override gives beyond the agent's own server config: tools the
 * agent left off, or "Ask first" taken away. Null when the override only
 * narrows (turns the server or tools off, or asks first for more tools).
 */
export function orgToolServerOverrideWidening(
  config: OrgAgentToolServerConfig,
  override: Omit<OrgAgentToolServerOverride, "server" | "headers">,
): string | null {
  if (override.enabled === false) return null;
  if (override.tools && config.tools.mode === "selected") {
    if (override.tools.mode === "all") {
      return `turns on every tool of '${config.server}'`;
    }
    const agentTools = new Set(config.tools.enabled);
    const added = unique(override.tools.enabled).filter((name) => !agentTools.has(name));
    if (added.length > 0) {
      return `turns on ${added.map((name) => `'${name}'`).join(", ")} on '${config.server}'`;
    }
  }
  if (override.approval && config.approval.ask !== override.approval.ask) {
    const chatAsk = override.approval.ask;
    if (chatAsk !== true) {
      if (config.approval.ask === true) {
        return `stops asking first for every tool of '${config.server}'`;
      }
      const asked = new Set(chatAsk);
      const removed = config.approval.ask.filter((name) => !asked.has(name));
      if (removed.length > 0) {
        return `stops asking first for ${removed.map((name) => `'${name}'`).join(", ")} on '${config.server}'`;
      }
    }
  }
  return null;
}

/**
 * A narrowing override applied to another version of the server config: the
 * chat's tool selection stays within the version's tools and the version's
 * "Ask first" tools stay asked. A move never gives a chat more than its new
 * version does through an override that only narrowed the old one.
 */
export function narrowOrgToolServerOverride(
  config: OrgAgentToolServerConfig,
  override: Omit<OrgAgentToolServerOverride, "server" | "headers">,
): Omit<OrgAgentToolServerOverride, "server" | "headers"> {
  const narrowed = { ...override };
  if (override.tools && config.tools.mode === "selected") {
    const agentTools = new Set(config.tools.enabled);
    narrowed.tools =
      override.tools.mode === "all"
        ? config.tools
        : {
            mode: "selected",
            enabled: unique(override.tools.enabled).filter((name) => agentTools.has(name)),
          };
  }
  if (override.approval) {
    const chatAsk = override.approval.ask;
    const agentAsk = config.approval.ask;
    narrowed.approval = {
      ask: chatAsk === true || agentAsk === true ? true : unique([...agentAsk, ...chatAsk]),
    };
  }
  return narrowed;
}

/** The chat-facing view of a session MCP server input (no headers). */
export function sessionMcpServerSetting(server: SessionMcpServerInput): Record<string, unknown> {
  const { headers: _headers, ...rest } = server;
  return withoutUndefined(rest as Record<string, unknown>);
}

/* ------------------------------------------------------------------- moves */

export type OrgAgentMoveServerRow = {
  id: string;
  name?: string | null;
  url: string;
  allowedTools?: string[] | null;
  timeoutMs?: number | null;
  cacheToolsList?: boolean | null;
  requireApproval?: boolean | string[] | null;
  connectionRef?: unknown;
  headersEncrypted?: Record<string, string>;
};

export type OrgAgentMovePlan<Row extends OrgAgentMoveServerRow> = {
  /** The chat's complete MCP server list after the move. */
  servers: Row[];
  removedServerIds: string[];
  upsertedServerIds: string[];
  tools: ToolRef[];
  overrides: OrgAgentSessionOverrides | null;
};

/**
 * Move a chat to another version of its agent: the agent's servers are
 * materialized again for the new version with the chat's recorded tool
 * server changes applied, servers the chat added or replaced stay as they
 * are, and the recorded changes are compared again with the new version.
 * A server's per-chat login stays with it while its URL is unchanged.
 */
export function planOrgAgentSessionMove<Row extends OrgAgentMoveServerRow>(input: {
  currentServers: readonly Row[];
  currentTools: readonly ToolRef[];
  fromConfig: OrgAgentVersionConfig | null;
  toConfig: OrgAgentVersionConfig;
  toToolCatalog: unknown;
  toolServers: ReadonlyMap<string, OrgToolServerRef>;
  liveTools?: ReadonlyMap<string, readonly string[] | null>;
  overrides: OrgAgentSessionOverrides | null;
}): OrgAgentMovePlan<Row> {
  const overrides = input.overrides ?? {};
  const chatServerIds = new Set(
    Object.keys(overrides)
      .filter((key) => key.startsWith("mcpServers."))
      .map((key) => key.slice("mcpServers.".length)),
  );
  const fromKeys = new Set((input.fromConfig?.toolServers ?? []).map((server) => server.server));
  const current = new Map(input.currentServers.map((server) => [server.id, server]));
  const kept: Row[] = input.currentServers.filter(
    (server) => chatServerIds.has(server.id) || !fromKeys.has(server.id),
  );
  const keptIds = new Set(kept.map((server) => server.id));
  const agentServers: Row[] = [];
  const nextOverrides: OrgAgentSessionOverrides = {};
  for (const config of input.toConfig.toolServers) {
    if (chatServerIds.has(config.server) || keptIds.has(config.server)) continue;
    const server = input.toolServers.get(config.server);
    if (!server) continue;
    const recordedKey = `toolServers.${config.server}`;
    const recordedChange = recordedToolServerOverride(overrides[recordedKey]?.chat);
    // A change that only narrowed the old version narrows the new one too.
    const fromServer = input.fromConfig?.toolServers.find(
      (candidate) => candidate.server === config.server,
    );
    const recorded =
      recordedChange &&
      (!fromServer || orgToolServerOverrideWidening(fromServer, recordedChange) === null)
        ? narrowOrgToolServerOverride(config, recordedChange)
        : recordedChange;
    if (recorded && toolServerOverrideChanges(config, recorded)) {
      nextOverrides[recordedKey] = { agent: config, chat: recorded };
    }
    const effective = effectiveOrgToolServerConfig(config, recorded);
    if (!effective) continue;
    const materialized = materializeOrgToolServer({
      server,
      effective,
      catalogNames: orgAgentCatalogToolNames(input.toToolCatalog, config.server),
      liveNames: input.liveTools?.get(config.server) ?? null,
    });
    const previous = current.get(config.server);
    agentServers.push({
      ...(previous ?? {}),
      id: materialized.id,
      name: materialized.name,
      url: materialized.url,
      allowedTools: materialized.allowedTools ?? null,
      requireApproval: materialized.requireApproval ?? null,
      timeoutMs: previous?.timeoutMs ?? null,
      cacheToolsList: previous?.cacheToolsList ?? false,
      connectionRef: previous?.connectionRef ?? null,
      headersEncrypted:
        previous && previous.url === materialized.url
          ? { ...(previous.headersEncrypted ?? {}) }
          : {},
      // The eager marker lives on the chat's tool ref, not the server row.
      eager: materialized.eager,
    } as Row & { eager?: string[] });
  }
  for (const [key, change] of Object.entries(overrides)) {
    if (key.startsWith("toolServers.")) continue;
    if (key.startsWith("mcpServers.")) {
      const id = key.slice("mcpServers.".length);
      const agentServer = input.toConfig.toolServers.find((server) => server.server === id);
      nextOverrides[key] = {
        agent: agentServer && input.toolServers.has(id) ? agentServer : null,
        chat: change.chat,
      };
      continue;
    }
    if (key === "instructions") {
      nextOverrides[key] = change;
      continue;
    }
    const agentValue = (input.toConfig as Record<string, unknown>)[key] ?? null;
    if (!sameSetting(agentValue, change.chat))
      nextOverrides[key] = { agent: agentValue, chat: change.chat };
  }
  const nextAgentIds = new Set(agentServers.map((server) => server.id));
  const removedServerIds = input.currentServers
    .filter((server) => !keptIds.has(server.id) && !nextAgentIds.has(server.id))
    .map((server) => server.id);
  const removed = new Set(removedServerIds);
  const eagerById = new Map(
    agentServers.map((server) => [server.id, (server as Row & { eager?: string[] }).eager]),
  );
  const tools: ToolRef[] = [];
  const seen = new Set<string>();
  for (const tool of input.currentTools) {
    if (tool.kind === "mcp" && removed.has(tool.id)) continue;
    if (tool.kind === "mcp" && eagerById.has(tool.id)) {
      const eager = eagerById.get(tool.id);
      const { eager: _eager, ...rest } = tool;
      tools.push({ ...rest, ...(eager ? { eager } : {}) });
    } else {
      tools.push(tool);
    }
    seen.add(tool.id);
  }
  for (const server of agentServers) {
    if (seen.has(server.id)) continue;
    const eager = eagerById.get(server.id);
    tools.push({ kind: "mcp", id: server.id, ...(eager ? { eager } : {}) });
  }
  const servers = [
    ...kept,
    ...agentServers.map((server) => {
      const { eager: _eager, ...row } = server as Row & { eager?: string[] };
      return row as Row;
    }),
  ];
  return {
    servers,
    removedServerIds,
    upsertedServerIds: agentServers.map((server) => server.id),
    tools,
    overrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : null,
  };
}
