import type { McpServerConfig, Settings } from "@opengeni/config";
import type {
  AccessGrant,
  ConnectionMetadata,
  McpPersonalConnectionDelegation,
  SessionTurn,
  ToolRef,
} from "@opengeni/contracts";
import {
  getSessionTurnPersonalConnectionDelegations,
  getWorkspaceGrant,
  listConnectionsMetadata,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "@opengeni/db";

export type PersonalConnectionDelegationSource =
  | { kind: "subject"; subjectId: string }
  | { kind: "turn"; sessionId: string; turnId: string }
  | { kind: "none" };

export function directPersonalConnectionSubjectId(
  turn: Pick<SessionTurn, "source" | "initiator" | "initiatorContext">,
): string | undefined {
  if ((turn.source !== "user" && turn.source !== "api") || turn.initiator.kind !== "subject") {
    return undefined;
  }
  return ["via", "viaTruncated", "provenanceError", "backfill"].some((key) =>
    Object.prototype.hasOwnProperty.call(turn.initiatorContext, key),
  )
    ? undefined
    : turn.initiator.subjectId;
}

export function personalConnectionDelegationSourceForGrant(
  grant: AccessGrant,
): PersonalConnectionDelegationSource {
  const callerSessionId = grant.metadata?.["sessionId"];
  const callerTurnId = grant.metadata?.["turnId"];
  if (typeof callerSessionId === "string" && typeof callerTurnId === "string") {
    return { kind: "turn", sessionId: callerSessionId, turnId: callerTurnId };
  }
  if (
    grant.principalKind === "agent_attempt" ||
    grant.principalKind === "service" ||
    grant.serviceInitiator
  ) {
    return { kind: "none" };
  }
  return { kind: "subject", subjectId: grant.subjectId };
}

export function selectedPersonalConnectionServers(
  settings: Pick<Settings, "mcpServers">,
  tools: ToolRef[],
): McpServerConfig[] {
  const selected = new Set(tools.map((tool) => tool.id));
  return settings.mcpServers.filter(
    (server) => selected.has(server.id) && server.connectionRef?.subjectScope === "subject",
  );
}

function canonicalPersonalConnections(connections: ConnectionMetadata[]): ConnectionMetadata[] {
  return [...connections].sort((left, right) => {
    const active = Number(right.status === "active") - Number(left.status === "active");
    if (active !== 0) return active;
    const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updated !== 0) return updated;
    const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (created !== 0) return created;
    return right.id.localeCompare(left.id);
  });
}

