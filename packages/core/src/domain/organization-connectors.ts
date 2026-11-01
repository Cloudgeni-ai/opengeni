import {
  integrationDefinitionById,
  isIntegrationDefinitionEnabled,
  validateCredentialPlacements,
} from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import {
  CreateOrganizationConnectorRequest,
  PreviewOrganizationApiIntegrationRequest,
  UpdateOrganizationConnectorRequest,
  type ApiIntegrationPreview,
  type CapabilityCatalogItem,
  type OrganizationApiIntegrationHere,
  type IntegrationSourceInput,
  type OrganizationApiKeyPlacement,
  type OrganizationConnector,
  type OrganizationConnectorLogin,
} from "@opengeni/contracts";
import {
  assertOrganizationConnectorAdministrator,
  deleteOrganizationConnector,
  encryptEnvironmentValue,
  getCapabilityInstallation,
  getOrganizationConnector,
  insertOrganizationConnector,
  isOrganizationConnectorOverride,
  listOrganizationConnectors,
  listOrganizationConnectorsReachingWorkspace,
  restoreOrganizationConnectorInWorkspace,
  turnOffOrganizationConnectorInWorkspace,
  listTrustedGlobalMcpCatalogItems,
  organizationApiIntegrationDefinition,
  organizationConnectorCatalogItem,
  organizationConnectorHeaderNames,
  organizationConnectorLogin,
  updateOrganizationConnector,
  type AuthorizeOrganizationConnectorAdministration,
  type Database,
  type OrganizationApiIntegrationDefinition,
  type OrganizationConnectorRow,
  type StoredApiIntegrationRevision,
} from "@opengeni/db";
import { readOrganizationIntegrationPolicyForServing } from "@opengeni/db/organization-integration-policy";
import { HTTPException } from "hono/http-exception";
import {
  assertRequiredMcpCredentialHeaders,
  authDeferredMcpConnectivity,
  isReservedCodexAppsCatalogItem,
  mcpEndpointRequiresPersonalConnection,
  normalizedMcpCredentialHeaders,
  organizationCustomCapabilityId,
  perPersonOAuthRefForItem,
  requireCapabilityHeaderEncryption,
  validateMcpCapabilityConnection,
  type McpCapabilityProbe,
} from "./capabilities";
import { assertOrganizationMcpCredentialContentFlowAllowed } from "./mcp-credential-content-flow";
import { integrationSourceForOrganizationPolicy } from "./organization-integration-catalog";

/**
 * Organization connectors (docs/design/ownership-and-reach.md, OR-11):
 * administration by organization owners and admins. Workspaces read them
 * through the enabled-connector readers in @opengeni/db, where a workspace's
 * own setup of the same connector, on or off, wins.
 *
 * Every operation checks the acting person in the database before anything
 * else, so no server is contacted on behalf of someone who may not add it.
 * A connector's sign-in mode is fixed when it is added; to change it, remove
 * it and add it again.
 */
type Administration = {
  db: Database;
  settings: Settings;
  accountId: string;
  authorize: AuthorizeOrganizationConnectorAdministration;
  probeMcpServer?: McpCapabilityProbe | undefined;
  /** Compiles an API integration's source; needed to preview or add one. */
  resolveApiIntegration?: ResolveOrganizationApiIntegration | undefined;
};

/** An API integration compiled from its source, exactly as a workspace preview resolves it. */
export type ResolvedOrganizationApiIntegration = {
  preview: ApiIntegrationPreview;
  revision: StoredApiIntegrationRevision;
  provider: string | null;
  requiredScopes: string[];
  authScheme: Record<string, unknown>;
};

/**
 * Compiles an API integration source for the organization (the API layer
 * owns the pinned source transport). `apiKey` is used only to read an API
 * that needs a key even to describe itself, and is never stored by this.
 */
export type ResolveOrganizationApiIntegration = (input: {
  source: IntegrationSourceInput;
  apiKey: readonly OrganizationApiKeyPlacement[] | null;
}) => Promise<ResolvedOrganizationApiIntegration>;

