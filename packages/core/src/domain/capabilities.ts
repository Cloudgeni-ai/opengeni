import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  CapabilityCatalogItem,
  capabilityCatalogItemIsTrustedForExposure,
  type AccessGrant,
  type CapabilityCatalogResponse,
  type CapabilityInstallation,
  type CreateCapabilityCatalogItemRequest,
  type EnableCapabilityRequest,
  type McpServerConnectionRef,
  type SocialConnection,
} from "@opengeni/contracts";
import {
  CODEX_APPS_MCP_SERVER_ID,
  CODEX_APPS_MCP_SERVER_NAME,
  CODEX_APPS_MCP_URL,
  CODEX_APPS_STARTUP_TIMEOUT_MS,
} from "@opengeni/codex";
import {
  decryptVariableSetValue,
  decryptedCapabilityHeaders,
  disableCapabilityInstallation,
  enableCapabilityInstallation,
  enablePackInstallation,
  encryptVariableSetValue,
  getCapabilityCatalogItem,
  getCapabilityInstallation,
  getConnectionMetadata,
  getCodexAppsCredentialAuthorizationForRun,
  getWorkspaceGrant,
  getPackInstallation,
  getStoredCapabilityHeaderCiphertext,
  getVariableSet,
  listCapabilityCatalogItems,
  listCapabilityInstallations,
  listConnectionsMetadata,
  listEnabledMcpCapabilityServers,
  listPackInstallations,
  listSocialConnections,
  mcpServerIdForCapability,
  updatePackInstallationStatus,
  upsertCapabilityCatalogItem,
  type Database,
  type EnabledMcpCapabilityServer,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { hasPermission } from "../access";
import {
  getSkillLibraryEntry,
  listSkillLibraryEntries,
  type SkillLibraryEntry,
} from "@opengeni/runtime/skill-library";
import { validateVariableSetAttachment } from "./environments";
import {
  assertPackSandboxImageCompatible,
  listCapabilityPacks,
  listWorkspaceCapabilityPacks,
  resolveCapabilityPack,
} from "./packs";

const officialMcpRegistryUrl = "https://registry.modelcontextprotocol.io";
const firstPartyMcpServerIds = new Set(["opengeni", "files", "docs"]);
const mcpRegistryFetchTimeoutMs = 15000;
const mcpRegistryMaxPages = 3;
const mcpCapabilityProbeTimeoutMs = 15000;
const maxMcpCredentialHeaders = 16;
const maxMcpCredentialHeaderValueLength = 4096;
// RFC 9110 field-name token characters.
const mcpCredentialHeaderName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export async function buildCapabilityCatalog(input: {
  db: Database;
  workspaceId: string;
  settings: Settings;
  subjectId?: string | null;
}): Promise<CapabilityCatalogResponse> {
  const [
    persistedItems,
    capabilityInstallations,
    packInstallations,
    workspacePacks,
    socialConnections,
    bundledSkills,
    curatedLibrarySkills,
    codexAppsCredentialId,
  ] = await Promise.all([
    listCapabilityCatalogItems(input.db, input.workspaceId),
    listCapabilityInstallations(input.db, input.workspaceId),
    listPackInstallations(input.db, input.workspaceId),
    listWorkspaceCapabilityPacks(input.db, input.workspaceId),
    listSocialConnections(input.db, input.workspaceId, 500, input.subjectId),
    discoverBundledSkills(),
    discoverCuratedSkillLibraryItems(),
    input.settings.codexConnectedAppsEnabled
      ? resolveCodexAppsCredentialIdForRun(input.db, input.workspaceId)
      : Promise.resolve(null),
  ]);
  const capabilityInstallationById = new Map(
    capabilityInstallations.map((installation) => [installation.capabilityId, installation]),
  );
  const activePackIds = new Set(
    packInstallations
      .filter((installation) => installation.status === "active")
      .map((installation) => installation.packId),
  );
  const builtInPackIds = new Set(listCapabilityPacks().map((pack) => pack.id));
  const builtIns = [
    ...workspacePacks.map((pack) =>
      packCatalogItem(pack, builtInPackIds.has(pack.id) ? "built_in" : "manual"),
    ),
    ...configuredMcpCatalogItems(input.settings),
    ...platformApiCatalogItems(socialConnections),
    ...bundledSkills,
    ...curatedLibrarySkills,
  ];
  const codexApps = input.settings.codexConnectedAppsEnabled
    ? codexAppsCatalogItem(codexAppsCredentialId !== null)
    : null;
  const items = dedupeCatalogItems([
    ...builtIns,
    ...persistedItems.filter((item) => !isReservedCodexAppsCatalogItem(item)),
    // Keep the reserved, server-derived item authoritative over any stale
    // legacy catalog row with the same id.
    ...(codexApps ? [codexApps] : []),
  ])
    .map((item) =>
      applyCapabilityEnablement(item, capabilityInstallationById.get(item.id), activePackIds),
    )
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
    throw new HTTPException(422, {
      message: "packs are managed by OpenGeni and cannot be manually created",
    });
  }
  if (id.startsWith("skill:")) {
    throw new HTTPException(422, {
      message: "skill ids are managed by the OpenGeni skill library or runtime adapters",
    });
  }
  if (
    input.payload.kind === "mcp" &&
    (id === `mcp:${CODEX_APPS_MCP_SERVER_ID}` ||
      (typeof input.payload.metadata.mcpServerId === "string" &&
        input.payload.metadata.mcpServerId.trim() === CODEX_APPS_MCP_SERVER_ID))
  ) {
    throw new HTTPException(422, {
      message: `${CODEX_APPS_MCP_SERVER_ID} is reserved for the canonical Codex Apps service`,
    });
  }
  const source =
    input.payload.source === "built_in" ||
    input.payload.source === "library" ||
    input.payload.source === "configured" ||
    input.payload.source === "registry"
      ? "manual"
      : input.payload.source;
  const metadata = {
    ...input.payload.metadata,
    ...(input.payload.kind === "mcp" &&
    input.payload.endpointUrl &&
    !input.payload.metadata.mcpServerId
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
  grant: AccessGrant;
  accountId: string;
  workspaceId: string;
  settings: Settings;
  capabilityId: string;
  payload: EnableCapabilityRequest;
  probeMcpServer?: McpCapabilityProbe;
}): Promise<CapabilityInstallation> {
  const item = await requireCatalogItem(
    input.db,
    input.workspaceId,
    input.settings,
    input.capabilityId,
  );
  if (item.kind === "mcp" && !item.runtime.available) {
    throw new HTTPException(422, {
      message: "MCP capabilities need a remote streamable HTTP endpoint before they can be enabled",
    });
  }
  let installationMetadata = input.payload.metadata;
  // Credential-header storage is written exclusively by this flow; strip the
  // reserved keys from caller-provided config so the stored shape stays
  // trustworthy and no plaintext credentials sneak in through config.headers.
  let installationConfig: Record<string, unknown> = { ...input.payload.config };
  delete installationConfig.headers;
  delete installationConfig.headersEncrypted;
  delete installationConfig.headerNames;
  delete installationConfig.connectionRef;
  if (item.kind === "skill" && item.source === "library") {
    const libraryId = stringMetadata(item.metadata.libraryId);
    const catalogVersion = stringMetadata(item.metadata.version);
    if (!libraryId || !catalogVersion) {
      throw new HTTPException(422, {
        message: `skill library metadata is incomplete for ${item.id}`,
      });
    }
    const requestedVersion = input.payload.config.version;
    if (requestedVersion !== undefined && typeof requestedVersion !== "string") {
      throw new HTTPException(422, {
        message: "skill activation config.version must be a string",
      });
    }
    const normalizedVersion = requestedVersion?.trim() || catalogVersion;
    if (normalizedVersion !== catalogVersion) {
      throw new HTTPException(422, {
        message: `skill ${libraryId} only supports immutable version ${catalogVersion}`,
      });
    }
    const entry = getSkillLibraryEntry(libraryId, normalizedVersion);
    if (!entry) {
      throw new HTTPException(422, {
        message: `skill library entry is unavailable: ${libraryId}@${normalizedVersion}`,
      });
    }
    // Skill activation has a deliberately narrow config surface. In
    // particular, no variable-set, connection, credential-header, MCP, or
    // provider-routing input is persisted or consulted for a library skill.
    installationConfig = { version: entry.version };
    installationMetadata = {
      libraryId: entry.id,
      libraryVersion: entry.version,
      contentSha256: entry.contentSha256,
      sourceCommit: entry.sourceCommit,
      provenance: entry.provenance,
    };
  }
  if (item.kind === "mcp") {
    const headers = await resolveMcpCredentialHeaders(input, item);
    const connectionRef = input.payload.connectionRef
      ? await validateMcpCapabilityConnectionRef(input, item, input.payload.connectionRef)
      : null;
    assertRequiredMcpCredentialHeaders(item, headers, connectionRef);
    installationMetadata = {
      ...installationMetadata,
      ...(connectionRef && !headers
        ? authDeferredMcpConnectivity()
        : await validateMcpCapabilityConnection(item, input.probeMcpServer, headers ?? undefined)),
    };
    if (connectionRef) {
      installationConfig.connectionRef = connectionRef;
    }
    if (headers) {
      const key = requireCapabilityHeaderEncryption(input.settings);
      installationConfig.headersEncrypted = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, encryptVariableSetValue(key, value)]),
      );
    }
  }
  if (item.kind === "pack") {
    const packId = packIdFromCapabilityId(item.id);
    const pack = await resolveCapabilityPack(input.db, input.workspaceId, packId);
    if (!pack) {
      throw new HTTPException(404, { message: "pack not found" });
    }
    await assertPackSandboxImageCompatible(input.db, input.workspaceId, pack);
    // The unified capability-enable path accepts an initial variableSet
    // attachment (`payload.variableSetId`), mirroring POST /packs/:id/enable:
    // a request-supplied id is validated as a fresh attachment, otherwise the
    // attachment stored by a previous enable is preserved and re-validated.
    const existing = await getPackInstallation(input.db, input.workspaceId, packId);
    const storedVariableSetId =
      typeof existing?.metadata.variableSetId === "string"
        ? existing.metadata.variableSetId
        : typeof existing?.metadata.environmentId === "string"
          ? existing.metadata.environmentId
          : undefined;
    const requestedVariableSetId = input.payload.variableSetId;
    const variableSetId = requestedVariableSetId ?? storedVariableSetId;
    if (pack.variableSet?.required && !variableSetId) {
      throw new HTTPException(422, {
        message: `pack ${packId} requires an variableSet attachment; pass variableSetId`,
      });
    }
    if (variableSetId) {
      if (requestedVariableSetId) {
        // A fresh attachment: validate it like the packs enable endpoint does.
        // The grant holds workspace:admin here, which implies variable-sets:use,
        // so the attachment authorization succeeds for this caller.
        const variableSet = await validateVariableSetAttachment(
          { settings: input.settings, db: input.db },
          input.grant,
          input.workspaceId,
          requestedVariableSetId,
        );
        const missing = (pack.variableSet?.requiredVariables ?? []).filter(
          (name) => !variableSet.variables.some((variable) => variable.name === name),
        );
        if (missing.length > 0) {
          throw new HTTPException(422, {
            message: `variable set is missing required variable(s): ${missing.join(", ")}`,
          });
        }
      } else {
        // The stored attachment was authorized at pack-enable time, but the
        // variableSet may have been deleted or its variables changed since;
        // re-validate it like the packs enable endpoint does.
        const variableSet = await getVariableSet(input.db, input.workspaceId, variableSetId);
        if (!variableSet) {
          throw new HTTPException(422, {
            message: `the stored variableSet attachment for pack ${packId} no longer exists; re-enable it with variableSetId`,
          });
        }
        const missing = (pack.variableSet?.requiredVariables ?? []).filter(
          (name) => !variableSet.variables.some((variable) => variable.name === name),
        );
        if (missing.length > 0) {
          throw new HTTPException(422, {
            message: `variable set is missing required variable(s): ${missing.join(", ")}`,
          });
        }
      }
    }
    await enablePackInstallation(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      packId,
      metadata: {
        ...input.payload.metadata,
        packVersion: pack.version,
        ...(variableSetId ? { variableSetId } : {}),
      },
    });
  }
  return await enableCapabilityInstallation(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    capabilityId: item.id,
    kind: item.kind,
    config: installationConfig,
    metadata: installationMetadata,
  });
}

