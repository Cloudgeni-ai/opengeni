import type { McpServerConfig, Settings } from "@opengeni/config";
import type {
  AccessGrant,
  ConnectionMetadata,
  McpConnectionAuthoritySelection,
  McpPersonalConnectionDelegation,
  SessionTurn,
  SocialConnection,
  ToolRef,
} from "@opengeni/contracts";
import {
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
  GoogleDriveConnectionMetadata,
  googleDriveScopesAllowCapability,
} from "@opengeni/contracts/google-drive";
import {
  getSessionTurnPersonalConnectionDelegations,
  getConnectionMetadata,
  getSocialConnection,
  getWorkspaceGrant,
  listConnectionsMetadata,
  listSocialConnections,
  resolvePersonalConnectionAuthoritySelectionOrigin,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "@opengeni/db";

export type PersonalConnectionDelegationSource =
  | { kind: "subject"; subjectId: string }
  | { kind: "turn"; sessionId: string; turnId: string }
  | { kind: "none" };
export type AuthorizedSocialConnection = { connection: SocialConnection; subjectId: string | null };
export type AuthorizedAtlassianConnection = {
  connection: ConnectionMetadata;
  subjectId: string | null;
};

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

export async function authorizedSocialConnectionsForGrant(input: {
  db: Database;
  grant: AccessGrant;
  limit?: number;
}): Promise<AuthorizedSocialConnection[]> {
  const workspace = await listSocialConnections(
    input.db,
    input.grant.workspaceId,
    input.limit ?? 500,
    null,
  );
  const source = personalConnectionDelegationSourceForGrant(input.grant);
  if (source.kind === "none")
    return workspace.map((connection) => ({ connection, subjectId: null }));
  if (source.kind === "subject") {
    const visible = await listSocialConnections(
      input.db,
      input.grant.workspaceId,
      input.limit ?? 500,
      source.subjectId,
    );
    return visible.map((connection) => ({
      connection,
      subjectId: connection.ownership === "personal" ? source.subjectId : null,
    }));
  }
  const delegations = (
    await getSessionTurnPersonalConnectionDelegations(
      input.db,
      input.grant.workspaceId,
      source.sessionId,
      source.turnId,
    )
  ).filter((item) => item.connectionType === "social");
  const personal: AuthorizedSocialConnection[] = [];
  for (const delegation of delegations) {
    if (!(await getWorkspaceGrant(input.db, delegation.ownerSubjectId, input.grant.workspaceId)))
      continue;
    const connection = await getSocialConnection(
      input.db,
      input.grant.workspaceId,
      delegation.connectionId,
      delegation.ownerSubjectId,
    );
    if (!connection || connection.ownership !== "personal") continue;
    const domain = connection.provider === "x" ? "x.com" : `${connection.provider}.com`;
    if (!sameProviderDomain(domain, delegation.providerDomain)) continue;
    personal.push({ connection, subjectId: delegation.ownerSubjectId });
  }
  return [...workspace.map((connection) => ({ connection, subjectId: null })), ...personal];
}

export async function authorizedAtlassianConnectionsForGrant(input: {
  db: Database;
  grant: AccessGrant;
}): Promise<AuthorizedAtlassianConnection[]> {
  const workspace = (await listConnectionsMetadata(input.db, input.grant.workspaceId, null)).filter(
    (connection) =>
      connection.subjectId === null &&
      connection.status === "active" &&
      sameProviderDomain(connection.providerDomain, "api.atlassian.com"),
  );
  const source = personalConnectionDelegationSourceForGrant(input.grant);
  if (source.kind === "none") {
    return workspace.map((connection) => ({ connection, subjectId: null }));
  }
  if (source.kind === "subject") {
    const visible = await listConnectionsMetadata(
      input.db,
      input.grant.workspaceId,
      source.subjectId,
    );
    return visible
      .filter(
        (connection) =>
          connection.status === "active" &&
          sameProviderDomain(connection.providerDomain, "api.atlassian.com"),
      )
      .map((connection) => ({
        connection,
        subjectId: connection.subjectId === null ? null : source.subjectId,
      }));
  }
  const delegations = (
    await getSessionTurnPersonalConnectionDelegations(
      input.db,
      input.grant.workspaceId,
      source.sessionId,
      source.turnId,
    )
  ).filter((item) => item.connectionType === "atlassian");
  const personal: AuthorizedAtlassianConnection[] = [];
  for (const delegation of delegations) {
    if (!(await getWorkspaceGrant(input.db, delegation.ownerSubjectId, input.grant.workspaceId))) {
      continue;
    }
    const connection = await getConnectionMetadata(
      input.db,
      input.grant.workspaceId,
      delegation.connectionId,
      delegation.ownerSubjectId,
    );
    if (
      !connection ||
      connection.subjectId !== delegation.ownerSubjectId ||
      connection.status !== "active" ||
      !sameProviderDomain(connection.providerDomain, delegation.providerDomain) ||
      !sameProviderDomain(connection.providerDomain, "api.atlassian.com")
    ) {
      continue;
    }
    personal.push({ connection, subjectId: delegation.ownerSubjectId });
  }
  return [...workspace.map((connection) => ({ connection, subjectId: null })), ...personal];
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
  authoritySelections?: McpConnectionAuthoritySelection[];
  rejectUnselectedActivatedConnections?: boolean;
}): McpPersonalConnectionDelegation[] {
  const delegations: McpPersonalConnectionDelegation[] = [];
  const connections = canonicalPersonalConnections(input.connections);
  const selections = new Map(
    (input.authoritySelections ?? []).map((selection) => [selection.serverId, selection]),
  );
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
    const selection = selections.get(server.id);
    if (connection.authorityId) {
      if (
        !selection ||
        selection.connectionId !== connection.id ||
        selection.userDelegation.authorityId !== connection.authorityId
      ) {
        if (input.rejectUnselectedActivatedConnections) {
          throw new Error(
            `scheduled connection authority selection is required for activated server ${server.id}`,
          );
        }
        // Activated organization-user connections are never admitted through
        // the legacy owner tuple. The caller must select one exact opaque grant.
        continue;
      }
      selections.delete(server.id);
    } else if (selection) {
      throw new Error(`connection authority is not available for legacy server ${server.id}`);
    }
    delegations.push({
      serverId: server.id,
      connectionId: connection.id,
      ...(selection ? { originWorkspaceId: connection.workspaceId } : {}),
      ownerSubjectId: input.subjectId,
      providerDomain: connection.providerDomain,
      kind: connection.kind,
      ...(selection ? { userDelegation: selection.userDelegation } : {}),
    });
  }
  if (selections.size > 0) {
    throw new Error(
      `connection authority selection did not match an active selected server: ${[
        ...selections.keys(),
      ].join(", ")}`,
    );
  }
  return delegations;
}

