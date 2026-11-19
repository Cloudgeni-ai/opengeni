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
  type CreateOrgAgentTestChatRequest,
  type CreateOrgAgentTestChatResponse,
  type CreateOrgToolServerRequest,
  type ListOrgAgentComputeResponse,
  type ListOrgAgentSessionsResponse,
  type ListOrgAgentPublishOperationsResponse,
  type ListOrgAgentVersionsResponse,
  type ListOrgAgentsResponse,
  type ListOrgToolServersResponse,
  type ListWorkspaceOrgAgentsResponse,
  type OrgAgent,
  type OrgAgentComputeOption,
  type OrgAgentDefinitionInput,
  type OrgAgentNewToolsPolicy,
  type OrgAgentRunsOn,
  type OrgAgentSessionOverrides,
  type OrgAgentTestWorkspaceResponse,
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
  type SaveOrgAgentDraftResponse,
  type SetOrgAgentManagementRequest,
  type UpdateOrgAgentRequest,
  type UpdateOrgToolServerRequest,
} from "@opengeni/contracts";
import { useSharedQuery } from "@opengeni/react/app/lib/shared-query";
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
      (await client.requestJson<SaveOrgAgentDraftResponse>("PUT", `${agent(id)}/draft`, request))
        .agent,
    listVersions: (id: string, signal?: AbortSignal) =>
      client.requestJson<ListOrgAgentVersionsResponse>(
        "GET",
        `${agent(id)}/versions`,
        undefined,
        {},
        opts(signal),
      ),
    movableChats: (id: string, version: number, signal?: AbortSignal) =>
      client.requestJson<{ count: number }>(
        "GET",
        `${agent(id)}/movable-chats`,
        undefined,
        { version: String(version) },
        opts(signal),
      ),
    publish: (id: string, request: PublishOrgAgentRequest) =>
      client.requestJson<PublishOrgAgentResponse>("POST", `${agent(id)}/publish`, request),
    /** The operation from the agent's recent publish operations (there is no single-operation read). */
    getPublishOperation: async (id: string, operationId: string, signal?: AbortSignal) => {
      const { operations } = await client.requestJson<ListOrgAgentPublishOperationsResponse>(
        "GET",
        `${agent(id)}/publish-operations`,
        undefined,
        {},
        opts(signal),
      );
      return operations.find((operation) => operation.id === operationId) ?? null;
    },
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
    startTestChat: (id: string, request: CreateOrgAgentTestChatRequest) =>
      client.requestJson<CreateOrgAgentTestChatResponse>(
        "POST",
        `${agent(id)}/test-chats`,
        request,
      ),
    /** Organization machines and Sandbox Environments "Runs on" can pick. */
    listCompute: (signal?: AbortSignal) =>
      client.requestJson<ListOrgAgentComputeResponse>(
        "GET",
        `${base}/agents/compute`,
        undefined,
        {},
        opts(signal),
      ),
    listToolServers: (signal?: AbortSignal) =>
      client.requestJson<ListOrgToolServersResponse>(
        "GET",
        `${base}/agents/tool-servers`,
        undefined,
        {},
        opts(signal),
      ),
    getToolServer: async (key: string, signal?: AbortSignal) =>
      (
        await client.requestJson<{ toolServer: OrgToolServer }>(
          "GET",
          `${base}/agents/tool-servers/${encode(key)}`,
          undefined,
          {},
          opts(signal),
        )
      ).toolServer,
    createToolServer: async (request: CreateOrgToolServerRequest) =>
      (
        await client.requestJson<{ toolServer: OrgToolServer }>(
          "POST",
          `${base}/agents/tool-servers`,
          request,
        )
      ).toolServer,
    updateToolServer: async (key: string, request: UpdateOrgToolServerRequest) =>
      (
        await client.requestJson<{ toolServer: OrgToolServer }>(
          "PATCH",
          `${base}/agents/tool-servers/${encode(key)}`,
          request,
        )
      ).toolServer,
    deleteToolServer: (key: string) =>
      client.requestJson<unknown>("DELETE", `${base}/agents/tool-servers/${encode(key)}`),
    listToolServerTools: (key: string, signal?: AbortSignal) =>
      client.requestJson<OrgToolServerToolsResponse>(
        "GET",
        `${base}/agents/tool-servers/${encode(key)}/tools`,
        undefined,
        {},
        opts(signal),
      ),
  };
}

export type OrgAgentsApi = ReturnType<typeof orgAgentsApi>;