/**
 * Resolves the plaintext credential headers an MCP enable should use: the
 * validated headers from the request when provided, otherwise headers stored
 * encrypted by a previous enable (so re-enabling never requires re-pasting
 * credentials). Returns null when neither exists.
 */
async function resolveMcpCredentialHeaders(
  input: {
    db: Database;
    workspaceId: string;
    settings: Settings;
    payload: EnableCapabilityRequest;
  },
  item: CapabilityCatalogItem,
): Promise<Record<string, string> | null> {
  const provided = normalizedMcpCredentialHeaders(input.payload.headers);
  if (provided) {
    // Validate the key is configured before probing so a misconfigured
    // deployment fails fast instead of after a successful remote probe.
    requireCapabilityHeaderEncryption(input.settings);
    return provided;
  }
  const storedCiphertext = await getStoredCapabilityHeaderCiphertext(
    input.db,
    input.workspaceId,
    item.id,
  );
  if (!storedCiphertext) {
    return null;
  }
  const key = requireCapabilityHeaderEncryption(input.settings);
  try {
    return Object.fromEntries(
      Object.entries(storedCiphertext).map(([name, value]) => [
        name,
        decryptVariableSetValue(key, value),
      ]),
    );
  } catch {
    throw new HTTPException(422, {
      message: `stored credential headers for "${item.name}" could not be decrypted; supply them again in the enable request "headers" field`,
    });
  }
}