export function personalConnectionDelegationsFromParent(input: {
  servers: McpServerConfig[];
  parentDelegations: McpPersonalConnectionDelegation[];
  targetSessionId?: string;
  rejectActivatedConnections?: boolean;
}): McpPersonalConnectionDelegation[] {
  // Every successor is new logical work. `once` remains bound to the original
  // accepted turn, `session` may be re-admitted only into that exact session,
  // and `always` may cross to another authorized session.
  const childEligible = (delegation: McpPersonalConnectionDelegation) => {
    const authority = delegation.userDelegation;
    if (!authority) return true;
    if (authority.mode === "once") return false;
    if (authority.mode === "session") return authority.sessionId === input.targetSessionId;
    return true;
  };
  const mcp = input.servers.flatMap((server) => {
    const ref = server.connectionRef;
    if (!ref || ref.subjectScope !== "subject") return [];
    const delegation = input.parentDelegations.find(
      (candidate) =>
        candidate.serverId === server.id &&
        sameProviderDomain(candidate.providerDomain, ref.providerDomain) &&
        (!ref.kind || !candidate.kind || candidate.kind === ref.kind),
    );
    return delegation && childEligible(delegation) ? [{ ...delegation }] : [];
  });
  const projected = [
    ...mcp,
    ...input.parentDelegations
      .filter(
        (item) =>
          childEligible(item) &&
          (item.connectionType === "social" ||
            item.connectionType === "atlassian" ||
            item.serverId === GOOGLE_DRIVE_PUBLICATION_SERVER_ID),
      )
      .map((item) => ({ ...item })),
  ];
  if (
    input.rejectActivatedConnections &&
    projected.some((delegation) => delegation.userDelegation)
  ) {
    throw new Error(
      "scheduled connection authority is not available until task occurrence authority is activated",
    );
  }
  return projected;
}

