import {
  sameConnectorProviderDomain,
  type ConnectionMetadata,
  type McpPersonalConnectionDelegation,
  type McpServerConnectionRef,
} from "@opengeni/contracts";
import {
  getWorkspace,
  listCapabilityInstallations,
  listInstalledApiIntegrations,
  listEnabledMcpCapabilityServers,
  listOriginMcpCapabilityServersForPersonalExtension,
  rlsContextForWorkspace,
  type ApiIntegrationRuntime,
  type Database,
  type EnabledMcpCapabilityServer,
  type OriginMcpCapabilityServer,
} from "@opengeni/db";
import { readOrganizationIntegrationPolicyForServing } from "@opengeni/db/organization-integration-policy";
import { dedicatedMcpIntegrationKey } from "./organization-integration-catalog";
import {
  personalWorkspaceOwnerOriginConnections,
  type OmittedConnectionAccount,
  type PersonalWorkspaceOriginConnections,
} from "./personal-connection-delegations";

/**
 * Generic MCP enablement is classified as this key (see `prepareCapabilityEnable`
 * and the `mcp-*` Connect adapters).
 */
const MCP_INTEGRATION_KEY = "custom:mcp";

/**
 * The organization policy keys the owner's own setup of this connector in
 * Personal would check: a curated connector served by a dedicated adapter uses
 * that adapter's key, any other curated connector the generic MCP key, and a
 * workspace-authored custom server always the custom MCP key (plus the
 * dedicated key when it points at a reviewed endpoint).
 */
function integrationKeysForCarriedServer(
  server: Pick<OriginMcpCapabilityServer, "url" | "catalogScope">,
): string[] {
  const dedicated = dedicatedMcpIntegrationKey(server.url);
  if (server.catalogScope === "workspace")
    return dedicated ? [MCP_INTEGRATION_KEY, dedicated] : [MCP_INTEGRATION_KEY];
  return [dedicated ?? MCP_INTEGRATION_KEY];
}

/** Where a Personal workspace's carried connector comes from. */
export type PersonalWorkspaceConnectorOrigin = {
  originWorkspaceId: string;
  originWorkspaceName: string;
  /** `global`: a curated catalog connector; `workspace`: the origin's own custom MCP. */
  catalogScope: "global" | "workspace";
};

export type PersonalWorkspaceExtensionMcpServer = EnabledMcpCapabilityServer & {
  connectionRef: McpServerConnectionRef;
  personalExtension: PersonalWorkspaceConnectorOrigin;
  /**
   * Only with `includeLapsed`: the owner's account it is carried for stopped
   * working, so it is listed as needing reconnecting and never runs.
   */
  lapsedConnection?: Pick<
    ConnectionMetadata,
    "id" | "workspaceId" | "subjectId" | "providerDomain" | "status"
  >;
};

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

/**
 * The same match the account binder applies, against one owned connection.
 * An account from either integration backend counts as the connector's: the
 * backend switch later points the carried connector at the one it serves.
 */
function refMatchesConnection(
  ref: McpServerConnectionRef,
  connection: ConnectionMetadata,
): boolean {
  return (
    refMatchesLoginService(ref, connection) &&
    (!ref.connectionId || ref.connectionId === connection.id)
  );
}

/** The provider, kind and resource match, whichever account the reference pins. */
function refMatchesLoginService(
  ref: McpServerConnectionRef,
  connection: ConnectionMetadata,
): boolean {
  return (
    ref.authoritySource !== "host" &&
    sameConnectorProviderDomain(ref.providerDomain, connection.providerDomain) &&
    (!ref.kind || ref.kind === connection.kind) &&
    (!ref.resource ||
      (typeof connection.metadata.resource === "string" &&
        canonicalUrl(connection.metadata.resource) === canonicalUrl(ref.resource)))
  );
}

/**
 * The connector a login was made for, when it is a connector's sign-in: the
 * MCP endpoint it was connected for. Null for any other login.
 */