function normalizedMcpCredentialHeaders(
  headers: Record<string, string>,
): Record<string, string> | null {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.trim(), value] as const)
    .filter(([name]) => name.length > 0);
  if (entries.length === 0) {
    return null;
  }
  if (entries.length > maxMcpCredentialHeaders) {
    throw new HTTPException(422, {
      message: `an MCP capability supports at most ${maxMcpCredentialHeaders} credential headers`,
    });
  }
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (!mcpCredentialHeaderName.test(name)) {
      throw new HTTPException(422, { message: `invalid credential header name: ${name}` });
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      throw new HTTPException(422, { message: `duplicate credential header name: ${name}` });
    }
    seen.add(lower);
    if (value.length === 0 || value.length > maxMcpCredentialHeaderValueLength) {
      throw new HTTPException(422, {
        message: `credential header ${name} must be 1-${maxMcpCredentialHeaderValueLength} characters`,
      });
    }
    // RFC 9110 §5.5: field values are HTAB / printable characters — reject
    // all other control characters (they would also fail at the HTTP client).
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(value)) {
      throw new HTTPException(422, {
        message: `credential header ${name} contains forbidden control characters`,
      });
    }
  }
  return Object.fromEntries(entries);
}

async function validateMcpCapabilityConnectionRef(
  input: { db: Database; grant: AccessGrant; workspaceId: string },
  item: CapabilityCatalogItem,
  ref: McpServerConnectionRef,
): Promise<McpServerConnectionRef> {
  const subjectScope = ref.subjectScope ?? "workspace";
  const normalized: McpServerConnectionRef = {
    providerDomain: ref.providerDomain.trim(),
    subjectScope,
    ...(ref.connectionId ? { connectionId: ref.connectionId } : {}),
    ...(ref.provider ? { provider: ref.provider.trim() } : {}),
    ...(ref.kind ? { kind: ref.kind } : {}),
    ...(ref.scopes ? { scopes: uniqueStrings(ref.scopes) } : {}),
    ...(ref.resource ? { resource: ref.resource } : {}),
    ...(ref.selectedResources
      ? { selectedResources: ref.selectedResources.map((resource) => ({ ...resource })) }
      : {}),
  };
  if (!normalized.providerDomain) {
    throw new HTTPException(422, { message: "connectionRef.providerDomain is required" });
  }
  if (!item.endpointUrl || !item.runtime.mcpServerId) {
    throw new HTTPException(422, {
      message:
        "MCP capabilities need a remote streamable HTTP endpoint before they can use a connectionRef",
    });
  }

  let connection = normalized.connectionId
    ? await getConnectionMetadata(
        input.db,
        input.workspaceId,
        normalized.connectionId,
        input.grant.subjectId,
      )
    : null;
  if (!connection && subjectScope === "subject" && !normalized.connectionId) {
    const visible = await listConnectionsMetadata(
      input.db,
      input.workspaceId,
      input.grant.subjectId,
    );
    connection =
      visible.find(
        (candidate) =>
          candidate.subjectId === input.grant.subjectId &&
          candidate.providerDomain === normalized.providerDomain &&
          (!normalized.kind || candidate.kind === normalized.kind) &&
          candidate.status === "active",
      ) ?? null;
  }
  if (!connection) {
    throw new HTTPException(422, {
      message: "connectionRef does not reference a visible active connection",
    });
  }
  if (
    (subjectScope === "subject" && connection.subjectId !== input.grant.subjectId) ||
    (subjectScope === "workspace" && connection.subjectId !== null)
  ) {
    throw new HTTPException(422, {
      message: `connectionRef does not reference a ${subjectScope}-owned connection`,
    });
  }
  if (connection.status !== "active") {
    throw new HTTPException(422, {
      message: `connectionRef.connectionId is not active (${connection.status})`,
    });
  }
  if (connection.providerDomain !== normalized.providerDomain) {
    throw new HTTPException(422, {
      message: "connectionRef.providerDomain does not match the referenced connection",
    });
  }
  if (normalized.kind && connection.kind !== normalized.kind) {
    throw new HTTPException(422, {
      message: "connectionRef.kind does not match the referenced connection",
    });
  }
  if (subjectScope === "subject") {
    const genericSubjectRef = { ...normalized, kind: connection.kind };
    delete genericSubjectRef.connectionId;
    return genericSubjectRef;
  }
  return normalized;
}

function authDeferredMcpConnectivity(): Record<string, unknown> {
  return {
    mcpConnectivity: {
      status: "auth_deferred",
      checkedAt: new Date().toISOString(),
    },
  };
}

function assertRequiredMcpCredentialHeaders(
  item: CapabilityCatalogItem,
  headers: Record<string, string> | null,
  connectionRef: McpServerConnectionRef | null,
): void {
  if (connectionRef) {
    return;
  }
  const required = requiredCapabilityHeaders(item.metadata);
  const names = new Set(Object.keys(headers ?? {}).map((name) => name.toLowerCase()));
  const missing = required.filter((name) => !names.has(name.toLowerCase()));
  if (missing.length > 0) {
    throw new HTTPException(422, {
      message: `MCP capability "${item.name}" requires credential header(s) ${missing.join(", ")}; pass them in the enable request "headers" field`,
    });
  }
  if (item.authModel && names.size === 0) {
    throw new HTTPException(422, {
      message: `MCP capability "${item.name}" requires credentials; pass them in the enable request "headers" field`,
    });
  }
}