/**
 * Freezes Google Drive publishing only when one exact subject-owned connection
 * is eligible. Multiple writable Google accounts are intentionally ambiguous:
 * callers must narrow the connection before a later turn can advertise or use
 * the private publication tool.
 */
export function googleDrivePublicationDelegationFromVisibleConnections(input: {
  subjectId: string;
  connections: ConnectionMetadata[];
  authoritySelection?: McpConnectionAuthoritySelection;
  rejectUnselectedActivatedConnection?: boolean;
}): McpPersonalConnectionDelegation | null {
  const eligible = input.connections.filter((connection) => {
    if (
      connection.subjectId !== input.subjectId ||
      connection.status !== "active" ||
      connection.kind !== "oauth2" ||
      !sameProviderDomain(connection.providerDomain, GOOGLE_DRIVE_PROVIDER_DOMAIN) ||
      !googleDriveScopesAllowCapability(connection.grantedScopes, "publish_file")
    ) {
      return false;
    }
    const metadata = GoogleDriveConnectionMetadata.safeParse(connection.metadata);
    return Boolean(
      metadata.success &&
      metadata.data.outputDestination &&
      metadata.data.lifecycle?.state !== "paused" &&
      (!metadata.data.lifecycle || metadata.data.lifecycle.state === "active"),
    );
  });
  if (eligible.length !== 1) return null;
  const connection = eligible[0]!;
  const selection = input.authoritySelection;
  if (connection.authorityId) {
    if (
      !selection ||
      selection.serverId !== GOOGLE_DRIVE_PUBLICATION_SERVER_ID ||
      selection.connectionId !== connection.id ||
      selection.userDelegation.authorityId !== connection.authorityId
    ) {
      if (input.rejectUnselectedActivatedConnection) {
        throw new Error(
          "scheduled connection authority selection is required for activated Google Drive publication",
        );
      }
      return null;
    }
  } else if (selection) {
    throw new Error("connection authority is not available for legacy Google Drive publication");
  }
  return {
    serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
    connectionId: connection.id,
    ...(selection ? { originWorkspaceId: connection.workspaceId } : {}),
    ownerSubjectId: input.subjectId,
    providerDomain: connection.providerDomain,
    kind: connection.kind,
    ...(selection ? { userDelegation: selection.userDelegation } : {}),
  };
}