function sameProviderDomain(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function personalConnectionDelegationsFromVisibleConnections(input: {
  servers: McpServerConfig[];
  subjectId: string;
  connections: ConnectionMetadata[];
}): McpPersonalConnectionDelegation[] {
  const delegations: McpPersonalConnectionDelegation[] = [];
  const connections = canonicalPersonalConnections(input.connections);
  for (const server of input.servers) {
    const ref = server.connectionRef;
    if (!ref || ref.subjectScope !== "subject") continue;
    const connection = connections.find(
      (candidate) =>
        candidate.subjectId === input.subjectId &&
        candidate.status === "active" &&
        sameProviderDomain(candidate.providerDomain, ref.providerDomain) &&
        (!ref.kind || candidate.kind === ref.kind) &&
        (!ref.connectionId || candidate.id === ref.connectionId),
    );
    if (!connection) continue;
    delegations.push({
      serverId: server.id,
      connectionId: connection.id,
      ownerSubjectId: input.subjectId,
      providerDomain: connection.providerDomain,
      kind: connection.kind,
    });
  }
  return delegations;
}

export function personalConnectionDelegationsFromParent(input: {
  servers: McpServerConfig[];
  parentDelegations: McpPersonalConnectionDelegation[];
}): McpPersonalConnectionDelegation[] {
  return input.servers.flatMap((server) => {
    const ref = server.connectionRef;
    if (!ref || ref.subjectScope !== "subject") return [];
    const delegation = input.parentDelegations.find(
      (candidate) =>
        candidate.serverId === server.id &&
        sameProviderDomain(candidate.providerDomain, ref.providerDomain) &&
        (!ref.kind || !candidate.kind || candidate.kind === ref.kind),
    );
    return delegation ? [{ ...delegation }] : [];
  });
}

export function personalConnectionDelegationsEqual(
  left: McpPersonalConnectionDelegation[],
  right: McpPersonalConnectionDelegation[],
): boolean {
  if (left.length !== right.length) return false;
  const byServer = new Map(right.map((delegation) => [delegation.serverId, delegation]));
  return left.every((delegation) => {
    const other = byServer.get(delegation.serverId);
    return (
      other?.connectionId === delegation.connectionId &&
      other.ownerSubjectId === delegation.ownerSubjectId &&
      sameProviderDomain(other.providerDomain, delegation.providerDomain) &&
      other.kind === delegation.kind
    );
  });
}

export function personalConnectionDelegationForServer(
  delegations: McpPersonalConnectionDelegation[],
  server: Pick<McpServerConfig, "id" | "connectionRef">,
): McpPersonalConnectionDelegation | null {
  const ref = server.connectionRef;
  if (!ref || ref.subjectScope !== "subject") return null;
  return (
    delegations.find(
      (delegation) =>
        delegation.serverId === server.id &&
        sameProviderDomain(delegation.providerDomain, ref.providerDomain) &&
        (!ref.kind || !delegation.kind || delegation.kind === ref.kind),
    ) ?? null
  );
}

type ConnectionCredentialResolver = (
  request: ResolveConnectionCredentialInput,
) => Promise<ResolveConnectionCredentialResult>;

function personalAuthorityUnavailable(
  request: ResolveConnectionCredentialInput,
): ResolveConnectionCredentialResult {
  const ref = request.connectionRef;
  return {
    status: "auth_needed",
    reason: "personal_authority_unavailable",
    providerDomain: ref.providerDomain,
    ...(ref.provider ? { provider: ref.provider } : {}),
    ...(ref.scopes ? { scopes: ref.scopes } : {}),
    ...(ref.resource ? { resource: ref.resource } : {}),
    ...(ref.selectedResources ? { selectedResources: ref.selectedResources } : {}),
  };
}

/**
 * Resolves subject-owned MCP credentials only through the exact authority
 * frozen on the causal turn. A direct human subject, worker Toolspace caller,
 * retry, or recovery can identify the caller, but none may widen or replace
 * the persisted connection UUID.
 */
export function withFrozenPersonalConnectionDelegations(input: {
  resolveCredential: ConnectionCredentialResolver;
  settings: Pick<Settings, "mcpServers">;
  personalConnectionDelegations: McpPersonalConnectionDelegation[];
  ownerHasWorkspaceMembership: (subjectId: string) => Promise<boolean>;
}): ConnectionCredentialResolver {
  return async (request) => {
    let effectiveRequest = request;
    if (request.connectionRef.subjectScope === "subject") {
      const config = input.settings.mcpServers.find((server) => server.id === request.serverId);
      const delegation = config
        ? personalConnectionDelegationForServer(input.personalConnectionDelegations, config)
        : null;
      if (!delegation || !(await input.ownerHasWorkspaceMembership(delegation.ownerSubjectId))) {
        return personalAuthorityUnavailable(request);
      }
      effectiveRequest = {
        ...request,
        subjectId: delegation.ownerSubjectId,
        connectionRef: {
          ...request.connectionRef,
          providerDomain: delegation.providerDomain,
          connectionId: delegation.connectionId,
          ...(delegation.kind ? { kind: delegation.kind } : {}),
        },
      };
    }
    const result = await input.resolveCredential(effectiveRequest);
    if (result.status === "ok" || request.connectionRef.subjectScope !== "subject") {
      return result;
    }
    return personalAuthorityUnavailable(request);
  };
}

export async function freezePersonalConnectionDelegations(input: {
  db: Database;
  workspaceId: string;
  settings: Pick<Settings, "mcpServers">;
  tools: ToolRef[];
  source: PersonalConnectionDelegationSource;
}): Promise<McpPersonalConnectionDelegation[]> {
  const servers = selectedPersonalConnectionServers(input.settings, input.tools);
  if (servers.length === 0 || input.source.kind === "none") return [];
  if (input.source.kind === "turn") {
    return personalConnectionDelegationsFromParent({
      servers,
      parentDelegations: await getSessionTurnPersonalConnectionDelegations(
        input.db,
        input.workspaceId,
        input.source.sessionId,
        input.source.turnId,
      ),
    });
  }
  const membership = await getWorkspaceGrant(input.db, input.source.subjectId, input.workspaceId);
  if (!membership) return [];
  return personalConnectionDelegationsFromVisibleConnections({
    servers,
    subjectId: input.source.subjectId,
    connections: await listConnectionsMetadata(input.db, input.workspaceId, input.source.subjectId),
  });
}