function requiredCapabilityHeaders(metadata: Record<string, unknown>): string[] {
  const value = metadata.requiredHeaders;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
}

function requireCapabilityHeaderEncryption(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new HTTPException(503, {
      message: "MCP credential headers require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
    });
  }
  return key;
}

export type McpCapabilityProbeInput = {
  id: string;
  name: string;
  url: string;
  timeoutMs: number;
  headers?: Record<string, string>;
};

export type McpCapabilityProbeResult = {
  toolCount: number;
};

export type McpCapabilityProbe = (
  input: McpCapabilityProbeInput,
) => Promise<McpCapabilityProbeResult>;

export async function validateMcpCapabilityConnection(
  item: CapabilityCatalogItem,
  probe: McpCapabilityProbe = probeStreamableHttpMcpServer,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  if (item.kind !== "mcp") {
    return {};
  }
  if (!item.endpointUrl || !item.runtime.mcpServerId) {
    throw new HTTPException(422, {
      message: "MCP capabilities need a remote streamable HTTP endpoint before they can be enabled",
    });
  }
  try {
    const result = await probe({
      id: item.runtime.mcpServerId,
      name: item.name,
      url: item.endpointUrl,
      timeoutMs: mcpCapabilityProbeTimeoutMs,
      ...(headers ? { headers } : {}),
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
      message: `MCP capability "${item.name}" could not be enabled because ${mcpProbeErrorMessage(error, item.endpointUrl)}`,
    });
  }
}

async function probeStreamableHttpMcpServer(
  input: McpCapabilityProbeInput,
): Promise<McpCapabilityProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const client = new Client(
    { name: "opengeni-capability-probe", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    const transport = new StreamableHTTPClientTransport(new URL(input.url), {
      requestInit: {
        signal: controller.signal,
        ...(input.headers ? { headers: input.headers } : {}),
      },
    });
    await client.connect(transport as unknown as Transport, {
      timeout: input.timeoutMs,
      maxTotalTimeout: input.timeoutMs,
    });
    const tools = await client.listTools(undefined, {
      timeout: input.timeoutMs,
      maxTotalTimeout: input.timeoutMs,
    });
    return { toolCount: tools.tools.length };
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => undefined);
  }
}

function mcpProbeErrorMessage(error: unknown, endpointUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\s+/g, " ").trim();
  const endpoint = safeEndpointLabel(endpointUrl);
  if (
    /404|405|not found|unexpected token|not valid json|invalid json|failed to parse|streamable http error|unable to connect|fetch failed|econnrefused|enotfound|timeout|aborted/i.test(
      normalized,
    )
  ) {
    return `OpenGeni could not reach a valid Streamable HTTP MCP server at ${endpoint}. Check the endpoint URL or choose a different catalog entry.`;
  }
  return `OpenGeni could not initialize ${endpoint}. Check the endpoint configuration or try again.`;
}

function safeEndpointLabel(endpointUrl: string): string {
  try {
    return new URL(endpointUrl).hostname || "the configured endpoint";
  } catch {
    return "the configured endpoint";
  }
}

export async function disableCapability(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  settings: Settings;
  capabilityId: string;
}): Promise<CapabilityInstallation> {
  const item = await requireCatalogItem(
    input.db,
    input.workspaceId,
    input.settings,
    input.capabilityId,
  );
  if ((item.source === "built_in" || item.source === "configured") && item.kind !== "pack") {
    throw new HTTPException(409, {
      message:
        "built-in and configured capabilities are always available; remove them from configuration to disable them",
    });
  }
  if (item.kind === "pack") {
    await updatePackInstallationStatus(
      input.db,
      input.workspaceId,
      packIdFromCapabilityId(item.id),
      "disabled",
    ).catch(() => undefined);
    if (!(await getCapabilityInstallation(input.db, input.workspaceId, item.id))) {
      await enableCapabilityInstallation(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        capabilityId: item.id,
        kind: "pack",
        metadata: {},
        config: {},
      });
    }
  } else if (!(await getCapabilityInstallation(input.db, input.workspaceId, item.id))) {
    throw new HTTPException(409, { message: "capability is not currently enabled" });
  }
  return await disableCapabilityInstallation(input.db, input.workspaceId, item.id);
}

export async function settingsWithEnabledCapabilityMcpServers(
  db: Database,
  workspaceId: string,
  settings: Settings,
): Promise<Settings> {
  const [enabled, codexAppsCredentialId] = await Promise.all([
    listEnabledMcpCapabilityServers(db, workspaceId),
    resolveCodexAppsCredentialIdForRun(db, workspaceId),
  ]);
  return settingsWithCodexAppsMcpServer(
    settingsWithMcpCapabilityServers(settings, enabled),
    codexAppsCredentialId !== null,
  );
}

/**
 * Resolve executable Apps authority. The connector must remain active and its
 * exact owner must still hold workspace connection-management permission.
 */
export async function resolveCodexAppsCredentialIdForRun(
  db: Database,
  workspaceId: string,
): Promise<string | null> {
  const authorization = await getCodexAppsCredentialAuthorizationForRun(db, workspaceId);
  if (!authorization) return null;
  const grant = await getWorkspaceGrant(db, authorization.ownerSubjectId, workspaceId);
  return grant && hasPermission(grant.permissions, "connections:write")
    ? authorization.credentialId
    : null;
}

/**
 * Register Codex Apps as an optional runtime MCP only when the deployment is
 * enabled and this workspace has an active explicit Apps designation.
 * Registration only makes the server selectable; session policy decides
 * whether the model sees it.
 */
