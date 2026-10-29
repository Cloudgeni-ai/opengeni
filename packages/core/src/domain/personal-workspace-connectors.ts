import type {
  ConnectionMetadata,
  McpPersonalConnectionDelegation,
  McpServerConnectionRef,
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
import {
  personalWorkspaceOwnerOriginConnections,
  type PersonalWorkspaceOriginConnections,
} from "./personal-connection-delegations";

/**
 * Generic MCP enablement is classified as this key (see `prepareCapabilityEnable`
 * and the `mcp-*` Connect adapters).
 */
const MCP_INTEGRATION_KEY = "custom:mcp";

/**
 * Reviewed MCP endpoints a dedicated Connect adapter owns, with the policy key
 * that adapter checks (see `integrationKeyForConnectProvider`).
 */
const DEDICATED_MCP_INTEGRATION_KEYS: Readonly<Record<string, string>> = {
  "gmailmcp.googleapis.com": "gmail",
  "drivemcp.googleapis.com": "google-drive",
  "calendarmcp.googleapis.com": "google-calendar",
  "mcp.slack.com": "slack-personal",
};

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
  let host: string | null = null;
  try {
    host = new URL(server.url).hostname.toLowerCase();
  } catch {
    host = null;
  }
  const dedicated = host ? DEDICATED_MCP_INTEGRATION_KEYS[host] : undefined;
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

/** The same match the account binder applies, against one owned connection. */
function refMatchesConnection(
  ref: McpServerConnectionRef,
  connection: ConnectionMetadata,
): boolean {
  return (
    ref.authoritySource !== "host" &&
    ref.providerDomain.toLowerCase() === connection.providerDomain.toLowerCase() &&
    (!ref.kind || ref.kind === connection.kind) &&
    (!ref.connectionId || ref.connectionId === connection.id) &&
    (!ref.resource ||
      (typeof connection.metadata.resource === "string" &&
        canonicalUrl(connection.metadata.resource) === canonicalUrl(ref.resource)))
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
  const carried: PersonalWorkspaceExtensionMcpServer[] = [];
  for (const origin of origins) {
    const servers: OriginMcpCapabilityServer[] =
      await listOriginMcpCapabilityServersForPersonalExtension(db, origin.originWorkspaceId);
    let originWorkspaceName: string | null = null;
    for (const server of servers) {
      const connection = origin.connections.find((candidate) =>
        refMatchesConnection(server.connectionRef, candidate),
      );
      if (
        !connection ||
        !allowedByPolicy(server) ||
        personalInstallations.has(server.capabilityId) ||
        takenIds.has(server.id) ||
        takenEndpoints.has(canonicalUrl(server.url))
      )
        continue;
      originWorkspaceName ??=
        (await getWorkspace(db, origin.originWorkspaceId))?.name ?? "another workspace";
      const { catalogScope, ...definition } = server;
      takenIds.add(server.id);
      takenEndpoints.add(canonicalUrl(server.url));
      carried.push({
        ...definition,
        connectionRef: personalSubjectRef(server.connectionRef, connection),
        personalExtension: {
          originWorkspaceId: origin.originWorkspaceId,
          originWorkspaceName,
          catalogScope,
        },
      });
    }
  }
  return carried;
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