/** The app's read-only list: organization agents available in one workspace. */
export async function listWorkspaceOrgAgents(
  client: OrgAgentsTransport,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ListWorkspaceOrgAgentsResponse> {
  return await client.requestJson<ListWorkspaceOrgAgentsResponse>(
    "GET",
    `/v1/workspaces/${encode(workspaceId)}/organization-agents`,
    undefined,
    {},
    signal ? { signal } : {},
  );
}

/* ------------------------------------------------------------------- flag */

/**
 * Whether Console agents are on for an organization: the per-organization
 * flag. The agent routes answer 404 while it is off (and on older servers), so
 * the flag is whether the organization's agent list can be read. null while
 * the first read is in flight. One shared read per client and organization.
 */
export function useOrgAgentsFlag(
  client: OrgAgentsTransport,
  organizationId: string | null,
): boolean | null {
  const query = useSharedQuery(
    client,
    ["console", "org-agents-flag", organizationId],
    (signal) =>
      client.requestJson<ListOrgAgentsResponse>(
        "GET",
        `/v1/organizations/${encode(organizationId ?? "")}/agents`,
        undefined,
        {},
        { signal },
      ),
    { enabled: Boolean(organizationId), staleTimeMs: 300_000 },
  );
  if (!organizationId) return false;
  if (query.data) return true;
  if (query.error) return false;
  return null;
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

/**
 * Whether two definitions behave the same (same canonical JSON, so the same
 * config hash). A definition being edited may be incomplete for a moment (an
 * Organization machine not picked yet): that is a change, not an error.
 */
export function sameDefinition(left: OrgAgentDefinitionInput, right: OrgAgentDefinitionInput) {
  try {
    return canonicalOrgAgentDefinitionJson(left) === canonicalOrgAgentDefinitionJson(right);
  } catch {
    return false;
  }
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
 *
 * `live` is null while the list is loading or when the server couldn't list
 * its tools: the rows then come from the version's catalog and selection, and
 * nothing is marked new or gone.
 */
export function toolRows(
  server: OrgAgentToolServerConfig,
  live: readonly OrgAgentToolCatalogEntry[] | null,
  catalog: OrgAgentToolCatalog | null | undefined,
): ToolRow[] {
  const known = catalog?.[server.server];
  const liveKnown = live !== null;
  const offered = live ?? known ?? [];
  const knownNames = known && liveKnown ? new Set(known.map((tool) => tool.name)) : null;
  const liveNames = new Set(offered.map((tool) => tool.name));
  const askAll = server.approval.ask === true;
  const askList = new Set(server.approval.ask === true ? [] : server.approval.ask);
  const enabled = new Set(server.tools.enabled);
  const rows: ToolRow[] = offered.map((tool) => {
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
      gone: liveKnown,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The value the chat runs with. A tool server change names only the fields it
 * changes, so it is shown on top of the agent's server settings and the diff
 * shows just those fields.
 */
function effectiveChatValue(setting: string, agent: unknown, chat: unknown): unknown {
  if (!setting.startsWith("toolServers.") || !isPlainObject(agent) || !isPlainObject(chat)) {
    return chat;
  }
  return { ...agent, ...chat };
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
      chat: overrideValueText(effectiveChatValue(setting, change?.agent, change?.chat)),
    }))
    .sort(
      (left, right) =>
        rank(left.setting) - rank(right.setting) || left.setting.localeCompare(right.setting),
    );
}

export function hasOverrides(overrides: OrgAgentSessionOverrides | null | undefined): boolean {
  return Boolean(overrides && Object.keys(overrides).length > 0);
}

/* ---------------------------------------------------------------- runs on */

/** "Runs on" choices; `default` is an omitted `runsOn` (the workspace's usual placement). */
export type RunsOnChoice = "default" | OrgAgentRunsOn["kind"];

export const RUNS_ON_CHOICES: readonly {
  value: RunsOnChoice;
  label: string;
  description: string;
}[] = [
  {
    value: "default",
    label: "Workspace default",
    description: "Chats run where other chats in the workspace do.",
  },
  { value: "none", label: "No computer", description: "Tools and API only." },
  { value: "sandbox", label: "Cloud sandbox", description: "Each chat gets its own sandbox." },
  {
    value: "machine",
    label: "Organization machine",
    description: "Every chat runs on one machine.",
  },
];

export function runsOnChoice(runsOn: OrgAgentRunsOn | undefined): RunsOnChoice {
  return runsOn?.kind ?? "default";
}

/** The `runsOn` a choice saves; picking a kind keeps nothing from the previous kind. */
export function runsOnForChoice(choice: RunsOnChoice): OrgAgentRunsOn | undefined {
  return choice === "default" ? undefined : { kind: choice };
}

/**
 * The machine or environment a `runsOn` reference names: by id (a machine
 * also by its sandbox id), else by name, ignoring case, like the server.
 */
export function computeOptionFor(
  options: readonly OrgAgentComputeOption[] | null | undefined,
  ref: string | undefined,
): OrgAgentComputeOption | null {
  if (!ref || !options) return null;
  const byId = options.find((option) => option.id === ref || option.sandboxId === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const named = options.filter((option) => option.name.trim().toLowerCase() === wanted);
  return named.length === 1 ? named[0]! : null;
}

export const COMPUTE_NOT_IN_MANAGED_WORKSPACES =
  "Not available in product-managed workspaces. Change where it can be used.";

/** The "Runs on" menu, with the choice its built-in tools suggest marked. */
export function runsOnMenuOptions(suggested: "none" | "sandbox") {
  return RUNS_ON_CHOICES.map((option) => ({
    ...option,
    meta: option.value === suggested ? "Suggested" : undefined,
  }));
}

/**
 * A machine or environment menu: only ones that work in product-managed
 * workspaces can be picked; the others say why. A reference from code that
 * names nothing in the loaded list still shows, and says so.
 */
export function computeMenuOptions(
  list: readonly OrgAgentComputeOption[] | null | undefined,
  ref: string | undefined,
) {
  const entries: {
    value: string;
    label: string;
    disabled?: boolean;
    disabledReason?: string;
  }[] = (list ?? []).map((entry) =>
    entry.worksInManagedWorkspaces
      ? { value: entry.id, label: entry.name }
      : {
          value: entry.id,
          label: entry.name,
          disabled: true,
          disabledReason: COMPUTE_NOT_IN_MANAGED_WORKSPACES,
        },
  );
  if (ref && list && !computeOptionFor(list, ref)) {
    entries.push({
      value: ref,
      label: ref,
      disabled: true,
      disabledReason: "Not found in this organization.",
    });
  }
  return entries;
}