export function settingsWithCodexAppsMcpServer(
  settings: Settings,
  credentialAvailable: boolean,
): Settings {
  const canonicalServer = {
    id: CODEX_APPS_MCP_SERVER_ID,
    name: CODEX_APPS_MCP_SERVER_NAME,
    url: CODEX_APPS_MCP_URL,
    timeoutMs: CODEX_APPS_STARTUP_TIMEOUT_MS,
    // Availability is credential-specific, so discover on every run.
    cacheToolsList: false,
  };
  // The id is a credential-routing trust boundary. Discard every configured or
  // capability-provided claimant before optionally appending the one canonical
  // endpoint; preserving an existing id could send the designated bearer to an
  // attacker-controlled URL.
  const withoutReservedId = settings.mcpServers.filter(
    (server) => server.id !== CODEX_APPS_MCP_SERVER_ID,
  );
  if (!settings.codexConnectedAppsEnabled || !credentialAvailable) {
    return withoutReservedId.length === settings.mcpServers.length
      ? settings
      : { ...settings, mcpServers: withoutReservedId };
  }
  const existing = settings.mcpServers.at(-1);
  if (
    withoutReservedId.length === settings.mcpServers.length - 1 &&
    existing !== undefined &&
    Object.keys(existing).length === Object.keys(canonicalServer).length &&
    Object.entries(canonicalServer).every(
      ([key, value]) => existing[key as keyof typeof existing] === value,
    )
  ) {
    return settings;
  }
  return {
    ...settings,
    mcpServers: [...withoutReservedId, canonicalServer],
  };
}

export function settingsWithMcpCapabilityServers(
  settings: Settings,
  enabled: EnabledMcpCapabilityServer[],
): Settings {
  if (enabled.length === 0) {
    return settings;
  }
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  const existingIds = new Set(settings.mcpServers.map((server) => server.id));
  const dynamicServers = enabled
    .filter((server) => !existingIds.has(server.id))
    .flatMap((server) => {
      const headers = decryptedCapabilityHeaders(server, encryptionKey);
      if (headers === "unavailable" && !server.connectionRef) {
        // Without its credential headers this server can only fail auth at
        // connect time and break agent turns; leave it out of the run.
        return [];
      }
      return [
        {
          id: server.id,
          name: server.name,
          url: server.url,
          ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
          ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
          cacheToolsList: server.cacheToolsList ?? false,
          ...(headers && headers !== "unavailable" ? { headers } : {}),
          ...(server.connectionRef ? { connectionRef: server.connectionRef } : {}),
        },
      ];
    });
  return dynamicServers.length
    ? { ...settings, mcpServers: [...settings.mcpServers, ...dynamicServers] }
    : settings;
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

async function fetchMcpRegistryPage(
  url: URL,
  options: {
    fetchImpl?: McpRegistryFetch;
    timeoutMs?: number;
  } = {},
): Promise<McpRegistryPage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? mcpRegistryFetchTimeoutMs,
  );
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new HTTPException(502, { message: `MCP registry returned ${response.status}` });
    }
    return (await response.json()) as McpRegistryPage;
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

async function requireCatalogItem(
  db: Database,
  workspaceId: string,
  settings: Settings,
  capabilityId: string,
): Promise<CapabilityCatalogItem> {
  const catalog = await buildCapabilityCatalog({ db, workspaceId, settings });
  const item =
    catalog.items.find((candidate) => candidate.id === capabilityId) ??
    (await getCapabilityCatalogItem(db, workspaceId, capabilityId));
  if (!item) {
    throw new HTTPException(404, { message: "capability not found" });
  }
  return item;
}

function packCatalogItem(
  pack: ReturnType<typeof listCapabilityPacks>[number],
  source: "built_in" | "manual",
): CapabilityCatalogItem {
  const customMetadata = { ...pack.metadata };
  for (const key of [
    "packId",
    "version",
    "connectors",
    "knowledge",
    "scheduledTaskTemplates",
    "sandboxImage",
    "sandboxProviderImages",
    "skills",
  ]) {
    delete customMetadata[key];
  }
  return CapabilityCatalogItem.parse({
    id: `pack:${pack.id}`,
    kind: "pack",
    source,
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
      ...customMetadata,
      packId: pack.id,
      version: pack.version,
      connectors: pack.connectors,
      knowledge: pack.knowledge,
      scheduledTaskTemplates: pack.scheduledTaskTemplates,
      ...(pack.variableSet ? { variableSet: pack.variableSet } : {}),
      // Runtime composition surface only: skill names, never file content.
      ...(pack.sandboxImage ? { sandboxImage: pack.sandboxImage } : {}),
      ...(pack.sandboxProviderImages ? { sandboxProviderImages: pack.sandboxProviderImages } : {}),
      ...(pack.skills.length > 0 ? { skills: pack.skills.map((skill) => skill.name) } : {}),
    },
  });
}

function configuredMcpCatalogItems(settings: Settings): CapabilityCatalogItem[] {
  return settings.mcpServers
    .filter((server) => server.id !== CODEX_APPS_MCP_SERVER_ID)
    .map((server) =>
      CapabilityCatalogItem.parse({
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
          notes: firstPartyMcpServerIds.has(server.id)
            ? "Available from OpenGeni runtime configuration."
            : "Configured through OPENGENI_MCP_SERVERS.",
        },
        metadata: {
          mcpServerId: server.id,
          allowedTools: server.allowedTools ?? [],
          cacheToolsList: server.cacheToolsList,
        },
      }),
    );
}

function isReservedCodexAppsCatalogItem(item: CapabilityCatalogItem): boolean {
  return (
    item.id === `mcp:${CODEX_APPS_MCP_SERVER_ID}` ||
    (item.kind === "mcp" &&
      (item.runtime.mcpServerId === CODEX_APPS_MCP_SERVER_ID ||
        item.metadata.mcpServerId === CODEX_APPS_MCP_SERVER_ID))
  );
}

/**
 * The Apps MCP is not a configured server and is not a user-installable
 * capability. It is a deployment-gated, workspace-designated runtime surface,
 * so project it into the same catalog the web picker already consumes while
 * keeping its authorization state server-derived and explicit.
 */