export async function listOrganizationConnectorsForAdministration(
  input: Administration,
): Promise<OrganizationConnector[]> {
  const rows = await listOrganizationConnectors(
    input.db,
    { accountId: input.accountId },
    input.authorize,
  );
  const catalog = await catalogItemsFor(input, rows);
  return rows.map((row) => organizationConnectorView(row, catalog));
}

/**
 * Previews an API integration for the organization, as a workspace previews
 * one: its tools, how it authenticates, and the revision an add must match.
 * Checked against the organization's integration policy before the source is
 * read.
 */
export async function previewOrganizationApiIntegration(
  input: Administration & { payload: PreviewOrganizationApiIntegrationRequest },
): Promise<ApiIntegrationPreview> {
  const payload = PreviewOrganizationApiIntegrationRequest.parse(input.payload);
  await assertOrganizationConnectorAdministrator(
    input.db,
    { accountId: input.accountId },
    input.authorize,
  );
  return (await resolveForOrganization(input, payload.source, payload.apiKey ?? null)).preview;
}

export async function createOrganizationConnector(
  input: Administration & { payload: CreateOrganizationConnectorRequest },
): Promise<OrganizationConnector> {
  const payload = CreateOrganizationConnectorRequest.parse(input.payload);
  await assertOrganizationConnectorAdministrator(
    input.db,
    { accountId: input.accountId },
    input.authorize,
  );
  if (payload.apiIntegration) return await createOrganizationApiIntegration(input, payload);
  const custom = payload.custom
    ? {
        name: payload.custom.name,
        description: payload.custom.description ?? null,
        endpointUrl: payload.custom.endpointUrl,
      }
    : null;
  const capabilityId = custom ? organizationCustomCapabilityId(custom) : payload.capabilityId!;
  const now = new Date();
  const item = custom
    ? organizationConnectorCatalogItem(
        {
          capabilityId,
          accountId: input.accountId,
          customDefinition: custom,
          config: payload.login === "each_person" ? { connectionRef: {} } : {},
          createdAt: now,
          updatedAt: now,
        },
        null,
      )
    : await requireCatalogConnector(input, capabilityId);
  const access = await prepareAccess(input, item, payload.login, payload.headers ?? {});
  const row = await insertOrganizationConnector(
    input.db,
    { accountId: input.accountId },
    {
      capabilityId,
      customDefinition: custom,
      config: withAllowedTools(access.config, payload.allowedTools ?? null),
      metadata: access.metadata,
      allowedWorkspaceIds: payload.availability.allowedWorkspaceIds,
      allowPersonalWorkspaces: payload.availability.allowPersonalWorkspaces,
    },
    input.authorize,
  );
  return organizationConnectorView(row, new Map(custom ? [] : [[item.id, item]]));
}

