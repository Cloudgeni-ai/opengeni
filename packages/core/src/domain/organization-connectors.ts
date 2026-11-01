import type { Settings } from "@opengeni/config";
import {
  CreateOrganizationConnectorRequest,
  UpdateOrganizationConnectorRequest,
  type CapabilityCatalogItem,
  type OrganizationConnector,
  type OrganizationConnectorLogin,
} from "@opengeni/contracts";
import {
  assertOrganizationConnectorAdministrator,
  deleteOrganizationConnector,
  encryptEnvironmentValue,
  getOrganizationConnector,
  insertOrganizationConnector,
  listOrganizationConnectors,
  listTrustedGlobalMcpCatalogItems,
  organizationConnectorCatalogItem,
  organizationConnectorHeaderNames,
  organizationConnectorLogin,
  updateOrganizationConnector,
  type AuthorizeOrganizationConnectorAdministration,
  type Database,
  type OrganizationConnectorRow,
} from "@opengeni/db";
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
};

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

export async function createOrganizationConnector(
  input: Administration & { payload: CreateOrganizationConnectorRequest },
): Promise<OrganizationConnector> {
  const payload = CreateOrganizationConnectorRequest.parse(input.payload);
  await assertOrganizationConnectorAdministrator(
    input.db,
    { accountId: input.accountId },
    input.authorize,
  );
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
  const ids = rows.filter((row) => !row.customDefinition).map((row) => row.capabilityId);
  const items = await listTrustedGlobalMcpCatalogItems(input.db, input.accountId, ids);
  return new Map(items.map((item) => [item.id, item]));
}

function connectorCatalogItem(
  row: OrganizationConnectorRow,
  catalog: ReadonlyMap<string, CapabilityCatalogItem>,
): CapabilityCatalogItem | null {
  return row.customDefinition
    ? organizationConnectorCatalogItem(row, null)
    : (catalog.get(row.capabilityId) ?? null);
}

function organizationConnectorView(
  row: OrganizationConnectorRow,
  catalog: ReadonlyMap<string, CapabilityCatalogItem>,
): OrganizationConnector {
  const item = connectorCatalogItem(row, catalog);
  const allowedTools = Array.isArray(row.config.allowedTools)
    ? row.config.allowedTools.filter((tool): tool is string => typeof tool === "string")
    : null;
  return {
    id: row.id,
    organizationId: row.accountId,
    capabilityId: row.capabilityId,
    name: item?.name ?? row.capabilityId,
    description: item?.description ?? null,
    endpointUrl: item?.endpointUrl ?? "",
    source: row.customDefinition ? "custom" : "catalog",
    login: organizationConnectorLogin(row.config),
    headerNames: organizationConnectorHeaderNames(row.config),
    allowedTools,
    availability: {
      allowedWorkspaceIds: row.allowedWorkspaceIds,
      allowPersonalWorkspaces: row.allowPersonalWorkspaces,
    },
    status: row.status,
    available: item !== null,
    generation: row.generation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