export function codexAppsCatalogItem(available: boolean): CapabilityCatalogItem {
  return CapabilityCatalogItem.parse({
    id: `mcp:${CODEX_APPS_MCP_SERVER_ID}`,
    kind: "mcp",
    source: "built_in",
    name: "Codex Apps",
    description:
      "Use the ChatGPT Apps designated for this workspace. Sessions include this surface by default when it is authorized; explicit policies can opt out.",
    category: "productivity",
    tags: ["mcp", "codex", "connected-apps"],
    providerDomain: "chatgpt.com",
    surfaceType: "codex_apps",
    transport: "streamable-http",
    mcpUrl: CODEX_APPS_MCP_URL,
    authKind: "none",
    tools: [{ kind: "mcp", id: CODEX_APPS_MCP_SERVER_ID }],
    runtime: {
      available,
      ...(available ? { mcpServerId: CODEX_APPS_MCP_SERVER_ID } : {}),
      transport: "streamable-http",
      notes: available
        ? "Available through the active workspace Apps designation."
        : "Unavailable until an active Codex Apps credential is designated for this workspace.",
    },
    enabled: available,
    enabledReason: available ? "designated Apps credential" : "no active Apps designation",
    metadata: {
      mcpServerId: CODEX_APPS_MCP_SERVER_ID,
      authorization: "workspace_designation",
    },
  });
}

function platformApiCatalogItems(socialConnections: SocialConnection[]): CapabilityCatalogItem[] {
  const xConnection = preferredSocialConnection(socialConnections, "x");
  const xEnabled = xConnection?.status === "connected" || xConnection?.status === "needs_reauth";
  const x = CapabilityCatalogItem.parse({
    id: "api:x",
    kind: "api",
    source: "built_in",
    name: "X",
    description:
      "Connect an X account for live search, mentions, thread context, post sync, and permission-controlled replies.",
    category: "social-media",
    tags: ["api", "x", "twitter", "social", "marketing"],
    homepageUrl: "https://x.com",
    authModel: "oauth2_authorization_code_pkce",
    providerDomain: "x.com",
    surfaceType: "first_party_social",
    authKind: "oauth2",
    tools: [{ kind: "mcp", id: "opengeni" }],
    runtime: {
      available: true,
      mcpServerId: "opengeni",
      notes: "Account access is provided through OpenGeni's first-party social tools.",
    },
    enabled: xEnabled,
    enabledReason: xEnabled
      ? xConnection.status === "connected"
        ? `${xConnection.ownership} social account connected`
        : `${xConnection.ownership} social account needs reconnection`
      : null,
    metadata: {
      connectorMode: "first_party_social",
      provider: "x",
      ownership: xConnection?.ownership ?? "workspace",
      firstPartyMcpTools: [
        "social_connections_list",
        "social_posts_recent",
        "social_daily_analysis_context",
        "social_search_live",
        "social_mentions_live",
        "social_thread_fetch",
        "social_posts_sync",
        "social_post_reply",
      ],
    },
  });
  const platformApiDefinitions: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    endpointPath: string;
    homepageUrl?: string;
    providerDomain?: string;
    authModel?: string;
    authKind?: "oauth2" | "api_key" | "none" | "unknown";
    surfaceType?: string;
    firstPartyMcpTools?: string[];
  }> = [
    {
      id: "api:github-app",
      name: "GitHub App",
      description: "Repository discovery, scoped clone tokens, pushes, and pull requests.",
      category: "source-control",
      tags: ["api", "github", "repositories"],
      endpointPath: "/v1/workspaces/{workspaceId}/github/app",
      homepageUrl: "https://github.com",
      providerDomain: "github.com",
      authModel: "github_app_owner_consent",
      authKind: "oauth2" as const,
      surfaceType: "first_party_github",
      firstPartyMcpTools: ["github_connect_link", "github_repositories_list"],
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
  ];
  const platformApis = platformApiDefinitions.map((item) =>
    CapabilityCatalogItem.parse({
      id: item.id,
      name: item.name,
      description: item.description,
      category: item.category,
      tags: item.tags,
      kind: "api",
      source: "built_in",
      ...(item.homepageUrl ? { homepageUrl: item.homepageUrl } : {}),
      ...(item.providerDomain ? { providerDomain: item.providerDomain } : {}),
      ...(item.authModel ? { authModel: item.authModel } : {}),
      ...(item.authKind ? { authKind: item.authKind } : {}),
      ...(item.surfaceType ? { surfaceType: item.surfaceType } : {}),
      ...(item.firstPartyMcpTools ? { tools: [{ kind: "mcp", id: "opengeni" }] } : {}),
      runtime: {
        available: true,
        notes:
          item.surfaceType === "first_party_github"
            ? "GitHub credentials stay host-owned; a workspace owner must approve repository access."
            : "Available through the OpenGeni API.",
      },
      metadata: {
        endpointPath: item.endpointPath,
        ...(item.firstPartyMcpTools ? { firstPartyMcpTools: item.firstPartyMcpTools } : {}),
      },
    }),
  );
  return [x, ...platformApis];
}

function preferredSocialConnection(
  connections: SocialConnection[],
  provider: "x" | "reddit",
): SocialConnection | null {
  const statusRank = (status: SocialConnection["status"]): number =>
    status === "connected" ? 0 : status === "needs_reauth" ? 1 : 2;
  return (
    connections
      .filter((connection) => connection.provider === provider)
      .sort(
        (left, right) =>
          statusRank(left.status) - statusRank(right.status) ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      )[0] ?? null
  );
}

async function discoverBundledSkills(): Promise<CapabilityCatalogItem[]> {
  const skillsDir = [
    new URL("./assets/runtime/bundled_hashicorp_terraform_skills/", import.meta.url),
    new URL(
      "../../../../packages/runtime/src/bundled_hashicorp_terraform_skills/",
      import.meta.url,
    ),
  ].find((candidate) => existsSync(candidate));
  if (!skillsDir) return [];
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const skill = await readSkillMetadata(
            new URL(`${entry.name}/SKILL.md`, skillsDir),
            entry.name,
          );
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
        }),
    );
    return skills;
  } catch {
    return [];
  }
}

/**
 * Curated skills are catalogued independently from the always-mounted bundle.
 * The runtime helper only returns entries whose reviewed artifact is present,
 * so a deployment that omits optional library assets does not advertise a
 * skill it cannot materialize.
 */
async function discoverCuratedSkillLibraryItems(): Promise<CapabilityCatalogItem[]> {
  return listSkillLibraryEntries().map((entry) => curatedSkillCatalogItem(entry));
}