export async function updateOrganizationConnectorSettings(
  input: Administration & { connectorId: string; payload: UpdateOrganizationConnectorRequest },
): Promise<OrganizationConnector> {
  const payload = UpdateOrganizationConnectorRequest.parse(input.payload);
  const scope = { accountId: input.accountId, connectorId: input.connectorId };
  const current = await getOrganizationConnector(input.db, scope, input.authorize);
  if (!current) throw new HTTPException(404, { message: "Organization connector not found" });
  if (current.generation !== payload.expectedGeneration) throw changedConflict();
  const catalog = await catalogItemsFor(input, [current]);
  let config = current.config;
  let metadata: Record<string, unknown> | undefined;
  const apiDefinition = organizationApiIntegrationDefinition(current);
  if (apiDefinition ? payload.headers !== undefined : payload.apiKey !== undefined)
    throw new HTTPException(422, {
      message: apiDefinition
        ? "An API integration's key goes in apiKey, not headers"
        : "apiKey is only for an API integration",
    });
  if (payload.apiKey !== undefined) {
    if (organizationConnectorLogin(current.config) !== "organization_key")
      throw new HTTPException(422, {
        message: "Only a connector that uses an organization key has a key to replace",
      });
    await assertKeyContentFlowAllowed(input, apiDefinition!, payload.apiKey);
    config = {
      ...config,
      placementsEncrypted: encryptedKeyPlacements(input.settings, payload.apiKey),
    };
  }
  if (payload.allowedTools && apiDefinition)
    assertKnownTools(apiDefinition.revision, payload.allowedTools);
  if (payload.headers !== undefined) {
    if (organizationConnectorLogin(current.config) !== "organization_key")
      throw new HTTPException(422, {
        message: "Only a connector that uses an organization key has headers to replace",
      });
    const item = connectorCatalogItem(current, catalog);
    if (!item)
      throw new HTTPException(409, {
        message: "This connector is no longer in the catalog; remove it instead",
      });
    const access = await prepareAccess(input, item, "organization_key", payload.headers);
    config = { ...config, headersEncrypted: access.config.headersEncrypted };
    metadata = { ...current.metadata, ...access.metadata };
  }
  if (payload.allowedTools !== undefined) config = withAllowedTools(config, payload.allowedTools);
  const updated = await updateOrganizationConnector(
    input.db,
    scope,
    {
      expectedGeneration: payload.expectedGeneration,
      ...(payload.availability
        ? {
            allowedWorkspaceIds: payload.availability.allowedWorkspaceIds,
            allowPersonalWorkspaces: payload.availability.allowPersonalWorkspaces,
          }
        : {}),
      ...(payload.status ? { status: payload.status } : {}),
      ...(config !== current.config ? { config } : {}),
      ...(metadata ? { metadata } : {}),
    },
    input.authorize,
  );
  if (!updated) throw changedConflict();
  return organizationConnectorView(updated, catalog);
}

export async function removeOrganizationConnector(
  input: Administration & { connectorId: string },
): Promise<void> {
  const removed = await deleteOrganizationConnector(
    input.db,
    { accountId: input.accountId, connectorId: input.connectorId },
    input.authorize,
  );
  if (!removed) throw new HTTPException(404, { message: "Organization connector not found" });
}

/**
 * Adds an API integration: the source is compiled again and must still be
 * the revision the admin previewed. The stored definition is that compiled
 * revision, so every workspace it reaches runs exactly what was reviewed.
 */
async function createOrganizationApiIntegration(
  input: Administration,
  payload: CreateOrganizationConnectorRequest,
): Promise<OrganizationConnector> {
  const source = payload.apiIntegration!;
  const resolved = await resolveForOrganization(input, source.source, payload.apiKey ?? null);
  const { preview } = resolved;
  if (
    preview.revisionId !== source.expectedRevisionId ||
    preview.contentSha256 !== source.expectedContentSha256
  )
    throw new HTTPException(409, {
      message: "This API changed since it was checked. Check it again before adding it.",
    });
  assertApiIntegrationLogin(preview, payload.login);
  if (payload.allowedTools) assertKnownTools(resolved.revision, payload.allowedTools);
  const definition: OrganizationApiIntegrationDefinition = {
    kind: "api",
    name: preview.name,
    description: preview.description,
    definitionId: preview.definitionId,
    definitionProvenance: preview.definitionProvenance,
    protocol: preview.protocol,
    pluginKey: preview.pluginKey,
    serverId: preview.serverId,
    provider: resolved.provider,
    providerDomain: preview.providerDomain,
    baseUrl: preview.baseUrl,
    sourceUrl: preview.sourceUrl,
    source: { ...preview.source },
    requiredScopes: [...resolved.requiredScopes],
    auth: preview.auth,
    authScheme: resolved.authScheme,
    revision: resolved.revision,
  };
  let config: Record<string, unknown> = {};
  if (payload.login === "each_person")
    config = { connectionRef: { kind: preview.auth.kind === "oauth2" ? "oauth2" : "api_key" } };
  if (payload.login === "organization_key") {
    await assertKeyContentFlowAllowed(input, definition, payload.apiKey!);
    config = { placementsEncrypted: encryptedKeyPlacements(input.settings, payload.apiKey!) };
  }
  const row = await insertOrganizationConnector(
    input.db,
    { accountId: input.accountId },
    {
      kind: "api",
      capabilityId: preview.capabilityId,
      customDefinition: definition,
      config: withAllowedTools(config, payload.allowedTools ?? null),
      metadata: {},
      allowedWorkspaceIds: payload.availability.allowedWorkspaceIds,
      allowPersonalWorkspaces: payload.availability.allowPersonalWorkspaces,
    },
    input.authorize,
  );
  return organizationConnectorView(row, new Map());
}