export function loginConnectorEndpoint(connection: ConnectionMetadata): string | null {
  const mcpUrl = connection.metadata.mcpUrl;
  return typeof mcpUrl === "string" && mcpUrl.trim() ? mcpUrl : null;
}

/** Whether two connector endpoints are the same, written either way. */
export function sameConnectorEndpoint(left: string, right: string): boolean {
  return canonicalUrl(left) === canonicalUrl(right);
}

/**
 * Whether a workspace has turned on the connector a login signs in to: one of
 * its enabled connectors is that endpoint, or binds that provider's accounts
 * (the account binder's provider, kind and resource match). Whose account an
 * enabled connector is set to use is a separate question; this only says
 * whether the connector is on.
 */
export function loginConnectorTurnedOn(
  servers: readonly Pick<EnabledMcpCapabilityServer, "url" | "connectionRef">[],
  connection: ConnectionMetadata,
): boolean {
  const endpoint = loginConnectorEndpoint(connection);
  return servers.some(
    (server) =>
      (endpoint !== null && canonicalUrl(server.url) === canonicalUrl(endpoint)) ||
      (server.connectionRef !== undefined &&
        refMatchesLoginService(server.connectionRef, connection)),
  );
}

/**
 * The carried connector always resolves the owner's own accounts: a generic
 * subject reference with no exact row, selector, host authority or resource
 * pins from the origin workspace.
 */
function personalSubjectRef(
  ref: McpServerConnectionRef,
  connection: ConnectionMetadata,
): McpServerConnectionRef {
  return {
    providerDomain: ref.providerDomain,
    ...(ref.provider ? { provider: ref.provider } : {}),
    kind: ref.kind ?? connection.kind,
    ...(ref.scopes ? { scopes: [...ref.scopes] } : {}),
    ...(ref.resource ? { resource: ref.resource } : {}),
    subjectScope: "subject",
  };
}

/**
 * Connectors a Personal workspace carries for its owner: the curated catalog
 * connectors and origin-defined custom MCP servers behind the owner's own
 * "Only me" connections made in other workspaces of the same organization.
 *
 * Derived on every read and never persisted. Only the workspace's own owner
 * (by the Personal pointer) receives anything; the owner must still hold live
 * authority in each origin workspace; the organization's integration policy
 * must allow each connector under the key its own setup in Personal would
 * check (`integrationKeysForCarriedServer`); workspace-held credential headers never travel
 * (only a subject reference that binds the owner's own accounts). The Personal
 * workspace's own settings win: any installation of the same capability
 * (enabled, or explicitly disabled), or a server it already serves with the
 * same id or endpoint, suppresses the carried copy. Shared workspaces are
 * unchanged.
 */
