// Console agents (organization agents): the calls Console makes and the pure
// helpers its pages share. Every call goes to the same public routes an API
// key uses (`/v1/organizations/:organizationId/agents`, `/tool-servers`), so
// Console has no routes of its own. The wire shapes are the contracts in
// `@opengeni/contracts` (organization-agents.ts).
import {
  OrgAgentDefinition,
  OrgAgentFile,
  canonicalOrgAgentDefinitionJson,
  orgAgentDefinitionToFile,
  orgAgentFileToDefinition,
  type CreateOrgAgentRequest,
  type CreateOrgToolServerRequest,
  type ListOrgAgentSessionsResponse,
  type ListOrgAgentVersionsResponse,
  type ListOrgAgentsResponse,
  type ListOrgToolServersResponse,
  type OrgAgent,
  type OrgAgentDefinitionInput,
  type OrgAgentNewToolsPolicy,
  type OrgAgentPublishOperation,
  type OrgAgentSessionOverrides,
  type OrgAgentSummary,
  type OrgAgentToolCatalog,
  type OrgAgentToolCatalogEntry,
  type OrgAgentToolServerConfig,
  type OrgAgentVersion,
  type OrgAgentVersionSource,
  type OrgToolServer,
  type OrgToolServerAuthMode,
  type OrgToolServerToolsResponse,
  type PublishOrgAgentRequest,
  type PublishOrgAgentResponse,
  type SaveOrgAgentDraftRequest,
  type SetOrgAgentManagementRequest,
  type UpdateOrgAgentRequest,
  type UpdateOrgToolServerRequest,
} from "@opengeni/contracts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/* ------------------------------------------------------------------ calls */

type RequestOptions = { signal?: AbortSignal | undefined };

/** The one transport Console agents need: the SDK client's contract-checked JSON call. */
export type OrgAgentsTransport = {
  requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<T>;
};

/** `POST .../agents/test-workspace`: the organization's Console test workspace. */
export type OrgAgentTestWorkspaceResponse = { workspaceId: string };
/** `POST .../agents/:id/test-chats`: a test chat on one version (usually the draft). */
export type OrgAgentTestChatRequest = {
  version: number;
  message: string;
  /** A pasted test token per `per_user` tool server, used only as that chat's login. */
  toolLogins?: Record<string, string>;
};
export type OrgAgentTestChatResponse = { workspaceId: string; sessionId: string };
export type OrgAgentMovableChats = { count: number };
export type WorkspaceOrgAgentsResponse = { agents: OrgAgentSummary[] };