/**
 * Compiles a source under the organization's integration policy (a
 * restricted policy narrows an "auto" source to the custom protocols it
 * allows, and refuses anything else before the source is read). A reviewed
 * definition still behind a per-workspace rollout can't be added for the
 * whole organization.
 */
async function resolveForOrganization(
  input: Administration,
  requested: IntegrationSourceInput,
  apiKey: readonly OrganizationApiKeyPlacement[] | null,
): Promise<ResolvedOrganizationApiIntegration> {
  if (!input.resolveApiIntegration) throw new Error("API integration resolver is not configured");
  const policy = await readOrganizationIntegrationPolicyForServing(input.db, {
    accountId: input.accountId,
  });
  const source = integrationSourceForOrganizationPolicy(policy, requested);
  if (
    source.kind === "definition" &&
    (!integrationDefinitionById(source.definitionId) ||
      !isIntegrationDefinitionEnabled(source.definitionId, {
        teamsEnabled: input.settings.microsoftTeamsToolsEnabled,
      }))
  )
    throw new HTTPException(404, {
      message: "This integration isn't available to add for a whole organization",
    });
  if (apiKey) assertValidKeyPlacements(apiKey);
  try {
    return await input.resolveApiIntegration({ source, apiKey });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(422, {
      message: error instanceof Error ? error.message : "The API could not be read safely",
    });
  }
}

/**
 * How turns sign in must fit how the API authenticates: an API with no
 * authentication needs no sign-in; an OAuth API signs each person in with
 * their own account; a key or HTTP API takes each person's own key or one
 * organization key.
 */
function assertApiIntegrationLogin(
  preview: ApiIntegrationPreview,
  login: OrganizationConnectorLogin,
): void {
  const auth = preview.auth.kind;
  if (auth === "none" && login !== "none")
    throw new HTTPException(422, { message: `${preview.name} needs no sign-in` });
  if (auth !== "none" && login === "none")
    throw new HTTPException(422, {
      message: `${preview.name} needs a sign-in: each person's own, or an organization key`,
    });
  if (auth === "oauth2" && login !== "each_person")
    throw new HTTPException(422, {
      message: `${preview.name} signs in with OAuth, so each person connects their own account`,
    });
}

function assertKnownTools(
  revision: Pick<StoredApiIntegrationRevision, "tools">,
  allowedTools: readonly string[],
): void {
  const known = new Set(revision.tools.map((tool) => tool.id));
  const unknown = allowedTools.filter((tool) => !known.has(tool));
  if (unknown.length > 0)
    throw new HTTPException(422, {
      message: `Unknown tools for this API: ${unknown.slice(0, 10).join(", ")}`,
    });
}

function assertValidKeyPlacements(apiKey: readonly OrganizationApiKeyPlacement[]): void {
  try {
    validateCredentialPlacements(
      apiKey.map((placement) => ({
        carrier: placement.carrier,
        name: placement.name,
        value: placement.value,
        ...(placement.prefix ? { prefix: placement.prefix } : {}),
      })),
    );
  } catch {
    throw new HTTPException(422, {
      message: "The key can't be sent there: check each name and value",
    });
  }
}

/** An organization key stored for an API: each value encrypted, never returned. */
function encryptedKeyPlacements(
  settings: Settings,
  apiKey: readonly OrganizationApiKeyPlacement[],
): Record<string, unknown>[] {
  assertValidKeyPlacements(apiKey);
  const key = requireCapabilityHeaderEncryption(settings);
  return apiKey.map((placement) => ({
    carrier: placement.carrier,
    name: placement.name,
    ...(placement.prefix ? { prefix: placement.prefix } : {}),
    valueEncrypted: encryptEnvironmentValue(key, placement.value),
  }));
}