export async function personalWorkspaceExtensionMcpServers(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string | null | undefined;
    accountId?: string | undefined;
    /** The workspace's own servers (or how to read them, only when needed). */
    ownServers:
      | readonly Pick<EnabledMcpCapabilityServer, "id" | "url">[]
      | (() => Promise<readonly Pick<EnabledMcpCapabilityServer, "id" | "url">[]>);
    /** The owner's origin connections when the caller already read them. */
    origins?: readonly PersonalWorkspaceOriginConnections[];
    /**
     * Also carry connectors whose only matching connection stopped working,
     * so the catalog keeps listing them as needing reconnecting. Listings
     * only; never for anything that binds or runs a connector.
     */
    includeLapsed?: boolean;
  },
): Promise<PersonalWorkspaceExtensionMcpServer[]> {
  const subjectId = input.subjectId;
  if (!subjectId || !(subjectId.startsWith("user:") || subjectId.startsWith("external_user:")))
    return [];
  const accountId =
    input.accountId ?? (await rlsContextForWorkspace(db, input.workspaceId)).accountId;
  // One read at a time: `db` may be a single bounded transaction.
  const origins =
    input.origins ??
    (await personalWorkspaceOwnerOriginConnections(db, {
      accountId,
      workspaceId: input.workspaceId,
      subjectId,
      ...(input.includeLapsed ? { includeLapsed: true } : {}),
    }));
  if (origins.length === 0) return [];
  const policy = await readOrganizationIntegrationPolicyForServing(db, {
    accountId,
  });
  const allowedByPolicy = (server: OriginMcpCapabilityServer) =>
    policy.mode === "unrestricted" ||
    integrationKeysForCarriedServer(server).every((key) =>
      policy.allowedIntegrationKeys.includes(key),
    );
  const personalInstallations = new Set(
    (await listCapabilityInstallations(db, input.workspaceId))
      .filter((installation) => installation.kind === "mcp")
      .map((installation) => installation.capabilityId),
  );
  const ownServers =
    typeof input.ownServers === "function" ? await input.ownServers() : input.ownServers;
  const takenIds = new Set(ownServers.map((server) => server.id));
  const takenEndpoints = new Set(ownServers.map((server) => canonicalUrl(server.url)));
  type Candidate = {
    origin: PersonalWorkspaceOriginConnections;
    server: OriginMcpCapabilityServer;
    connection: PersonalWorkspaceOriginConnections["connections"][number];
  };
  const candidates: Candidate[] = [];
  for (const origin of origins) {
    const servers: OriginMcpCapabilityServer[] =
      await listOriginMcpCapabilityServersForPersonalExtension(db, origin.originWorkspaceId);
    for (const server of servers) {
      const matching = origin.connections.filter(
        (candidate) =>
          (input.includeLapsed || candidate.status === "active") &&
          refMatchesConnection(server.connectionRef, candidate),
      );
      // A working connection wins over one that stopped working.
      const connection = matching.find((candidate) => candidate.status === "active") ?? matching[0];
      if (!connection || !allowedByPolicy(server) || personalInstallations.has(server.capabilityId))
        continue;
      candidates.push({ origin, server, connection });
    }
  }
  // Working origins claim a server id or endpoint first, so a lapsed origin
  // listed earlier never shadows the one the runtime actually serves.
  const claimed = new Set<Candidate>();
  for (const working of [true, false]) {
    for (const candidate of candidates) {
      if ((candidate.connection.status === "active") !== working) continue;
      const { server } = candidate;
      if (takenIds.has(server.id) || takenEndpoints.has(canonicalUrl(server.url))) continue;
      takenIds.add(server.id);
      takenEndpoints.add(canonicalUrl(server.url));
      claimed.add(candidate);
    }
  }
  const originNames = new Map<string, string>();
  const carried: PersonalWorkspaceExtensionMcpServer[] = [];
  for (const candidate of candidates) {
    if (!claimed.has(candidate)) continue;
    const { origin, server, connection } = candidate;
    let originWorkspaceName = originNames.get(origin.originWorkspaceId);
    if (originWorkspaceName === undefined) {
      originWorkspaceName =
        (await getWorkspace(db, origin.originWorkspaceId))?.name ?? "another workspace";
      originNames.set(origin.originWorkspaceId, originWorkspaceName);
    }
    const { catalogScope, ...definition } = server;
    carried.push({
      ...definition,
      connectionRef: personalSubjectRef(server.connectionRef, connection),
      personalExtension: {
        originWorkspaceId: origin.originWorkspaceId,
        originWorkspaceName,
        catalogScope,
      },
      ...(connection.status !== "active"
        ? {
            lapsedConnection: {
              id: connection.id,
              workspaceId: connection.workspaceId,
              subjectId: connection.subjectId,
              providerDomain: connection.providerDomain,
              status: connection.status,
            },
          }
        : {}),
    });
  }
  return carried;
}

/**
 * Of `serverIds`, those that are the person's own connectors carried into
 * their Personal workspace whose account stopped working, as left-out picks.
 * A request naming one (a chat's tool selection made while it worked, or
 * from a list that still shows it) runs without it instead of being refused;
 * any other unknown id is still refused by the caller.
 */