function curatedSkillCatalogItem(entry: SkillLibraryEntry): CapabilityCatalogItem {
  return CapabilityCatalogItem.parse({
    id: `skill:${entry.id}`,
    kind: "skill",
    source: "library",
    name: entry.name,
    description: entry.description,
    category: entry.category,
    tags: [...entry.tags],
    homepageUrl: entry.sourceUrl,
    provenance: entry.provenance,
    tier: "verified",
    runtime: {
      available: true,
      notes: "Available as an explicit immutable opt-in skill selection.",
    },
    metadata: {
      libraryId: entry.id,
      version: entry.version,
      contentSha256: entry.contentSha256,
      sourceCommit: entry.sourceCommit,
      sourceUrl: entry.sourceUrl,
      provenance: entry.provenance,
      license: entry.license,
      documentationUrl: entry.documentationUrl,
      compatibility: entry.compatibility,
      upgrade: entry.upgrade,
      artifactPath: entry.relativePath,
    },
  });
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function readSkillMetadata(
  url: URL,
  fallbackName: string,
): Promise<{ name: string; description: string | null; category: string }> {
  const content = await readFile(url, "utf8");
  const frontMatter = content.match(/^---\n([\s\S]*?)\n---/);
  const frontMatterBody = frontMatter?.[1] ?? "";
  const name = frontMatterBody.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
  const blockDescription = frontMatterBody
    .match(/^description:\s*>-\s*\n([\s\S]*?)(?:\n[a-zA-Z_-]+:|\n?$)/m)?.[1]
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  const inlineDescription = frontMatterBody.match(/^description:\s*(?!>-\s*$)(.+)$/m)?.[1]?.trim();
  const description =
    blockDescription || inlineDescription || content.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
  const lower = `${fallbackName} ${name} ${description ?? ""}`.toLowerCase();
  const category =
    lower.includes("social") || lower.includes("marketing")
      ? "marketing"
      : lower.includes("checkov") || lower.includes("terraform") || lower.includes("azure")
        ? "infrastructure"
        : "general";
  return { name, description, category };
}

export function applyCapabilityEnablement(
  item: CapabilityCatalogItem,
  installation: CapabilityInstallation | undefined,
  activePackIds: Set<string>,
): CapabilityCatalogItem {
  if (item.kind === "pack") {
    // Pack enablement lives in pack_installations regardless of whether the
    // pack is built in or registered from a workspace manifest.
    const enabled =
      activePackIds.has(packIdFromCapabilityId(item.id)) || installation?.status === "active";
    return {
      ...item,
      enabled,
      enabledReason: enabled ? "enabled" : null,
    };
  }
  if (item.surfaceType === "first_party_social") {
    // Social connector state is derived from the authoritative workspace
    // connection row while the catalog is built. Being built in means the
    // connector is browseable, not that an account is already connected.
    return { ...item, connectionRef: null };
  }
  if (item.surfaceType === "codex_apps") {
    // Unlike ordinary built-ins, Apps availability is derived from the exact
    // active workspace designation above. Do not overwrite it with the
    // generic source-based "built in" enablement rule.
    return { ...item, connectionRef: null };
  }
  if (item.source === "built_in" || item.source === "configured") {
    return {
      ...item,
      enabled: true,
      enabledReason: item.source === "configured" ? "configured" : "built in",
    };
  }
  if (item.source === "library") {
    const enabled =
      installation?.status === "active" && skillLibraryInstallationRuntimeReady(item, installation);
    return {
      ...item,
      enabled,
      enabledReason: enabled ? "explicitly selected" : null,
      connectionRef: null,
    };
  }
  const activeInstallation = installation?.status === "active";
  const enabled = !!activeInstallation && capabilityInstallationRuntimeReady(item, installation);
  return {
    ...item,
    enabled,
    enabledReason: enabled ? "enabled" : null,
    connectionRef: enabled && installation ? installationConnectionRef(installation.config) : null,
  };
}

function skillLibraryInstallationRuntimeReady(
  item: CapabilityCatalogItem,
  installation: CapabilityInstallation,
): boolean {
  if (item.kind !== "skill" || item.source !== "library" || installation.kind !== "skill") {
    return false;
  }
  const libraryId = stringMetadata(item.metadata.libraryId);
  const version = stringMetadata(item.metadata.version);
  const contentSha256 = stringMetadata(item.metadata.contentSha256);
  const sourceCommit = stringMetadata(item.metadata.sourceCommit);
  const provenance = stringMetadata(item.metadata.provenance);
  if (!libraryId || !version || !contentSha256 || !sourceCommit || !provenance) {
    return false;
  }
  const entry = getSkillLibraryEntry(libraryId, version);
  if (
    !entry ||
    item.id !== `skill:${entry.id}` ||
    installation.capabilityId !== `skill:${entry.id}` ||
    contentSha256 !== entry.contentSha256 ||
    sourceCommit !== entry.sourceCommit ||
    provenance !== entry.provenance
  ) {
    return false;
  }
  return (
    installation.config.version === entry.version &&
    stringMetadata(installation.metadata.libraryId) === entry.id &&
    stringMetadata(installation.metadata.libraryVersion) === entry.version &&
    stringMetadata(installation.metadata.contentSha256) === entry.contentSha256 &&
    stringMetadata(installation.metadata.sourceCommit) === entry.sourceCommit &&
    stringMetadata(installation.metadata.provenance) === entry.provenance
  );
}

/**
 * The connection an installation was enabled with, when the enable-time
 * connectionRef fully resolved to one (config.connectionRef is set only by
 * the enable path — see enableCapability). Headers-enabled and credential-
 * free installations never set it, so this returns null for them.
 */
function installationConnectionRef(
  config: Record<string, unknown>,
): CapabilityCatalogItem["connectionRef"] {
  const ref = config.connectionRef;
  if (!ref || typeof ref !== "object") {
    return null;
  }
  const { connectionId, providerDomain, kind, subjectScope } = ref as Record<string, unknown>;
  if (typeof providerDomain !== "string" || typeof kind !== "string") {
    return null;
  }
  if (subjectScope === "subject") {
    // Never project a personal connection UUID through workspace-visible
    // capability configuration, including legacy rows that still contain one.
    return { providerDomain, kind, subjectScope: "subject" };
  }
  if (typeof connectionId !== "string") {
    return null;
  }
  return { connectionId, providerDomain, kind };
}

function dedupeCatalogItems(items: CapabilityCatalogItem[]): CapabilityCatalogItem[] {
  const byId = new Map<string, CapabilityCatalogItem>();
  for (const item of items) {
    // Curated library entries are runtime-managed and must not be replaced by
    // stale/manual rows with the same reserved skill id. Other catalog sources
    // retain the historical last-write-wins behavior below.
    if (item.kind === "skill" && item.source === "library" && byId.has(item.id)) {
      byId.set(item.id, item);
      continue;
    }
    const existing = byId.get(item.id);
    if (existing?.kind === "skill" && existing.source === "library") {
      continue;
    }
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function compareCatalogItems(a: CapabilityCatalogItem, b: CapabilityCatalogItem): number {
  return `${a.kind}:${a.category}:${a.name}`.localeCompare(`${b.kind}:${b.category}:${b.name}`);
}

export type CapabilityCatalogSearchMatch = {
  item: CapabilityCatalogItem;
  score: number;
  matchedOn: Array<"name" | "provider" | "tag" | "category" | "description" | "id">;
};

/**
 * Deterministically rank the already-merged workspace catalog for an agent.
 * The caller still owns live authorization checks (GitHub binding, OAuth row,
 * and so on); this function searches metadata only and never probes a provider
 * or exposes credential/setup prose to the model.
 */
export function searchCapabilityCatalogItems(
  items: readonly CapabilityCatalogItem[],
  query: string,
  limit = 8,
): CapabilityCatalogSearchMatch[] {
  const phrase = normalizeCapabilitySearchText(query);
  const tokens = [...new Set(phrase.split(" ").filter(Boolean))].slice(0, 24);
  if (tokens.length === 0) return [];
  const boundedLimit = Math.min(20, Math.max(1, Math.trunc(limit)));
  const weightedFields = (item: CapabilityCatalogItem) =>
    [
      ["name", item.name, 100],
      ["provider", item.providerDomain ?? "", 80],
      ["tag", item.tags.join(" "), 50],
      ["category", item.category, 30],
      ["id", item.id, 25],
      ["description", item.description ?? "", 15],
    ] as const;

  return items
    .filter((item) => capabilityCatalogItemIsTrustedForExposure(item))
    .flatMap((item): CapabilityCatalogSearchMatch[] => {
      let score = 0;
      const matchedOn = new Set<CapabilityCatalogSearchMatch["matchedOn"][number]>();
      for (const [field, raw, weight] of weightedFields(item)) {
        const value = normalizeCapabilitySearchText(raw);
        if (!value) continue;
        const words = value.split(" ");
        if (value.includes(phrase)) {
          score += Math.round(weight * 1.5);
          matchedOn.add(field);
        }
        for (const token of tokens) {
          if (words.includes(token)) {
            score += weight;
            matchedOn.add(field);
          } else if (words.some((word) => word.startsWith(token) || token.startsWith(word))) {
            score += Math.round(weight * 0.7);
            matchedOn.add(field);
          } else if (value.includes(token)) {
            score += Math.round(weight * 0.4);
            matchedOn.add(field);
          }
        }
      }
      if (score === 0) return [];
      if (item.enabled) score += 12;
      if (item.tier === "verified") score += 8;
      if (item.source === "built_in") score += 6;
      return [{ item, score, matchedOn: [...matchedOn] }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.item.enabled) - Number(left.item.enabled) ||
        left.item.name.localeCompare(right.item.name) ||
        left.item.id.localeCompare(right.item.id),
    )
    .slice(0, boundedLimit);
}

function normalizeCapabilitySearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
  const source = [
    payload.kind,
    payload.name,
    payload.endpointUrl ?? payload.installUrl ?? payload.homepageUrl ?? "",
  ].join(":");
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "capability"
  );
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
  const remote = server.remotes?.find(
    (candidate) => candidate.type === "streamable-http" && candidate.url,
  );
  const endpointUrl = validUrl(remote?.url);
  if (!remote || !endpointUrl) {
    return null;
  }
  const version = server.version ?? "latest";
  const id = publicRegistryCapabilityId(server.name, version, endpointUrl);
  const homepageUrl = validUrl(server.websiteUrl) ?? validUrl(server.repository?.url);
  const requiredHeaders = requiredRemoteHeaders(remote);
  const mcpServerId = mcpServerIdForCapability(id, {});
  return CapabilityCatalogItem.parse({
    id,
    kind: "mcp",
    source: "public_registry",
    name: server.title || server.name,
    description: server.description ?? null,
    category: "public-mcp",
    tags: [
      "mcp",
      "public",
      "registry",
      ...(requiredHeaders.length ? ["requires-credentials"] : []),
    ],
    homepageUrl,
    endpointUrl,
    installUrl: homepageUrl,
    authModel: requiredHeaders.length ? "credential_ref" : null,
    tools: [{ kind: "mcp", id: mcpServerId }],
    runtime: {
      available: true,
      mcpServerId,
      transport: "streamable-http",
      notes:
        requiredHeaders.length === 0
          ? "Remote MCP server from the official MCP Registry."
          : `This MCP requires credential header(s) ${requiredHeaders.join(", ")} supplied in the enable request.`,
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
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function capabilityInstallationRuntimeReady(
  item: CapabilityCatalogItem,
  installation: CapabilityInstallation | undefined,
): boolean {
  if (!installation || item.kind !== "mcp") {
    return !!installation;
  }
  if (!item.runtime.available) {
    return false;
  }
  if (!storedCredentialHeadersSatisfy(item, installation)) {
    return false;
  }
  const connectivity = installation.metadata.mcpConnectivity;
  return (
    !!connectivity &&
    typeof connectivity === "object" &&
    "status" in connectivity &&
    (connectivity.status === "ok" || connectivity.status === "auth_deferred")
  );
}

/**
 * Checks the generic installation projection (header names only) against the
 * capability's declared credential requirements.
 */
function storedCredentialHeadersSatisfy(
  item: CapabilityCatalogItem,
  installation: CapabilityInstallation,
): boolean {
  if (storedConnectionRef(installation.config)) {
    return true;
  }
  const storedNames = new Set(
    (Array.isArray(installation.config.headerNames) ? installation.config.headerNames : [])
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.toLowerCase()),
  );
  const required = requiredCapabilityHeaders(item.metadata);
  if (required.some((name) => !storedNames.has(name.toLowerCase()))) {
    return false;
  }
  return !item.authModel || storedNames.size > 0;
}

function storedConnectionRef(config: Record<string, unknown>): boolean {
  const ref = config.connectionRef;
  return (
    !!ref &&
    typeof ref === "object" &&
    !Array.isArray(ref) &&
    typeof (ref as { providerDomain?: unknown }).providerDomain === "string"
  );
}