/** The same EU-only check an organization MCP connector's stored headers get. */
async function assertKeyContentFlowAllowed(
  input: Administration,
  definition: Pick<OrganizationApiIntegrationDefinition, "baseUrl">,
  apiKey: readonly OrganizationApiKeyPlacement[],
): Promise<void> {
  await assertOrganizationMcpCredentialContentFlowAllowed(input.db, {
    accountId: input.accountId,
    url: definition.baseUrl,
    headers: Object.fromEntries(
      apiKey.map((placement, index) => [`${index}`, `${placement.prefix ?? ""}${placement.value}`]),
    ),
  });
}

/**
 * Turns the organization's API integration off in one workspace, or back on
 * (OR-11: the workspace's own setting wins). Off is a turned-off installation
 * of the same capability, exactly as for an organization MCP connector. The
 * caller has checked the person may manage this workspace's integrations.
 */
export async function setOrganizationApiIntegrationHere(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  capabilityId: string;
  enabledHere: boolean;
}): Promise<OrganizationApiIntegrationHere> {
  const reaches = (
    await listOrganizationConnectorsReachingWorkspace(input.db, input.workspaceId, "api")
  ).some((connector) => connector.capabilityId === input.capabilityId);
  if (!reaches)
    throw new HTTPException(404, {
      message: "Your organization doesn't share this integration with this workspace",
    });
  if (input.enabledHere) {
    await restoreOrganizationConnectorInWorkspace(input.db, input.workspaceId, input.capabilityId);
  } else {
    const existing = await getCapabilityInstallation(
      input.db,
      input.workspaceId,
      input.capabilityId,
    );
    if (existing && !isOrganizationConnectorOverride(existing))
      throw new HTTPException(409, {
        message: "This workspace has its own setup of this integration",
      });
    await turnOffOrganizationConnectorInWorkspace(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      capabilityId: input.capabilityId,
    });
  }
  return { capabilityId: input.capabilityId, enabledHere: input.enabledHere };
}

function changedConflict(): HTTPException {
  return new HTTPException(409, {
    message: "This connector changed since it was loaded; reload before saving",
  });
}

async function requireCatalogConnector(
  input: Administration,
  capabilityId: string,
): Promise<CapabilityCatalogItem> {
  const [item] = await listTrustedGlobalMcpCatalogItems(input.db, input.accountId, [capabilityId]);
  if (!item) throw new HTTPException(404, { message: "Connector not found in the catalog" });
  if (isReservedCodexAppsCatalogItem(item))
    throw new HTTPException(422, {
      message: "Codex Apps use the dedicated account designation flow",
    });
  return item;
}

/**
 * The stored sign-in for a connector, checked as a workspace setup of it is:
 * an each-person sign-in is the server's own OAuth (nothing to probe until a
 * person connects); an organization key is required headers, probed with
 * them, then encrypted; a credential-free server is probed as it is.
 */
