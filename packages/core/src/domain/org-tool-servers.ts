/**
 * Console agents: an organization tool server's live tool list, for Console's
 * tool picker and the tool catalog captured when a version is saved.
 *
 * The list is fetched with the server's shared key (`shared_key`), no login
 * (`none`), or a login the caller passes for this request only (a Console
 * test login; never stored). A `per_user` server without such a login cannot
 * be listed and reports why in `error`. Results are cached in memory for 60
 * seconds per server version and login; a failure is returned as `error`,
 * never thrown.
 */
import { createHash } from "node:crypto";
import { createPinnedIntegrationTransport } from "@opengeni/capabilities";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  ORG_AGENT_TOOL_NAMES_MAX,
  type OrgAgentDefinition,
  type OrgAgentToolCatalog,
  type OrgAgentToolCatalogEntry,
  type OrgToolServerToolsResponse,
} from "@opengeni/contracts";
import {
  getOrgToolServerWithSecrets,
  readOrgToolServersWithSecrets,
  withAccountRls,
  type Database,
  type OrgToolServerWithSecrets,
} from "@opengeni/db";
import { boundMcpResponseBody, MCP_MAX_RESPONSE_BYTES } from "@opengeni/runtime/mcp-network";
import { collectConnectorToolPages } from "./connector-tool-permissions";
import { withMcpStreamableHttpClient } from "./mcp-streamable-http-client";

export const ORG_TOOL_SERVER_TOOLS_CACHE_MS = 60_000;
const CACHE_MAX_ENTRIES = 2_000;
const LIST_TIMEOUT_MS = 15_000;

/** Fetches a server's tools; replaceable in tests. */
export type OrgToolServerToolFetcher = (input: {
  settings: Settings;
  url: string;
  headers: Record<string, string>;
}) => Promise<{ name: string; description?: string | undefined }[]>;

const cache = new Map<string, { expiresAt: number; value: OrgToolServerToolsResponse }>();

/** Clears the in-memory cache (tests). */
export function clearOrgToolServerToolsCache(): void {
  cache.clear();
}

export const fetchOrgToolServerTools: OrgToolServerToolFetcher = async ({
  settings,
  url,
  headers,
}) => {
  const pinned = createPinnedIntegrationTransport({ network: settings });
  const deadline = AbortSignal.timeout(LIST_TIMEOUT_MS);
  return await withMcpStreamableHttpClient(
    {
      url,
      clientName: "opengeni-console-agents",
      clientVersion: "0.1.0",
      timeoutMs: LIST_TIMEOUT_MS,
      requestInit: { headers },
      fetch: async (target, init) =>
        boundMcpResponseBody(
          await pinned.fetch(target.toString(), {
            ...init,
            signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
          }),
          MCP_MAX_RESPONSE_BYTES,
        ),
    },
    (client) => collectConnectorToolPages(client, deadline),
  );
};

function catalogEntries(
  tools: readonly { name: string; description?: string | undefined }[],
): OrgAgentToolCatalogEntry[] {
  return tools
    .filter((tool) => typeof tool.name === "string" && tool.name.length > 0 && tool.name.length <= 200)
    .slice(0, ORG_AGENT_TOOL_NAMES_MAX)
    .map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === "string" && tool.description.length > 0
        ? { description: tool.description.slice(0, 4_000) }
        : {}),
    }));
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500) || "The tool server did not answer.";
}

/** The headers the list is fetched with, or why it cannot be. */
function listingHeaders(
  server: OrgToolServerWithSecrets,
  login: string | null,
): { headers: Record<string, string>; credentialClass: string } | { error: string } {
  if (login !== null) {
    const digest = createHash("sha256").update(login).digest("hex").slice(0, 32);
    return { headers: { Authorization: `Bearer ${login}` }, credentialClass: `login:${digest}` };
  }
  switch (server.server.authMode) {
    case "none":
      return { headers: {}, credentialClass: "none" };
    case "shared_key":
      return server.sharedHeaders
        ? { headers: server.sharedHeaders, credentialClass: "shared" }
        : { error: "Add the shared key to list this server's tools." };
    case "per_user":
      return { error: "This server needs a person's login to list its tools. Add a test login." };
  }
}

/** One server's live tools (cached 60 seconds). */
export async function listOrgToolServerToolsLive(input: {
  settings: Settings;
  server: OrgToolServerWithSecrets;
  login?: string | null;
  fetchTools?: OrgToolServerToolFetcher;
  now?: () => number;
}): Promise<OrgToolServerToolsResponse> {
  const now = input.now ?? Date.now;
  const selected = listingHeaders(input.server, input.login ?? null);
  if ("error" in selected) {
    return { tools: [], fetchedAt: new Date(now()).toISOString(), error: selected.error };
  }
  const cacheKey = `${input.server.server.id}:${input.server.server.rowVersion}:${selected.credentialClass}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now()) return cached.value;
  let value: OrgToolServerToolsResponse;
  try {
    const tools = await (input.fetchTools ?? fetchOrgToolServerTools)({
      settings: input.settings,
      url: input.server.server.url,
      headers: selected.headers,
    });
    value = { tools: catalogEntries(tools), fetchedAt: new Date(now()).toISOString(), error: null };
  } catch (error) {
    value = { tools: [], fetchedAt: new Date(now()).toISOString(), error: errorMessage(error) };
  }
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, { expiresAt: now() + ORG_TOOL_SERVER_TOOLS_CACHE_MS, value });
  return value;
}

/** The live tools of an organization's tool server by key, or null when it does not exist. */
export async function listOrgToolServerToolsByKey(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  key: string;
  login?: string | null;
  fetchTools?: OrgToolServerToolFetcher;
}): Promise<OrgToolServerToolsResponse | null> {
  let server: OrgToolServerWithSecrets | null;
  try {
    server = await getOrgToolServerWithSecrets(input.db, {
      accountId: input.accountId,
      key: input.key,
      encryptionKey: environmentsEncryptionKeyBytes(input.settings),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "OrgAgentEncryptionUnavailableError") {
      return { tools: [], fetchedAt: new Date().toISOString(), error: error.message };
    }
    throw error;
  }
  if (!server) return null;
  return await listOrgToolServerToolsLive({
    settings: input.settings,
    server,
    login: input.login ?? null,
    ...(input.fetchTools ? { fetchTools: input.fetchTools } : {}),
  });
}

/**
 * The tools each server in a definition offers now, captured with a saved
 * version as the baseline for `newTools`. Servers that cannot be listed are
 * left out; null when none could be (or the definition names none).
 */
export async function captureOrgAgentToolCatalog(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  definition: OrgAgentDefinition;
  fetchTools?: OrgToolServerToolFetcher;
}): Promise<OrgAgentToolCatalog | null> {
  const keys = [...new Set(input.definition.config.toolServers.map((server) => server.server))];
  if (keys.length === 0) return null;
  let servers: OrgToolServerWithSecrets[];
  try {
    servers = await withAccountRls(input.db, input.accountId, (tx) =>
      readOrgToolServersWithSecrets(tx, {
        accountId: input.accountId,
        keys,
        encryptionKey: environmentsEncryptionKeyBytes(input.settings),
      }),
    );
  } catch {
    return null;
  }
  const catalog: OrgAgentToolCatalog = {};
  await Promise.all(
    servers.map(async (server) => {
      const listed = await listOrgToolServerToolsLive({
        settings: input.settings,
        server,
        ...(input.fetchTools ? { fetchTools: input.fetchTools } : {}),
      });
      if (listed.error === null) catalog[server.server.key] = listed.tools;
    }),
  );
  return Object.keys(catalog).length > 0 ? catalog : null;
}