function encode(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Console's calls for agents and tool servers, by organization. Names follow
 * the SDK methods in docs/opengeni-console.md.
 */
export function orgAgentsApi(client: OrgAgentsTransport, organizationId: string) {
  const base = `/v1/organizations/${encode(organizationId)}`;
  const agent = (id: string) => `${base}/agents/${encode(id)}`;
  const opts = (signal?: AbortSignal) => (signal ? { signal } : {});
  return {
    listAgents: (signal?: AbortSignal) =>
      client.requestJson<ListOrgAgentsResponse>(
        "GET",
        `${base}/agents`,
        undefined,
        {},
        opts(signal),
      ),
    getAgent: async (idOrKey: string, signal?: AbortSignal) =>
      (
        await client.requestJson<{ agent: OrgAgent }>(
          "GET",
          agent(idOrKey),
          undefined,
          {},
          opts(signal),
        )
      ).agent,
    createAgent: async (request: CreateOrgAgentRequest) =>
      (await client.requestJson<{ agent: OrgAgent }>("POST", `${base}/agents`, request)).agent,
    updateAgent: async (id: string, request: UpdateOrgAgentRequest) =>
      (await client.requestJson<{ agent: OrgAgent }>("PATCH", agent(id), request)).agent,
    saveDraft: async (id: string, request: SaveOrgAgentDraftRequest) =>
      (await client.requestJson<{ agent: OrgAgent }>("PUT", `${agent(id)}/draft`, request)).agent,
    listVersions: (id: string, signal?: AbortSignal) =>
      client.requestJson<ListOrgAgentVersionsResponse>(
        "GET",
        `${agent(id)}/versions`,
        undefined,
        {},
        opts(signal),
      ),
    movableChats: (id: string, version: number, signal?: AbortSignal) =>
      client.requestJson<OrgAgentMovableChats>(
        "GET",
        `${agent(id)}/movable-chats`,
        undefined,
        { version: String(version) },
        opts(signal),
      ),
    publish: (id: string, request: PublishOrgAgentRequest) =>
      client.requestJson<PublishOrgAgentResponse>("POST", `${agent(id)}/publish`, request),
    getPublishOperation: async (id: string, operationId: string, signal?: AbortSignal) =>
      (
        await client.requestJson<{ operation: OrgAgentPublishOperation }>(
          "GET",
          `${agent(id)}/publish-operations/${encode(operationId)}`,
          undefined,
          {},
          opts(signal),
        )
      ).operation,
    setManagement: async (id: string, request: SetOrgAgentManagementRequest) =>
      (await client.requestJson<{ agent: OrgAgent }>("POST", `${agent(id)}/management`, request))
        .agent,
    archiveAgent: async (id: string, expectedVersion: number) =>
      (
        await client.requestJson<{ agent: OrgAgent }>("POST", `${agent(id)}/archive`, {
          expectedVersion,
        })
      ).agent,
    listSessions: (id: string, options: { cursor?: string | null; signal?: AbortSignal } = {}) =>
      client.requestJson<ListOrgAgentSessionsResponse>(
        "GET",
        `${agent(id)}/sessions`,
        undefined,
        options.cursor ? { cursor: options.cursor } : {},
        opts(options.signal),
      ),
    ensureTestWorkspace: () =>
      client.requestJson<OrgAgentTestWorkspaceResponse>(
        "POST",
        `${base}/agents/test-workspace`,
        {},
      ),
    startTestChat: (id: string, request: OrgAgentTestChatRequest) =>
      client.requestJson<OrgAgentTestChatResponse>("POST", `${agent(id)}/test-chats`, request),
    listToolServers: (signal?: AbortSignal) =>
      client.requestJson<ListOrgToolServersResponse>(
        "GET",
        `${base}/tool-servers`,
        undefined,
        {},
        opts(signal),
      ),
    getToolServer: async (key: string, signal?: AbortSignal) =>
      (
        await client.requestJson<{ toolServer: OrgToolServer }>(
          "GET",
          `${base}/tool-servers/${encode(key)}`,
          undefined,
          {},
          opts(signal),
        )
      ).toolServer,
    createToolServer: async (request: CreateOrgToolServerRequest) =>
      (
        await client.requestJson<{ toolServer: OrgToolServer }>(
          "POST",
          `${base}/tool-servers`,
          request,
        )
      ).toolServer,
    updateToolServer: async (key: string, request: UpdateOrgToolServerRequest) =>
      (
        await client.requestJson<{ toolServer: OrgToolServer }>(
          "PATCH",
          `${base}/tool-servers/${encode(key)}`,
          request,
        )
      ).toolServer,
    deleteToolServer: (key: string) =>
      client.requestJson<unknown>("DELETE", `${base}/tool-servers/${encode(key)}`),
    listToolServerTools: (key: string, signal?: AbortSignal) =>
      client.requestJson<OrgToolServerToolsResponse>(
        "GET",
        `${base}/tool-servers/${encode(key)}/tools`,
        undefined,
        {},
        opts(signal),
      ),
  };
}

export type OrgAgentsApi = ReturnType<typeof orgAgentsApi>;

/** The app's read-only list: organization agents available in one workspace. */
export function listWorkspaceOrgAgents(
  client: OrgAgentsTransport,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceOrgAgentsResponse> {
  return client.requestJson<WorkspaceOrgAgentsResponse>(
    "GET",
    `/v1/workspaces/${encode(workspaceId)}/organization-agents`,
    undefined,
    {},
    signal ? { signal } : {},
  );
}

/* ------------------------------------------------------------------- flag */

/**
 * Whether Console agents are on for an organization. The server reports the
 * flag in client config as `orgAgents` (true when every organization the
 * person reaches has it) or `orgAgentsAccountIds` (the organizations that do).
 */
export function orgAgentsEnabled(clientConfig: unknown, organizationId: string | null): boolean {
  if (!clientConfig || typeof clientConfig !== "object" || !organizationId) return false;
  const config = clientConfig as {
    orgAgents?: unknown;
    orgAgentsAccountIds?: unknown;
    features?: unknown;
  };
  if (Array.isArray(config.orgAgentsAccountIds)) {
    const id = organizationId.toLowerCase();
    return config.orgAgentsAccountIds.some(
      (value) => typeof value === "string" && value.toLowerCase() === id,
    );
  }
  if (config.orgAgents === true) return true;
  const features = config.features as { orgAgents?: unknown } | undefined;
  return Boolean(features && typeof features === "object" && features.orgAgents === true);
}

/* ------------------------------------------------------------- definitions */

/** A version's definition: what Save draft sends and Export as YAML writes. */
export function definitionOfVersion(
  version: Pick<OrgAgentVersion, "name" | "description" | "instructions" | "config">,
): OrgAgentDefinition {
  return OrgAgentDefinition.parse({
    name: version.name,
    description: version.description,
    instructions: version.instructions,
    config: version.config,
  });
}

/** Whether two definitions behave the same (same canonical JSON, so the same config hash). */
export function sameDefinition(left: OrgAgentDefinitionInput, right: OrgAgentDefinitionInput) {
  return canonicalOrgAgentDefinitionJson(left) === canonicalOrgAgentDefinitionJson(right);
}

/** `sha256:` + hex of the canonical JSON, as the server computes the config hash. */
export async function orgAgentConfigHash(definition: OrgAgentDefinitionInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalOrgAgentDefinitionJson(definition));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
}

/** The agent file (`agents/<key>.yaml`) for a definition. */
export function orgAgentYaml(key: string, definition: OrgAgentDefinitionInput): string {
  const file = orgAgentDefinitionToFile(key, OrgAgentDefinition.parse(definition));
  return stringifyYaml(file, { lineWidth: 0 });
}

/** Reads an agent file back (instructions inline): the inverse of {@link orgAgentYaml}. */
export function parseOrgAgentYaml(text: string) {
  return orgAgentFileToDefinition(OrgAgentFile.parse(parseYaml(text)));
}

/** Starts the download of `<key>.yaml`. */
export function downloadOrgAgentYaml(key: string, definition: OrgAgentDefinitionInput): void {
  const blob = new Blob([orgAgentYaml(key, definition)], { type: "application/yaml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${key}.yaml`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The version's settings as indented canonical JSON, for the versions diff. */
export function versionConfigText(
  version: Pick<OrgAgentVersion, "name" | "description" | "instructions" | "config">,
): string {
  const canonical = JSON.parse(canonicalOrgAgentDefinitionJson(definitionOfVersion(version))) as {
    config: unknown;
  };
  return JSON.stringify(canonical.config, null, 2);
}

/** A key from a name: "Support desk" → "support-desk". */
export function agentKeyFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[-_]+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 64);
}

export function versionSourceLabel(source: OrgAgentVersionSource): string {
  switch (source) {
    case "console":
      return "Console";
    case "deploy":
      return "Deploy";
    case "inline":
      return "Chat";
  }
}

/** "sha256:9f86d081884c…" → "9f86d081884c". */
export function shortConfigHash(hash: string): string {
  return hash.replace(/^sha256:/u, "").slice(0, 12);
}

export function authModeLabel(mode: OrgToolServerAuthMode): string {
  switch (mode) {
    case "per_user":
      return "Each user's login";
    case "shared_key":
      return "Shared key";
    case "none":
      return "No login";
  }
}

/* ----------------------------------------------------------- tool servers */

export type ToolRow = {
  name: string;
  description: string | undefined;
  on: boolean;
  ask: boolean;
  /** Offered now but not when the version was saved: `newTools` decides. */
  isNew: boolean;
  /** In the version but no longer offered by the server. */
  gone: boolean;
};

/**
 * One row per tool for the editor: the server's live list plus tools the
 * version names that the server no longer offers. A tool not in the version's
 * catalog is "new"; for `selected` mode its state follows `newTools` only
 * when it is not already listed.
 */
export function toolRows(
  server: OrgAgentToolServerConfig,
  live: readonly OrgAgentToolCatalogEntry[],
  catalog: OrgAgentToolCatalog | null | undefined,
): ToolRow[] {
  const known = catalog?.[server.server];
  const knownNames = known ? new Set(known.map((tool) => tool.name)) : null;
  const liveNames = new Set(live.map((tool) => tool.name));
  const askAll = server.approval.ask === true;
  const askList = new Set(server.approval.ask === true ? [] : server.approval.ask);
  const enabled = new Set(server.tools.enabled);
  const rows: ToolRow[] = live.map((tool) => {
    const isNew = knownNames !== null && !knownNames.has(tool.name);
    const listed = enabled.has(tool.name);
    const on =
      server.tools.mode === "all" || listed || (isNew && !listed && server.newTools !== "off");
    const ask =
      askAll ||
      askList.has(tool.name) ||
      (isNew && !listed && server.newTools === "on_with_approval");
    return { name: tool.name, description: tool.description, on, ask, isNew, gone: false };
  });
  for (const name of server.tools.mode === "selected" ? server.tools.enabled : []) {
    if (liveNames.has(name)) continue;
    rows.push({
      name,
      description: undefined,
      on: true,
      ask: askAll || askList.has(name),
      isNew: false,
      gone: true,
    });
  }
  return rows;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Turns one tool on or off. An "all tools" selection becomes the explicit list
 * of the server's tools minus the one turned off.
 */
export function withToolOn(
  server: OrgAgentToolServerConfig,
  name: string,
  on: boolean,
  liveNames: readonly string[],
): OrgAgentToolServerConfig {
  const current = server.tools.mode === "all" ? new Set(liveNames) : new Set(server.tools.enabled);
  if (on) current.add(name);
  else current.delete(name);
  const ask =
    server.approval.ask === true || on
      ? server.approval.ask
      : server.approval.ask.filter((tool) => tool !== name);
  return {
    ...server,
    tools: { mode: "selected", enabled: sortedUnique(current) },
    approval: { ask },
    eager: on ? server.eager : server.eager.filter((tool) => tool !== name),
  };
}

/** Turns "Ask first" on or off for one tool. "Every tool asks" becomes an explicit list. */
export function withToolAsk(
  server: OrgAgentToolServerConfig,
  name: string,
  ask: boolean,
  liveNames: readonly string[],
): OrgAgentToolServerConfig {
  const current = new Set(server.approval.ask === true ? liveNames : server.approval.ask);
  if (ask) current.add(name);
  else current.delete(name);
  return { ...server, approval: { ask: sortedUnique(current) } };
}

export function withNewTools(
  server: OrgAgentToolServerConfig,
  newTools: OrgAgentNewToolsPolicy,
): OrgAgentToolServerConfig {
  return { ...server, newTools };
}

/** A server added to an agent: every tool it offers now on, nothing asks, new tools off. */
export function newToolServerConfig(
  key: string,
  liveNames: readonly string[],
): OrgAgentToolServerConfig {
  return {
    server: key,
    tools: { mode: "selected", enabled: sortedUnique(liveNames) },
    approval: { ask: [] },
    eager: [],
    newTools: "off",
  };
}

export const NEW_TOOLS_OPTIONS: readonly { value: OrgAgentNewToolsPolicy; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
  { value: "on_with_approval", label: "On, ask first" },
];

/* --------------------------------------------------------------- overrides */

export type OverrideEntry = {
  setting: string;
  label: string;
  agent: string;
  chat: string;
};

const OVERRIDE_LABELS: Record<string, string> = {
  model: "Model",
  reasoningEffort: "Reasoning effort",
  instructions: "Instructions",
  capabilities: "Built-in tools",
  identity: "Identity",
  renderer: "Renderer",
  titleInstructions: "Title instructions",
};

function overrideLabel(setting: string): string {
  const known = OVERRIDE_LABELS[setting];
  if (known) return known;
  const [kind, ...rest] = setting.split(".");
  const name = rest.join(".");
  if (kind === "toolServers") return `Tool server ${name}`;
  if (kind === "mcpServers") return `Added server ${name}`;
  return setting;
}

/** A setting's value as text: strings as they are, anything else as indented JSON. */
export function overrideValueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/** What a chat changed from its agent version, one entry per setting, in a stable order. */
export function overrideEntries(
  overrides: OrgAgentSessionOverrides | null | undefined,
): OverrideEntry[] {
  if (!overrides) return [];
  const order = Object.keys(OVERRIDE_LABELS);
  const rank = (setting: string) => {
    const index = order.indexOf(setting);
    return index === -1 ? order.length : index;
  };
  return Object.entries(overrides)
    .map(([setting, change]) => ({
      setting,
      label: overrideLabel(setting),
      agent: overrideValueText(change?.agent),
      chat: overrideValueText(change?.chat),
    }))
    .sort(
      (left, right) =>
        rank(left.setting) - rank(right.setting) || left.setting.localeCompare(right.setting),
    );
}

export function hasOverrides(overrides: OrgAgentSessionOverrides | null | undefined): boolean {
  return Boolean(overrides && Object.keys(overrides).length > 0);
}