export function personalAtlassianDelegationsFromVisibleConnections(input: {
  subjectId: string;
  connections: ConnectionMetadata[];
  rejectActivatedConnections?: boolean;
}): McpPersonalConnectionDelegation[] {
  const eligible = input.connections.filter(
    (connection) =>
      connection.subjectId === input.subjectId &&
      connection.status === "active" &&
      sameProviderDomain(connection.providerDomain, "api.atlassian.com"),
  );
  if (input.rejectActivatedConnections && eligible.some((connection) => connection.authorityId)) {
    throw new Error(
      "scheduled connection authority selection is required for activated Atlassian access",
    );
  }
  // Atlassian's first-party multi-call adapter is a named successor. Until it
  // can consume an accepted snapshot, common-authority rows are omitted rather
  // than falling through the legacy owner-tuple resolver.
  return eligible
    .filter((connection) => !connection.authorityId)
    .map((connection) => ({
      serverId: `atlassian:${connection.id}`,
      connectionId: connection.id,
      ownerSubjectId: input.subjectId,
      providerDomain: connection.providerDomain,
      kind: connection.kind,
      connectionType: "atlassian" as const,
    }));
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
      other.originWorkspaceId === delegation.originWorkspaceId &&
      other.ownerSubjectId === delegation.ownerSubjectId &&
      sameProviderDomain(other.providerDomain, delegation.providerDomain) &&
      other.kind === delegation.kind &&
      other.connectionType === delegation.connectionType &&
      JSON.stringify(other.userDelegation ?? null) ===
        JSON.stringify(delegation.userDelegation ?? null)
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
 * frozen on the causal turn. A direct human subject, worker Codemode caller,
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
      const publicationDelegations =
        request.serverId === GOOGLE_DRIVE_PUBLICATION_SERVER_ID &&
        sameProviderDomain(request.connectionRef.providerDomain, GOOGLE_DRIVE_PROVIDER_DOMAIN)
          ? input.personalConnectionDelegations.filter(
              (candidate) =>
                candidate.serverId === GOOGLE_DRIVE_PUBLICATION_SERVER_ID &&
                sameProviderDomain(candidate.providerDomain, GOOGLE_DRIVE_PROVIDER_DOMAIN) &&
                candidate.kind === "oauth2" &&
                request.connectionRef.kind === "oauth2",
            )
          : [];
      const delegation = config
        ? personalConnectionDelegationForServer(input.personalConnectionDelegations, config)
        : publicationDelegations.length === 1
          ? publicationDelegations[0]!
          : null;
      if (
        !delegation ||
        (!delegation.userDelegation &&
          !(await input.ownerHasWorkspaceMembership(delegation.ownerSubjectId)))
      ) {
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
  authoritySelections?: McpConnectionAuthoritySelection[];
  rejectUnselectedActivatedConnections?: boolean;
  /** Exact first-party export tool + permission gate, not broad opengeni attachment. */
  googleDrivePublicationEnabled?: boolean;
  /** Exact first-party Atlassian tool + permission gate. */
  atlassianEnabled?: boolean;
  /** Exact target for successor-mode projection (`session` never crosses it). */
  targetSessionId?: string;
}): Promise<McpPersonalConnectionDelegation[]> {
  const servers = selectedPersonalConnectionServers(input.settings, input.tools);
  const includeFirstPartyConnections = input.tools.some((tool) => tool.id === "opengeni");
  if ((servers.length === 0 && !includeFirstPartyConnections) || input.source.kind === "none") {
    return [];
  }
  if (input.source.kind === "turn") {
    if ((input.authoritySelections?.length ?? 0) > 0) {
      throw new Error(
        "agent-created work inherits connection authority from its exact parent turn",
      );
    }
    const inherited = personalConnectionDelegationsFromParent({
      servers,
      parentDelegations: await getSessionTurnPersonalConnectionDelegations(
        input.db,
        input.workspaceId,
        input.source.sessionId,
        input.source.turnId,
      ),
      ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
      ...(input.rejectUnselectedActivatedConnections !== undefined
        ? { rejectActivatedConnections: input.rejectUnselectedActivatedConnections }
        : {}),
    });
    return inherited.filter((item) => {
      if (item.serverId === GOOGLE_DRIVE_PUBLICATION_SERVER_ID) {
        return input.googleDrivePublicationEnabled === true;
      }
      if (item.connectionType === "atlassian") {
        return includeFirstPartyConnections && input.atlassianEnabled === true;
      }
      if (item.connectionType === "social") {
        return includeFirstPartyConnections;
      }
      return true;
    });
  }
  const ownerSubjectId = input.source.subjectId;
  const membership = await getWorkspaceGrant(input.db, ownerSubjectId, input.workspaceId);
  const targetLocalConnections = await listConnectionsMetadata(
    input.db,
    input.workspaceId,
    ownerSubjectId,
  );
  const portableSelections = await Promise.all(
    (input.authoritySelections ?? []).map(async (selection) => {
      const originWorkspaceId = await resolvePersonalConnectionAuthoritySelectionOrigin(input.db, {
        accountId: selection.userDelegation.organizationId,
        targetWorkspaceId: input.workspaceId,
        subjectId: ownerSubjectId,
        connectionId: selection.connectionId,
        delegation: selection.userDelegation,
      });
      if (!originWorkspaceId) {
        throw new Error(`connection authority selection is unavailable: ${selection.serverId}`);
      }
      const connection = await getConnectionMetadata(
        input.db,
        originWorkspaceId,
        selection.connectionId,
        ownerSubjectId,
      );
      if (
        !connection ||
        connection.workspaceId !== originWorkspaceId ||
        connection.subjectId !== ownerSubjectId ||
        connection.authorityId !== selection.userDelegation.authorityId
      ) {
        throw new Error(`connection authority selection is unavailable: ${selection.serverId}`);
      }
      return connection;
    }),
  );
  if (!membership && portableSelections.length === 0) return [];
  const visibleConnections = [
    ...new Map(
      [...targetLocalConnections, ...portableSelections].map((connection) => [
        connection.id,
        connection,
      ]),
    ).values(),
  ];
  const selectedMcpServerIds = new Set(servers.map((server) => server.id));
  const supportedSelectionIds = new Set(selectedMcpServerIds);
  if (input.googleDrivePublicationEnabled) {
    supportedSelectionIds.add(GOOGLE_DRIVE_PUBLICATION_SERVER_ID);
  }
  const unsupportedSelections = (input.authoritySelections ?? []).filter(
    (selection) => !supportedSelectionIds.has(selection.serverId),
  );
  if (unsupportedSelections.length > 0) {
    throw new Error(
      `connection authority selection did not match a selected MCP server: ${unsupportedSelections
        .map((selection) => selection.serverId)
        .join(", ")}`,
    );
  }
  const mcp = personalConnectionDelegationsFromVisibleConnections({
    servers,
    subjectId: ownerSubjectId,
    connections: visibleConnections,
    authoritySelections: (input.authoritySelections ?? []).filter((selection) =>
      selectedMcpServerIds.has(selection.serverId),
    ),
    ...(input.rejectUnselectedActivatedConnections !== undefined
      ? { rejectUnselectedActivatedConnections: input.rejectUnselectedActivatedConnections }
      : {}),
  });
  if (!includeFirstPartyConnections) return mcp;
  const visible = await listSocialConnections(input.db, input.workspaceId, 500, ownerSubjectId);
  const latest = new Map<"x" | "reddit", (typeof visible)[number]>();
  for (const connection of visible) {
    if (
      connection.ownership !== "personal" ||
      connection.status !== "connected" ||
      (connection.provider !== "x" && connection.provider !== "reddit")
    )
      continue;
    const prior = latest.get(connection.provider);
    if (!prior || connection.updatedAt > prior.updatedAt)
      latest.set(connection.provider, connection);
  }
  const personalAtlassian = input.atlassianEnabled
    ? personalAtlassianDelegationsFromVisibleConnections({
        subjectId: ownerSubjectId,
        connections: visibleConnections,
        ...(input.rejectUnselectedActivatedConnections !== undefined
          ? { rejectActivatedConnections: input.rejectUnselectedActivatedConnections }
          : {}),
      })
    : [];
  const googleDriveAuthoritySelection = input.googleDrivePublicationEnabled
    ? (input.authoritySelections ?? []).find(
        (selection) => selection.serverId === GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      )
    : undefined;
  const googleDrivePublication = input.googleDrivePublicationEnabled
    ? googleDrivePublicationDelegationFromVisibleConnections({
        subjectId: ownerSubjectId,
        connections: visibleConnections,
        ...(googleDriveAuthoritySelection
          ? { authoritySelection: googleDriveAuthoritySelection }
          : {}),
        ...(input.rejectUnselectedActivatedConnections !== undefined
          ? { rejectUnselectedActivatedConnection: input.rejectUnselectedActivatedConnections }
          : {}),
      })
    : null;
  return [
    ...mcp,
    ...(googleDrivePublication ? [googleDrivePublication] : []),
    ...[...latest.values()].map((connection) => ({
      serverId: `social:${connection.provider}`,
      connectionId: connection.id,
      ownerSubjectId,
      providerDomain: connection.provider === "x" ? "x.com" : `${connection.provider}.com`,
      kind: "oauth2" as const,
      connectionType: "social" as const,
    })),
    ...personalAtlassian,
  ];
}