async function prepareAccess(
  input: Administration,
  item: CapabilityCatalogItem,
  login: OrganizationConnectorLogin,
  rawHeaders: Record<string, string>,
): Promise<{ config: Record<string, unknown>; metadata: Record<string, unknown> }> {
  if (item.kind !== "mcp" || !item.endpointUrl || !item.runtime.mcpServerId)
    throw new HTTPException(422, {
      message: "A connector needs a remote streamable HTTP endpoint",
    });
  if (mcpEndpointRequiresPersonalConnection(item) && login !== "each_person")
    throw new HTTPException(422, {
      message: `${item.name} works only when each person signs in with their own account`,
    });
  if (login === "each_person") {
    const connectionRef = perPersonOAuthRefForItem(item);
    if (!connectionRef)
      throw new HTTPException(422, {
        message: `${item.name} has no sign-in of its own for each person; use an organization key`,
      });
    return { config: { connectionRef }, metadata: authDeferredMcpConnectivity() };
  }
  const headers = login === "organization_key" ? normalizedMcpCredentialHeaders(rawHeaders) : null;
  if (login === "organization_key" && !headers)
    throw new HTTPException(422, { message: "An organization key needs at least one header" });
  if (headers) requireCapabilityHeaderEncryption(input.settings);
  assertRequiredMcpCredentialHeaders(item, headers, null);
  await assertOrganizationMcpCredentialContentFlowAllowed(input.db, {
    accountId: input.accountId,
    url: item.endpointUrl,
    headers,
  });
  const metadata = await validateMcpCapabilityConnection(
    item,
    input.probeMcpServer,
    headers ?? undefined,
    input.settings,
  );
  if (!headers) return { config: {}, metadata };
  const key = requireCapabilityHeaderEncryption(input.settings);
  return {
    config: {
      headersEncrypted: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, encryptEnvironmentValue(key, value)]),
      ),
    },
    metadata,
  };
}

function withAllowedTools(
  config: Record<string, unknown>,
  allowedTools: readonly string[] | null,
): Record<string, unknown> {
  const { allowedTools: _previous, ...rest } = config;
  return allowedTools === null ? rest : { ...rest, allowedTools: [...allowedTools] };
}

async function catalogItemsFor(
  input: Pick<Administration, "db" | "accountId">,
  rows: readonly OrganizationConnectorRow[],
): Promise<Map<string, CapabilityCatalogItem>> {
  const ids = rows
    .filter((row) => row.kind === "mcp" && !row.customDefinition)
    .map((row) => row.capabilityId);
  const items = await listTrustedGlobalMcpCatalogItems(input.db, input.accountId, ids);
  return new Map(items.map((item) => [item.id, item]));
}

function connectorCatalogItem(
  row: OrganizationConnectorRow,
  catalog: ReadonlyMap<string, CapabilityCatalogItem>,
): CapabilityCatalogItem | null {
  if (row.kind !== "mcp") return null;
  return row.customDefinition
    ? organizationConnectorCatalogItem(row, null)
    : (catalog.get(row.capabilityId) ?? null);
}

function organizationConnectorView(
  row: OrganizationConnectorRow,
  catalog: ReadonlyMap<string, CapabilityCatalogItem>,
): OrganizationConnector {
  const api = organizationApiIntegrationDefinition(row);
  const item = api ? null : connectorCatalogItem(row, catalog);
  const allowedTools = Array.isArray(row.config.allowedTools)
    ? row.config.allowedTools.filter((tool): tool is string => typeof tool === "string")
    : null;
  return {
    id: row.id,
    organizationId: row.accountId,
    kind: api ? "api" : "mcp",
    capabilityId: row.capabilityId,
    name: api?.name ?? item?.name ?? row.capabilityId,
    description: api ? api.description : (item?.description ?? null),
    endpointUrl: api?.baseUrl ?? item?.endpointUrl ?? "",
    source: api
      ? api.definitionProvenance === "curated"
        ? "catalog"
        : "custom"
      : row.customDefinition
        ? "custom"
        : "catalog",
    login: organizationConnectorLogin(row.config),
    headerNames: organizationConnectorHeaderNames(row.config),
    allowedTools,
    availability: {
      allowedWorkspaceIds: row.allowedWorkspaceIds,
      allowPersonalWorkspaces: row.allowPersonalWorkspaces,
    },
    status: row.status,
    // An API integration runs its stored, reviewed revision; it has no catalog entry to lose.
    available: api ? true : item !== null,
    apiIntegration: api
      ? {
          definitionId: api.definitionId,
          protocol: api.protocol,
          providerDomain: api.providerDomain,
          auth: api.auth,
          revisionId: api.revision.id,
          contentSha256: api.revision.contentSha256,
          tools: api.revision.tools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            safety: tool.safety,
          })),
        }
      : null,
    generation: row.generation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
