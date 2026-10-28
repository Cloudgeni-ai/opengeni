import type {
  ConnectionMetadata,
  McpPersonalConnectionDelegation,
  McpServerConnectionRef,
} from "@opengeni/contracts";
import {
  getWorkspace,
  listCapabilityInstallations,
  listOriginMcpCapabilityServersForPersonalExtension,
  rlsContextForWorkspace,
  type Database,
  type EnabledMcpCapabilityServer,
  type OriginMcpCapabilityServer,
} from "@opengeni/db";
import { readOrganizationIntegrationPolicyForServing } from "@opengeni/db/organization-integration-policy";
import { personalWorkspaceOwnerOriginConnections } from "./personal-connection-delegations";

/**
 * Generic MCP enablement is classified as this key (see `prepareCapabilityEnable`),
 * so a Personal workspace may carry a connector only while its owner could also
 * add one there.
 */
const MCP_INTEGRATION_KEY = "custom:mcp";

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
 * must allow MCP connectors; workspace-held credential headers never travel
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
  },
): Promise<PersonalWorkspaceExtensionMcpServer[]> {
  const subjectId = input.subjectId;
  if (!subjectId || !(subjectId.startsWith("user:") || subjectId.startsWith("external_user:")))
    return [];
  const accountId =
    input.accountId ?? (await rlsContextForWorkspace(db, input.workspaceId)).accountId;
  // One read at a time: `db` may be a single bounded transaction.
  const origins = await personalWorkspaceOwnerOriginConnections(db, {
    accountId,
    workspaceId: input.workspaceId,
    subjectId,
  });
  if (origins.length === 0) return [];
  const policy = await readOrganizationIntegrationPolicyForServing(db, { accountId });
  if (
    policy.mode !== "unrestricted" &&
    !policy.allowedIntegrationKeys.includes(MCP_INTEGRATION_KEY)
  )
    return [];
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