export async function lapsedPersonalCarriedConnectors(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string | null | undefined;
    accountId?: string | undefined;
    serverIds: readonly string[];
    ownServers: readonly Pick<EnabledMcpCapabilityServer, "id" | "url">[];
  },
): Promise<OmittedConnectionAccount[]> {
  if (input.serverIds.length === 0) return [];
  const wanted = new Set(input.serverIds);
  const carried = await personalWorkspaceExtensionMcpServers(db, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    accountId: input.accountId,
    ownServers: input.ownServers,
    includeLapsed: true,
  });
  return carried.flatMap((server) =>
    server.lapsedConnection && wanted.has(server.id)
      ? [
          {
            serverId: server.id,
            connectionId: server.lapsedConnection.id,
            reason: "account_inactive" as const,
            account: {
              workspaceId: server.lapsedConnection.workspaceId,
              subjectId: server.lapsedConnection.subjectId,
              providerDomain: server.lapsedConnection.providerDomain,
              status: server.lapsedConnection.status,
            },
          },
        ]
      : [],
  );
}

export type PersonalWorkspaceExtensionApiIntegration = ApiIntegrationRuntime & {
  personalExtension: PersonalWorkspaceConnectorOrigin;
};

/**
 * The policy key the owner's own setup of this API Integration in Personal
 * would check: a curated definition's own id, or the custom key of its protocol
 * for a workspace-authored one (see `integrationSourceForOrganizationPolicy`).
 */
function integrationKeyForCarriedApiIntegration(
  integration: Pick<ApiIntegrationRuntime, "definitionProvenance" | "definitionId" | "protocol">,
): string {
  return integration.definitionProvenance === "curated"
    ? integration.definitionId
    : `custom:${integration.protocol}`;
}

/**
 * API Integrations (for example Outlook, OneDrive or Teams, or a workspace's
 * own OpenAPI or GraphQL service) a Personal workspace carries for its owner:
 * the origin workspace's installed instances bound to one of the owner's own
 * active "Only me" connections made there.
 *
 * The same rules as `personalWorkspaceExtensionMcpServers`: derived live and
 * never persisted; only the workspace's own owner, only while they still
 * belong to the origin workspace; never an instance bound to a workspace
 * account or to anyone else's; the organization policy must allow the
 * integration under the key its own setup would check. An API Integration
 * holds one instance per account, so Personal's own instances sit beside the
 * carried ones; only an instance Personal already has for the same account,
 * or a server it already serves with the same id, wins. Shared workspaces
 * are unchanged.
 */
