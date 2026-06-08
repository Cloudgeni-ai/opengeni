import { readdir, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Settings } from "@opengeni/config";
import {
  CapabilityCatalogItem,
  type CapabilityCatalogResponse,
  type CapabilityInstallation,
  type CapabilityKind,
  type CreateCapabilityCatalogItemRequest,
  type EnableCapabilityRequest,
} from "@opengeni/contracts";
import {
  disableCapabilityInstallation,
  enableCapabilityInstallation,
  enablePackInstallation,
  getCapabilityCatalogItem,
  getCapabilityInstallation,
  listCapabilityCatalogItems,
  listCapabilityInstallations,
  listEnabledMcpCapabilityServers,
  listPackInstallations,
  mcpServerIdForCapability,
  updatePackInstallationStatus,
  upsertCapabilityCatalogItem,
  type Database,
  type EnabledMcpCapabilityServer,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { getCapabilityPack, listCapabilityPacks } from "./packs";

const officialMcpRegistryUrl = "https://registry.modelcontextprotocol.io";
const firstPartyMcpServerIds = new Set(["opengeni", "files", "docs"]);
const mcpRegistryFetchTimeoutMs = 15000;
const mcpRegistryMaxPages = 3;
const mcpCapabilityProbeTimeoutMs = 15000;

export async function buildCapabilityCatalog(input: {
  db: Database;
  workspaceId: string;
  settings: Settings;
}): Promise<CapabilityCatalogResponse> {
  const [
    persistedItems,
    capabilityInstallations,
    packInstallations,
    bundledSkills,
  ] = await Promise.all([
    listCapabilityCatalogItems(input.db, input.workspaceId),
    listCapabilityInstallations(input.db, input.workspaceId),
    listPackInstallations(input.db, input.workspaceId),
    discoverBundledSkills(),
  ]);
  const capabilityInstallationById = new Map(capabilityInstallations.map((installation) => [installation.capabilityId, installation]));
  const activePackIds = new Set(packInstallations.filter((installation) => installation.status === "active").map((installation) => installation.packId));
  const builtIns = [
    ...packCatalogItems(),
    ...configuredMcpCatalogItems(input.settings),
    ...platformApiCatalogItems(),
    ...bundledSkills,
  ];
  const items = dedupeCatalogItems([...builtIns, ...persistedItems])
    .map((item) => applyCapabilityEnablement(item, capabilityInstallationById.get(item.id), activePackIds))
    .sort(compareCatalogItems);
  return {
    items,
    installations: capabilityInstallations,
  };
}

export async function createCatalogItem(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  payload: CreateCapabilityCatalogItemRequest;
}): Promise<CapabilityCatalogItem> {
  const id = input.payload.id?.trim() || generatedCapabilityId(input.payload);
  if (id.startsWith("pack:")) {
    throw new HTTPException(422, { message: "packs are managed by OpenGeni and cannot be manually created" });
  }
  const source = input.payload.source === "built_in" || input.payload.source === "configured" ? "manual" : input.payload.source;
  const metadata = {
    ...input.payload.metadata,
    ...(input.payload.kind === "mcp" && input.payload.endpointUrl && !input.payload.metadata.mcpServerId
      ? { mcpServerId: mcpServerIdForCapability(id, input.payload.metadata) }
      : {}),
  };
  return await upsertCapabilityCatalogItem(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    id,
    kind: input.payload.kind,
    source,
    name: input.payload.name.trim(),
    description: input.payload.description?.trim() || null,
    category: input.payload.category.trim() || "custom",
    tags: uniqueTags(input.payload.tags),
    homepageUrl: input.payload.homepageUrl ?? null,
    endpointUrl: input.payload.endpointUrl ?? null,
    installUrl: input.payload.installUrl ?? null,
    authModel: input.payload.authModel?.trim() || null,
    metadata,
  });
}

export async function enableCapability(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  settings: Settings;
  capabilityId: string;
  payload: EnableCapabilityRequest;
  probeMcpServer?: McpCapabilityProbe;
}): Promise<CapabilityInstallation> {
  const item = await requireCatalogItem(input.db, input.workspaceId, input.settings, input.capabilityId);
  if (item.kind === "mcp" && !item.runtime.available) {
    throw new HTTPException(422, { message: "MCP capabilities need a remote streamable HTTP endpoint before they can be enabled" });
  }
  let installationMetadata = input.payload.metadata;
  if (item.kind === "mcp") {
    installationMetadata = {
      ...installationMetadata,
      ...await validateMcpCapabilityConnection(item, input.probeMcpServer),
    };
  }
  if (item.kind === "pack") {
    const packId = packIdFromCapabilityId(item.id);
    const pack = getCapabilityPack(packId);
    if (!pack) {
      throw new HTTPException(404, { message: "pack not found" });
    }
    await enablePackInstallation(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      packId,
      metadata: {
        ...input.payload.metadata,
        packVersion: pack.version,
      },
    });
  }
  return await enableCapabilityInstallation(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    capabilityId: item.id,
    kind: item.kind,
    config: input.payload.config,
    metadata: installationMetadata,
  });
}

export type McpCapabilityProbeInput = {
  id: string;
  name: string;
  url: string;
  timeoutMs: number;
};

export type McpCapabilityProbeResult = {
  toolCount: number;
};

export type McpCapabilityProbe = (input: McpCapabilityProbeInput) => Promise<McpCapabilityProbeResult>;

export async function validateMcpCapabilityConnection(
  item: CapabilityCatalogItem,
  probe: McpCapabilityProbe = probeStreamableHttpMcpServer,
): Promise<Record<string, unknown>> {
  if (item.kind !== "mcp") {
    return {};
  }
  if (!item.endpointUrl || !item.runtime.mcpServerId) {
    throw new HTTPException(422, { message: "MCP capabilities need a remote streamable HTTP endpoint before they can be enabled" });
  }
  try {
    const result = await probe({
      id: item.runtime.mcpServerId,
      name: item.name,
      url: item.endpointUrl,
      timeoutMs: mcpCapabilityProbeTimeoutMs,
    });
    return {
      mcpConnectivity: {
        status: "ok",
        checkedAt: new Date().toISOString(),
        toolCount: result.toolCount,
      },
    };
  } catch (error) {
    throw new HTTPException(422, {
      message: `MCP capability "${item.name}" could not be enabled because OpenGeni could not initialize ${item.endpointUrl}: ${mcpProbeErrorMessage(error)}`,
    });
  }
}

async function probeStreamableHttpMcpServer(input: McpCapabilityProbeInput): Promise<McpCapabilityProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const client = new Client({ name: "opengeni-capability-probe", version: "0.1.0" }, { capabilities: {} });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(input.url), {
      requestInit: { signal: controller.signal },
    });
    await client.connect(transport as unknown as Transport, { timeout: input.timeoutMs, maxTotalTimeout: input.timeoutMs });
    const tools = await client.listTools(undefined, { timeout: input.timeoutMs, maxTotalTimeout: input.timeoutMs });
    return { toolCount: tools.tools.length };
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => undefined);
  }
}

function mcpProbeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error";
}

export async function disableCapability(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  settings: Settings;
  capabilityId: string;
}): Promise<CapabilityInstallation> {
  const item = await requireCatalogItem(input.db, input.workspaceId, input.settings, input.capabilityId);
  if ((item.source === "built_in" || item.source === "configured") && item.kind !== "pack") {
    throw new HTTPException(409, { message: "built-in and configured capabilities are always available; remove them from configuration to disable them" });
  }
  if (item.kind === "pack") {
    await updatePackInstallationStatus(input.db, input.workspaceId, packIdFromCapabilityId(item.id), "disabled").catch(() => undefined);
    if (!await getCapabilityInstallation(input.db, input.workspaceId, item.id)) {
      await enableCapabilityInstallation(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        capabilityId: item.id,
        kind: "pack",
        metadata: {},
        config: {},
      });
    }
  } else if (!await getCapabilityInstallation(input.db, input.workspaceId, item.id)) {
    throw new HTTPException(409, { message: "capability is not currently enabled" });
  }
  return await disableCapabilityInstallation(input.db, input.workspaceId, item.id);
}