export async function personalWorkspaceExtensionApiIntegrations(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string | null | undefined;
    accountId?: string | undefined;
    /** Server ids the workspace already serves (or how to read them, only when needed). */
    takenServerIds: readonly string[] | (() => Promise<readonly string[]>);
    /** Only instances with these runtime server ids (a live target fence). */
    serverIds?: readonly string[];
    /** The owner's origin connections when the caller already read them. */
    origins?: readonly PersonalWorkspaceOriginConnections[];
    /** Personal's own instances the owner sees, when the caller already read them. */
    ownIntegrations?: readonly Pick<ApiIntegrationRuntime, "connectionRef">[];
  },
): Promise<PersonalWorkspaceExtensionApiIntegration[]> {
  const subjectId = input.subjectId;
  if (!subjectId || !(subjectId.startsWith("user:") || subjectId.startsWith("external_user:")))
    return [];
  if (input.serverIds && input.serverIds.length === 0) return [];
  const accountId =
    input.accountId ?? (await rlsContextForWorkspace(db, input.workspaceId)).accountId;
  // One read at a time: `db` may be a single bounded transaction.
  const origins =
    input.origins ??
    (await personalWorkspaceOwnerOriginConnections(db, {
      accountId,
      workspaceId: input.workspaceId,
      subjectId,
    }));
  if (origins.length === 0) return [];
  const policy = await readOrganizationIntegrationPolicyForServing(db, {
    accountId,
  });
  const personalConnectionIds = new Set(
    (
      input.ownIntegrations ??
      (await listInstalledApiIntegrations(db, input.workspaceId, subjectId))
    ).flatMap((integration) =>
      integration.connectionRef?.connectionId ? [integration.connectionRef.connectionId] : [],
    ),
  );
  const taken = new Set(
    typeof input.takenServerIds === "function"
      ? await input.takenServerIds()
      : input.takenServerIds,
  );
  const carried: PersonalWorkspaceExtensionApiIntegration[] = [];
  for (const origin of origins) {
    const ownConnectionIds = new Set(
      origin.connections
        .filter((connection) => connection.status === "active")
        .map((connection) => connection.id),
    );
    const instances = await listInstalledApiIntegrations(
      db,
      origin.originWorkspaceId,
      subjectId,
      input.serverIds,
    );
    let originWorkspaceName: string | null = null;
    for (const instance of instances) {
      const ref = instance.connectionRef;
      if (
        !ref ||
        ref.subjectScope !== "subject" ||
        !ref.connectionId ||
        !ownConnectionIds.has(ref.connectionId) ||
        instance.connectionStatus !== "active" ||
        personalConnectionIds.has(ref.connectionId) ||
        taken.has(instance.serverId) ||
        (policy.mode !== "unrestricted" &&
          !policy.allowedIntegrationKeys.includes(integrationKeyForCarriedApiIntegration(instance)))
      )
        continue;
      originWorkspaceName ??=
        (await getWorkspace(db, origin.originWorkspaceId))?.name ?? "another workspace";
      taken.add(instance.serverId);
      carried.push({
        ...instance,
        personalExtension: {
          originWorkspaceId: origin.originWorkspaceId,
          originWorkspaceName,
          catalogScope: instance.definitionProvenance === "curated" ? "global" : "workspace",
        },
      });
    }
  }
  return carried;
}

/**
 * The API Integrations a workspace lists for one person: its own installed
 * instances that person can see, then, in their own Personal workspace, the
 * instances carried in for them (see `personalWorkspaceExtensionApiIntegrations`).
 * Carried instances keep `personalExtension` so surfaces can say where they
 * come from and leave their management to that workspace.
 */
export async function listApiIntegrationsWithPersonalExtension(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string | null | undefined;
    accountId?: string | undefined;
    /** Deployment-configured MCP servers whose ids are already taken. */
    deploymentMcpServerIds?: readonly string[];
  },
): Promise<
  (ApiIntegrationRuntime &
    Partial<Pick<PersonalWorkspaceExtensionApiIntegration, "personalExtension">>)[]
> {
  const own = await listInstalledApiIntegrations(
    db,
    input.workspaceId,
    input.subjectId ?? undefined,
  );
  const carried = await personalWorkspaceExtensionApiIntegrations(db, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    accountId: input.accountId,
    ownIntegrations: own,
    takenServerIds: async () => [
      ...(input.deploymentMcpServerIds ?? []),
      ...(await listEnabledMcpCapabilityServers(db, input.workspaceId)).map((server) => server.id),
      ...own.map((integration) => integration.serverId),
    ],
  });
  return [...own, ...carried];
}

/**
 * The subject a Personal workspace extension is computed for: the request's
 * own subject, or else the frozen owner of the turn's personal delegations.
 * Only the workspace's own owner can resolve anything (see
 * `personalWorkspaceOwnerOriginConnections`), so several owners - possible
 * only in a shared workspace - resolve nothing.
 */
export function personalWorkspaceExtensionSubject(options: {
  subjectId?: string | null | undefined;
  personalConnectionDelegations?: readonly McpPersonalConnectionDelegation[] | undefined;
}): string | null {
  if (options.subjectId) return options.subjectId;
  const owners = new Set(
    (options.personalConnectionDelegations ?? []).map((delegation) => delegation.ownerSubjectId),
  );
  return owners.size === 1 ? [...owners][0]! : null;
}