export async function settingsWithEnabledCapabilityMcpServers(db: Database, workspaceId: string, settings: Settings): Promise<Settings> {
  const enabled = await listEnabledMcpCapabilityServers(db, workspaceId);
  return settingsWithMcpCapabilityServers(settings, enabled);
}

export function settingsWithMcpCapabilityServers(settings: Settings, enabled: EnabledMcpCapabilityServer[]): Settings {
  if (enabled.length === 0) {
    return settings;
  }
  const existingIds = new Set(settings.mcpServers.map((server) => server.id));
  const dynamicServers = enabled
    .filter((server) => !existingIds.has(server.id))
    .map((server) => ({
      id: server.id,
      name: server.name,
      url: server.url,
      ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
      ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
      cacheToolsList: server.cacheToolsList ?? false,
    }));
  return dynamicServers.length ? { ...settings, mcpServers: [...settings.mcpServers, ...dynamicServers] } : settings;
}

export async function discoverMcpRegistryCapabilities(input: {
  query?: string;
  limit?: number;
  fetchImpl?: McpRegistryFetch;
  timeoutMs?: number;
}): Promise<CapabilityCatalogItem[]> {
  const query = (input.query ?? "").trim().toLowerCase();
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
  const items: CapabilityCatalogItem[] = [];
  const seen = new Set<string>();
  const fetchOptions: { fetchImpl?: McpRegistryFetch; timeoutMs?: number } = {};
  if (input.fetchImpl) {
    fetchOptions.fetchImpl = input.fetchImpl;
  }
  if (input.timeoutMs !== undefined) {
    fetchOptions.timeoutMs = input.timeoutMs;
  }
  let cursor: string | undefined;
  let pages = 0;

  while (items.length < limit && pages < mcpRegistryMaxPages) {
    pages += 1;
    const url = new URL("/v0.1/servers", officialMcpRegistryUrl);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("version", "latest");
    if (query) {
      url.searchParams.set("search", query);
    }
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    const page = await fetchMcpRegistryPage(url, fetchOptions);
    for (const entry of page.servers ?? []) {
      const item = mcpRegistryEntryToCatalogItem(entry);
      if (!item || seen.has(item.id)) {
        continue;
      }
      if (query && !catalogSearchText(item).includes(query)) {
        continue;
      }
      seen.add(item.id);
      items.push(item);
      if (items.length >= limit) {
        break;
      }
    }
    cursor = typeof page.metadata?.nextCursor === "string" ? page.metadata.nextCursor : undefined;
    if (!cursor) {
      break;
    }
  }

  return items;
}

export { officialMcpRegistryUrl };

type McpRegistryFetch = (input: URL, init?: RequestInit) => Promise<Response>;

async function fetchMcpRegistryPage(url: URL, options: {
  fetchImpl?: McpRegistryFetch;
  timeoutMs?: number;
} = {}): Promise<McpRegistryPage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? mcpRegistryFetchTimeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new HTTPException(502, { message: `MCP registry returned ${response.status}` });
    }
    return await response.json() as McpRegistryPage;
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new HTTPException(504, { message: "MCP registry request timed out" });
    }
    throw new HTTPException(502, {
      message: `MCP registry request failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requireCatalogItem(db: Database, workspaceId: string, settings: Settings, capabilityId: string): Promise<CapabilityCatalogItem> {
  const catalog = await buildCapabilityCatalog({ db, workspaceId, settings });
  const item = catalog.items.find((candidate) => candidate.id === capabilityId) ?? await getCapabilityCatalogItem(db, workspaceId, capabilityId);
  if (!item) {
    throw new HTTPException(404, { message: "capability not found" });
  }
  return item;
}

function packCatalogItems(): CapabilityCatalogItem[] {
  return listCapabilityPacks().map((pack) => CapabilityCatalogItem.parse({
    id: `pack:${pack.id}`,
    kind: "pack",
    source: "built_in",
    name: pack.name,
    description: pack.description,
    category: pack.category,
    tags: [pack.role, pack.category, "pack"],
    tools: pack.tools,
    runtime: {
      available: true,
      notes: "Enables role-scoped tools, connectors, knowledge, and scheduled-task templates.",
    },
    metadata: {
      packId: pack.id,
      version: pack.version,
      connectors: pack.connectors,
      knowledge: pack.knowledge,
      scheduledTaskTemplates: pack.scheduledTaskTemplates,
      ...pack.metadata,
    },
  }));
}

function configuredMcpCatalogItems(settings: Settings): CapabilityCatalogItem[] {
  return settings.mcpServers.map((server) => CapabilityCatalogItem.parse({
    id: `mcp:${server.id}`,
    kind: "mcp",
    source: firstPartyMcpServerIds.has(server.id) ? "built_in" : "configured",
    name: server.name ?? server.id,
    description: firstPartyMcpDescription(server.id),
    category: firstPartyMcpServerIds.has(server.id) ? "platform" : "configured",
    tags: ["mcp", ...(server.allowedTools?.length ? ["limited-tools"] : [])],
    endpointUrl: server.url,
    tools: [{ kind: "mcp", id: server.id }],
    runtime: {
      available: true,
      mcpServerId: server.id,
      transport: "streamable-http",
      notes: firstPartyMcpServerIds.has(server.id) ? "Available from OpenGeni runtime configuration." : "Configured through OPENGENI_MCP_SERVERS.",
    },
    metadata: {
      mcpServerId: server.id,
      allowedTools: server.allowedTools ?? [],
      cacheToolsList: server.cacheToolsList,
    },
  }));
}

function platformApiCatalogItems(): CapabilityCatalogItem[] {
  return [
    {
      id: "api:github-app",
      name: "GitHub App",
      description: "Repository discovery, scoped clone tokens, pushes, and pull requests.",
      category: "source-control",
      tags: ["api", "github", "repositories"],
      endpointPath: "/v1/workspaces/{workspaceId}/github/app",
    },
    {
      id: "api:documents",
      name: "Document Knowledge Base",
      description: "Upload, index, search, and attach knowledge bases to agents.",
      category: "knowledge",
      tags: ["api", "documents", "knowledge"],
      endpointPath: "/v1/workspaces/{workspaceId}/document-bases",
    },
    {
      id: "api:social",
      name: "Social Accounts",
      description: "Connect social accounts and ingest posts for marketing agents.",
      category: "marketing",
      tags: ["api", "social", "marketing"],
      endpointPath: "/v1/workspaces/{workspaceId}/social/connections",
    },
    {
      id: "api:scheduled-tasks",
      name: "Scheduled Tasks",
      description: "Run agents once, on intervals, or on calendar schedules.",
      category: "automation",
      tags: ["api", "schedules", "agents"],
      endpointPath: "/v1/workspaces/{workspaceId}/scheduled-tasks",
    },
  ].map((item) => CapabilityCatalogItem.parse({
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category,
    tags: item.tags,
    kind: "api",
    source: "built_in",
    runtime: {
      available: true,
      notes: "Available through the OpenGeni API.",
    },
    metadata: {
      endpointPath: item.endpointPath,
    },
  }));
}

async function discoverBundledSkills(): Promise<CapabilityCatalogItem[]> {
  const skillsDir = new URL("../../../../packages/runtime/src/bundled_hashicorp_terraform_skills/", import.meta.url);
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skill = await readSkillMetadata(new URL(`${entry.name}/SKILL.md`, skillsDir), entry.name);
        return CapabilityCatalogItem.parse({
          id: `skill:${entry.name}`,
          kind: "skill",
          source: "built_in",
          name: skill.name,
          description: skill.description,
          category: skill.category,
          tags: ["skill", skill.category],
          runtime: {
            available: true,
            notes: "Bundled into the sandbox skill library.",
          },
          metadata: {
            path: `packages/runtime/src/bundled_hashicorp_terraform_skills/${entry.name}/SKILL.md`,
          },
        });
      }));
    return skills;
  } catch {
    return [];
  }
}

async function readSkillMetadata(url: URL, fallbackName: string): Promise<{ name: string; description: string | null; category: string }> {
  const content = await readFile(url, "utf8");
  const frontMatter = content.match(/^---\n([\s\S]*?)\n---/);
  const frontMatterBody = frontMatter?.[1] ?? "";
  const name = frontMatterBody.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
  const blockDescription = frontMatterBody.match(/^description:\s*>-\s*\n([\s\S]*?)(?:\n[a-zA-Z_-]+:|\n?$)/m)?.[1]
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  const inlineDescription = frontMatterBody.match(/^description:\s*(?!>-\s*$)(.+)$/m)?.[1]?.trim();
  const description = blockDescription
    || inlineDescription
    || content.match(/^#\s+(.+)$/m)?.[1]?.trim()
    || null;
  const lower = `${fallbackName} ${name} ${description ?? ""}`.toLowerCase();
  const category = lower.includes("social") || lower.includes("marketing")
    ? "marketing"
    : lower.includes("checkov") || lower.includes("terraform") || lower.includes("azure")
      ? "infrastructure"
      : "general";
  return { name, description, category };
}

function applyCapabilityEnablement(
  item: CapabilityCatalogItem,
  installation: CapabilityInstallation | undefined,
  activePackIds: Set<string>,
): CapabilityCatalogItem {
  if (item.source === "built_in" || item.source === "configured") {
    const packEnabled = item.kind === "pack" && activePackIds.has(packIdFromCapabilityId(item.id));
    const enabled = item.kind === "pack" ? packEnabled || installation?.status === "active" : true;
    return {
      ...item,
      enabled,
      enabledReason: enabled
        ? item.kind === "pack" ? "enabled" : item.source === "configured" ? "configured" : "built in"
      : null,
    };
  }
  const activeInstallation = installation?.status === "active";
  const enabled = !!activeInstallation && capabilityInstallationRuntimeReady(item, installation);
  return {
    ...item,
    enabled,
    enabledReason: enabled ? "enabled" : null,
  };
}

function dedupeCatalogItems(items: CapabilityCatalogItem[]): CapabilityCatalogItem[] {
  const byId = new Map<string, CapabilityCatalogItem>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function compareCatalogItems(a: CapabilityCatalogItem, b: CapabilityCatalogItem): number {
  return `${a.kind}:${a.category}:${a.name}`.localeCompare(`${b.kind}:${b.category}:${b.name}`);
}

function firstPartyMcpDescription(id: string): string | null {
  if (id === "opengeni") {
    return "First-party OpenGeni MCP tools for files, documents, schedules, and social analysis.";
  }
  if (id === "docs") {
    return "Document-base search tools for indexed knowledge.";
  }
  if (id === "files") {
    return "File download URL tools for sandbox-mounted file resources.";
  }
  return null;
}

function generatedCapabilityId(payload: CreateCapabilityCatalogItemRequest): string {
  const source = [payload.kind, payload.name, payload.endpointUrl ?? payload.installUrl ?? payload.homepageUrl ?? ""].join(":");
  return `${payload.kind}:${slugify(payload.name)}-${shortHash(source)}`;
}

function publicRegistryCapabilityId(name: string, version: string, endpointUrl: string): string {
  return `mcp-registry:${slugify(name)}-${shortHash(`${name}:${version}:${endpointUrl}`)}`;
}

function packIdFromCapabilityId(capabilityId: string): string {
  return capabilityId.replace(/^pack:/, "");
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "capability";
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}

type McpRegistryPage = {
  servers?: McpRegistryEntry[];
  metadata?: {
    nextCursor?: string;
  };
};

type McpRegistryEntry = {
  server?: {
    name?: string;
    title?: string;
    description?: string;
    version?: string;
    websiteUrl?: string;
    repository?: {
      url?: string;
    };
    remotes?: Array<{
      type?: string;
      url?: string;
      headers?: Array<{
        name?: string;
        description?: string;
        isRequired?: boolean;
        isSecret?: boolean;
      }>;
    }>;
    packages?: unknown[];
  };
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: {
      status?: string;
      isLatest?: boolean;
      updatedAt?: string;
    };
  };
};

type McpRegistryRemote = NonNullable<NonNullable<McpRegistryEntry["server"]>["remotes"]>[number];

function mcpRegistryEntryToCatalogItem(entry: McpRegistryEntry): CapabilityCatalogItem | null {
  const server = entry.server;
  if (!server?.name) {
    return null;
  }
  const official = entry._meta?.["io.modelcontextprotocol.registry/official"];
  if (official?.status && official.status !== "active") {
    return null;
  }
  if (official?.isLatest === false) {
    return null;
  }
  const remote = server.remotes?.find((candidate) => candidate.type === "streamable-http" && candidate.url);
  const endpointUrl = validUrl(remote?.url);
  if (!remote || !endpointUrl) {
    return null;
  }
  const version = server.version ?? "latest";
  const id = publicRegistryCapabilityId(server.name, version, endpointUrl);
  const homepageUrl = validUrl(server.websiteUrl) ?? validUrl(server.repository?.url);
  const requiredHeaders = requiredRemoteHeaders(remote);
  const runtimeAvailable = requiredHeaders.length === 0;
  const mcpServerId = mcpServerIdForCapability(id, {});
  return CapabilityCatalogItem.parse({
    id,
    kind: "mcp",
    source: "public_registry",
    name: server.title || server.name,
    description: server.description ?? null,
    category: "public-mcp",
    tags: ["mcp", "public", "registry", ...(requiredHeaders.length ? ["requires-credentials"] : [])],
    homepageUrl,
    endpointUrl,
    installUrl: homepageUrl,
    authModel: requiredHeaders.length ? "credential_ref" : null,
    tools: runtimeAvailable ? [{ kind: "mcp", id: mcpServerId }] : [],
    runtime: {
      available: runtimeAvailable,
      ...(runtimeAvailable ? { mcpServerId } : {}),
      transport: "streamable-http",
      notes: runtimeAvailable
        ? "Remote MCP server from the official MCP Registry."
        : "This MCP declares required remote headers. Capability credential injection is not implemented yet.",
    },
    metadata: {
      registry: "official_mcp_registry",
      registryName: server.name,
      version,
      updatedAt: official?.updatedAt,
      packages: server.packages ?? [],
      requiredHeaders,
    },
  });
}

function requiredRemoteHeaders(remote: McpRegistryRemote): string[] {
  return (remote.headers ?? [])
    .filter((header) => header.name && header.isRequired !== false)
    .map((header) => header.name!.trim())
    .filter(Boolean);
}

function validUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function catalogSearchText(item: CapabilityCatalogItem): string {
  return [
    item.name,
    item.description,
    item.category,
    ...item.tags,
    item.endpointUrl,
    item.homepageUrl,
    item.installUrl,
    JSON.stringify(item.metadata),
  ].filter(Boolean).join(" ").toLowerCase();
}

function capabilityInstallationRuntimeReady(
  item: CapabilityCatalogItem,
  installation: CapabilityInstallation | undefined,
): boolean {
  if (!installation || item.kind !== "mcp") {
    return !!installation;
  }
  if (!item.runtime.available || item.authModel) {
    return false;
  }
  const connectivity = installation.metadata.mcpConnectivity;
  return !!connectivity && typeof connectivity === "object" && "status" in connectivity && connectivity.status === "ok";
}
