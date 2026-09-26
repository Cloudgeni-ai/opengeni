import type { McpServerConfig, Settings } from "@opengeni/config";
import type {
  AccessGrant,
  ConnectionMetadata,
  McpConnectionAccountBinding,
  McpConnectionAccountSelection,
  McpPersonalConnectionDelegation,
  McpServerConnectionRef,
  ResourceRef,
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
  isPersonalGitHubConnection,
  PERSONAL_GITHUB_CONNECTION_SURFACE_ID,
  PersonalGitHubConnectionMetadata,
} from "@opengeni/contracts/personal-github";
import {
  getPersonalGitHubRepositorySelectionState,
  getSessionTurnPersonalConnectionDelegations,
  getSessionTurnMcpAccountBindings,
  getConnectionMetadata,
  getSocialConnection,
  listConnectionsMetadata,
  listSocialConnections,
  listOwnedConnectionAccounts,
  namedSubjectHasLiveWorkspaceAuthority,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "@opengeni/db";
import { personalGitHubRepositoryResources } from "./resources";
import { ConnectionAccountSelectionError } from "./connection-account-selection-error";
export { ConnectionAccountSelectionError } from "./connection-account-selection-error";
import {
  mcpAccountBindingsFromVisibleConnections,
  personalDelegationsForAccountBindings,
} from "./mcp-account-bindings";

export type PersonalConnectionDelegationSource =
  | {
      kind: "subject";
      subjectId: string;
      /**
       * Organization of the authorizing grant. The owner-only
       * personal-workspace pointer lives on an organization membership, so
       * the account is part of the question, not an optimization.
       */
      accountId: string;
    }
  | { kind: "turn"; sessionId: string; turnId: string }
  | { kind: "none" };

/**
 * Is `subjectId` still authorized in `workspaceId`?
 *
 * Personal-connection authority has always been "the owner must still belong
 * to this workspace", but the old check was `getWorkspaceGrant` - a bare
 * `workspace_memberships` join. A managed human's personal workspace
 * deliberately has no row in that table (migration 0219 raises on one), so the
 * join answered `false` for the one person who always belongs, and every
 * personal connection silently disappeared inside the owner's own private
 * workspace.
 *
 * `namedSubjectHasLiveWorkspaceAuthority` models both halves - the membership
 * row and the organization membership's `personal_workspace_id` pointer - but
 * it is an **oracle, not an authorization**: it answers for whatever subject it
 * is handed and cannot establish who the caller is (see its doc comment in
 * `@opengeni/db`). Every use is safe only because *this* module has already
 * established entitlement to ask, locally:
 *
 * - at freeze time the subject is `source.subjectId`, and
 *   `personalConnectionDelegationSourceForGrant` admits only a grant whose
 *   `subjectId` came from a real authenticated principal. Agent-attempt,
 *   service, service-initiated, and **delegated/bearer** grants never reach
 *   this branch: they resolve to `{kind:"none"}`, or - for a worker-signed
 *   agent attempt - to `{kind:"turn"}`, which probes only a frozen
 *   `ownerSubjectId` already persisted for the grant's own workspace. Either
 *   way an unvalidated signed-token subject is never the probed subject; and
 * - on the `*ForGrant` paths the subject is the frozen `ownerSubjectId` of a
 *   delegation already persisted for the workspace the caller is already
 *   authorized in.
 *
 * Do not pass any other subject through this helper. A subject that was merely
 * looked up, guessed, or supplied by a caller is not entitled.
 */
async function ownerStillBelongsToWorkspace(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<boolean> {
  return await namedSubjectHasLiveWorkspaceAuthority(db, input);
}
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
  // LOAD-BEARING ORDERING. This turn branch sits ABOVE the delegated filter
  // below, so a grant carrying both `sessionId` and `turnId` never reaches that
  // filter. That is safe only because `DelegatedAccessTokenPayload`'s
  // `superRefine` forbids `principalKind: "human_session"` from carrying any
  // attempt claim (`turnId`/`attemptId`/`executionGeneration`), so a delegated
  // human-session bearer is structurally unable to take this branch. If that
  // refinement is ever relaxed, a delegated bearer could route around the
  // delegated filter by presenting a turn reference - move the filter above
  // this branch at the same time. Pinned by
  // `packages/contracts/test/delegated-access-token-attempt-claims.test.ts`.
  if (typeof callerSessionId === "string" && typeof callerTurnId === "string") {
    return { kind: "turn", sessionId: callerSessionId, turnId: callerTurnId };
  }
  if (
    grant.principalKind === "agent_attempt" ||
    grant.principalKind === "service" ||
    grant.serviceInitiator ||
    // A delegated bearer's grant is built entirely from signed token payload
    // (`delegatedAccessContext`); no database row binds its `subjectId` or
    // `workspaceId` to anything. It is therefore never an entitled subject for
    // the owner-only personal-workspace pointer, which CLAUDE.md reserves for
    // the canonical managed-cookie session: "Bearer/delegated principals, API
    // keys, and account or organization administrators receive no
    // personal-workspace access through that exception." Before the pointer
    // existed this was moot - `getWorkspaceGrant` returned null for a personal
    // workspace regardless - so the filter belongs with the pointer.
    //
    // Why testing THIS field is sound while inspecting the others is not: a
    // host signs `subjectId`, `principalKind`, and `serviceInitiator` into the
    // token itself, so those are host-chosen and a hostile host picks whatever
    // it likes. `metadata.delegated` is different - it is stamped by
    // `delegatedAccessContext` in `@opengeni/core` AFTER the token signature is
    // verified, and is not carried in the payload at all, so a host cannot
    // clear it. Do not "harden" this by switching to `principalKind`. The
    // strictly better shape is a positive assertion of how the request
    // authenticated (a canonical managed-cookie stamp) rather than any
    // inspection of the grant; that convergence is tracked separately.
    grant.metadata?.delegated === true
  ) {
    return { kind: "none" };
  }
  return { kind: "subject", subjectId: grant.subjectId, accountId: grant.accountId };
}

/** Account-picker inventory: shared workspace accounts and this sender's own
 * personal accounts. Visibility is never an execution grant or a credential
 * response; every selected connection is validated again at admission/use. */
export async function listOwnConnectionAccountsForGrant(
  db: Database,
  grant: AccessGrant,
): Promise<ConnectionMetadata[]> {
  const source = personalConnectionDelegationSourceForGrant(grant);
  const workspace = (await listConnectionsMetadata(db, grant.workspaceId, null)).filter(
    (connection) =>
      connection.subjectId === null &&
      connection.workspaceId === grant.workspaceId &&
      connection.accountId === grant.accountId &&
      connection.status === "active",
  );
  if (source.kind !== "subject") return workspace;
  const personal = await listOwnConnectionMetadata(db, {
    ...source,
    workspaceId: grant.workspaceId,
  });
  return [...workspace, ...personal];
}

async function listOwnConnectionMetadata(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<ConnectionMetadata[]> {
  const accounts = await listOwnedConnectionAccounts(db, input);
  const connections: ConnectionMetadata[] = [];
  // The caller may supply a transaction handle (for example, credential
  // rotation). Each metadata read opens a nested RLS savepoint on that same
  // connection, so these reads must not overlap.
  for (const account of accounts) {
    const connection = await getConnectionMetadata(
      db,
      account.originWorkspaceId,
      account.connectionId,
      input.subjectId,
    );
    if (
      connection?.accountId === input.accountId &&
      connection.subjectId === input.subjectId &&
      connection.authorityId != null &&
      connection.status === "active"
    )
      connections.push(connection);
  }
  return connections;
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
    if (
      !(await ownerStillBelongsToWorkspace(input.db, {
        accountId: input.grant.accountId,
        workspaceId: input.grant.workspaceId,
        subjectId: delegation.ownerSubjectId,
      }))
    )
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
    if (
      !(await ownerStillBelongsToWorkspace(input.db, {
        accountId: input.grant.accountId,
        workspaceId: input.grant.workspaceId,
        subjectId: delegation.ownerSubjectId,
      }))
    ) {
      continue;
    }
    const connection = await getConnectionMetadata(
      input.db,
      delegation.originWorkspaceId ?? input.grant.workspaceId,
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
    (server) => selected.has(server.id) && isNativeSubjectConnectionRef(server.connectionRef),
  );
}

function isNativeSubjectConnectionRef(
  ref: McpServerConnectionRef | null | undefined,
): ref is McpServerConnectionRef & { subjectScope: "subject" } {
  return ref?.subjectScope === "subject" && ref.authoritySource !== "host";
}

function sameProviderDomain(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function canonicalConnectionResource(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return value.trim();
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function personalConnectionDelegationsFromVisibleConnections(input: {
  servers: McpServerConfig[];
  subjectId: string;
  connections: ConnectionMetadata[];
  authoritySelections?: McpConnectionAccountSelection[];
}): McpPersonalConnectionDelegation[] {
  const delegations: McpPersonalConnectionDelegation[] = [];
  const connections = input.connections;
  const selections = new Map(
    (input.authoritySelections ?? []).map((selection) => [selection.serverId, selection]),
  );
  for (const server of input.servers) {
    const ref = server.connectionRef;
    if (!isNativeSubjectConnectionRef(ref)) continue;
    const selection = selections.get(server.id);
    const eligible = connections.filter(
      (candidate) =>
        candidate.subjectId === input.subjectId &&
        candidate.status === "active" &&
        candidate.authorityId !== undefined &&
        candidate.authorityId !== null &&
        sameProviderDomain(candidate.providerDomain, ref.providerDomain) &&
        (!ref.kind || candidate.kind === ref.kind) &&
        (!ref.resource ||
          (typeof candidate.metadata.resource === "string" &&
            canonicalConnectionResource(candidate.metadata.resource) ===
              canonicalConnectionResource(ref.resource))) &&
        (!ref.connectionId || candidate.id === ref.connectionId),
    );
    if (!selection && eligible.length > 1) {
      throw new ConnectionAccountSelectionError(
        `Choose an account for ${server.id}: multiple connected accounts match.`,
      );
    }
    const connection = selection
      ? eligible.find((candidate) => candidate.id === selection.connectionId)
      : eligible[0];
    if (!connection) continue;
    selections.delete(server.id);
    delegations.push({
      serverId: server.id,
      connectionId: connection.id,
      originWorkspaceId: connection.workspaceId,
      ownerSubjectId: input.subjectId,
      providerDomain: connection.providerDomain,
      kind: connection.kind,
    });
  }
  if (selections.size > 0) {
    throw new ConnectionAccountSelectionError(
      `Selected account is unavailable for: ${[...selections.keys()].join(", ")}`,
    );
  }
  return delegations;
}

export function personalConnectionDelegationsFromParent(input: {
  servers: McpServerConfig[];
  parentDelegations: McpPersonalConnectionDelegation[];
  personalGitHubResources?: ResourceRef[];
  targetSessionId?: string;
}): McpPersonalConnectionDelegation[] {
  const mcp = input.servers.flatMap((server) => {
    const ref = server.connectionRef;
    if (!isNativeSubjectConnectionRef(ref)) return [];
    const delegation = input.parentDelegations.find(
      (candidate) =>
        candidate.serverId === server.id &&
        sameProviderDomain(candidate.providerDomain, ref.providerDomain) &&
        (!ref.kind || !candidate.kind || candidate.kind === ref.kind),
    );
    return delegation ? [{ ...delegation }] : [];
  });
  const projected = [
    ...mcp,
    ...input.parentDelegations
      .filter(
        (item) =>
          item.connectionType === "social" ||
          item.connectionType === "atlassian" ||
          item.connectionType === "github_personal" ||
          item.serverId === GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      )
      .map((item) => ({ ...item })),
  ];
  const requestedGitHub = personalGitHubRepositoryResources(input.personalGitHubResources ?? []);
  const inherited = projected.flatMap((delegation) => {
    if (delegation.connectionType !== "github_personal") return [delegation];
    if (requestedGitHub.length === 0) return [];
    const snapshot = delegation.personalGitHubRepositorySelection;
    if (!snapshot) return [];
    const repositories = requestedGitHub.map((resource) => {
      const parent = snapshot.repositories.find(
        (candidate) =>
          candidate.repositoryId === resource.repositoryId &&
          candidate.canonicalUrl === resource.uri &&
          candidate.ref === resource.ref,
      );
      if (
        !parent ||
        resource.credentialBindingId !== snapshot.credentialBindingId ||
        (resource.access === "write" && parent.access !== "write")
      ) {
        throw new Error("agent-created personal GitHub repository exceeds parent authority");
      }
      return { ...parent, access: resource.access };
    });
    return [
      {
        ...delegation,
        personalGitHubRepositorySelection: { ...snapshot, repositories },
      },
    ];
  });
  if (
    requestedGitHub.length > 0 &&
    !inherited.some((delegation) => delegation.connectionType === "github_personal")
  ) {
    throw new Error("agent-created personal GitHub repository authority is unavailable");
  }
  return inherited;
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
  authoritySelection?: McpConnectionAccountSelection;
}): McpPersonalConnectionDelegation | null {
  const selection = input.authoritySelection;
  const eligible = input.connections.filter((connection) => {
    if (
      connection.subjectId !== input.subjectId ||
      connection.status !== "active" ||
      !connection.authorityId ||
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
  const selectedEligible = selection
    ? eligible.filter((connection) => connection.id === selection.connectionId)
    : eligible;
  if (selection && selectedEligible.length !== 1) {
    throw new Error("Google Drive publication authority selection is unavailable");
  }
  if (!selection && selectedEligible.length !== 1) return null;
  const connection = selectedEligible[0]!;
  if (selection && selection.serverId !== GOOGLE_DRIVE_PUBLICATION_SERVER_ID) {
    throw new Error("Google Drive publication account selection is invalid");
  }
  // Freeze the exact output destination on the accepted delegation: a later
  // connection-settings change must never redirect an already-accepted turn's
  // publication. Eligibility above already proved the metadata parses and the
  // destination exists.
  const frozenMetadata = GoogleDriveConnectionMetadata.parse(connection.metadata);
  if (!frozenMetadata.outputDestination) {
    throw new Error("Google Drive publication destination disappeared during acceptance");
  }
  return {
    serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
    connectionId: connection.id,
    originWorkspaceId: connection.workspaceId,
    ownerSubjectId: input.subjectId,
    providerDomain: connection.providerDomain,
    kind: connection.kind,
    outputDestination: frozenMetadata.outputDestination,
  };
}

export function personalAtlassianDelegationsFromVisibleConnections(input: {
  subjectId: string;
  connections: ConnectionMetadata[];
}): McpPersonalConnectionDelegation[] {
  const eligible = input.connections.filter(
    (connection) =>
      connection.subjectId === input.subjectId &&
      connection.status === "active" &&
      sameProviderDomain(connection.providerDomain, "api.atlassian.com"),
  );
  return eligible
    .filter((connection) => connection.authorityId != null)
    .map((connection) => ({
      serverId: `atlassian:${connection.id}`,
      connectionId: connection.id,
      originWorkspaceId: connection.workspaceId,
      ownerSubjectId: input.subjectId,
      providerDomain: connection.providerDomain,
      kind: connection.kind,
      connectionType: "atlassian" as const,
    }));
}

async function personalGitHubDelegationFromVisibleConnections(input: {
  db: Database;
  accountId: string;
  subjectId: string;
  connections: ConnectionMetadata[];
  resources: ResourceRef[];
  authoritySelection?: McpConnectionAccountSelection;
}): Promise<McpPersonalConnectionDelegation | null> {
  const resources = personalGitHubRepositoryResources(input.resources);
  if (resources.length === 0) {
    if (input.authoritySelection) {
      throw new Error("personal GitHub connection authority requires selected repositories");
    }
    return null;
  }
  const bindingIds = new Set(resources.map((resource) => resource.credentialBindingId));
  if (bindingIds.size !== 1) {
    throw new Error("accepted work may use only one personal GitHub account");
  }
  const authoritySelection = input.authoritySelection;
  const credentialBindingId = [...bindingIds][0]!;
  const connection = input.connections.find(
    (candidate) =>
      (!authoritySelection || candidate.id === authoritySelection.connectionId) &&
      candidate.subjectId === input.subjectId &&
      candidate.status === "active" &&
      isPersonalGitHubConnection(candidate) &&
      PersonalGitHubConnectionMetadata.safeParse(candidate.metadata).data?.credentialBindingId ===
        credentialBindingId,
  );
  if (
    !connection ||
    !connection.authorityId ||
    connection.grantedScopes.length !== 1 ||
    connection.grantedScopes[0] !== "repo"
  ) {
    throw new Error("personal GitHub connection authority selection is unavailable");
  }
  const metadata = PersonalGitHubConnectionMetadata.parse(connection.metadata);
  if (metadata.credentialBindingId !== credentialBindingId) {
    throw new Error("personal GitHub credential binding does not match the selected connection");
  }
  const selection = await getPersonalGitHubRepositorySelectionState(input.db, {
    accountId: input.accountId,
    originWorkspaceId: connection.workspaceId,
    subjectId: input.subjectId,
    connectionId: connection.id,
  });
  if (
    !selection ||
    selection.selectionGeneration <= 0 ||
    selection.credentialBindingId !== credentialBindingId ||
    selection.providerPrincipalId !== metadata.providerPrincipalId
  ) {
    throw new Error("personal GitHub repository selection changed or is unavailable");
  }
  const selectedById = new Map(
    selection.repositories.map((repository) => [repository.repositoryId, repository]),
  );
  const repositories = resources.map((resource) => {
    const selected = selectedById.get(resource.repositoryId);
    if (
      !selected ||
      selected.canonicalUrl !== resource.uri ||
      (resource.access === "write" && selected.selectedAccess !== "write")
    ) {
      throw new Error("personal GitHub repository resource is outside the selected authority");
    }
    return {
      repositoryId: selected.repositoryId,
      fullName: selected.fullName,
      canonicalUrl: selected.canonicalUrl,
      ref: resource.ref,
      access: resource.access,
      selectionGeneration: selected.selectionGeneration,
    };
  });
  return {
    serverId: PERSONAL_GITHUB_CONNECTION_SURFACE_ID,
    connectionId: connection.id,
    originWorkspaceId: connection.workspaceId,
    ownerSubjectId: input.subjectId,
    providerDomain: "github.com",
    kind: "oauth2",
    connectionType: "github_personal",
    personalGitHubRepositorySelection: {
      credentialBindingId,
      connectionAuthorityGeneration: selection.connectionAuthorityGeneration,
      selectionGeneration: selection.selectionGeneration,
      repositories,
    },
  };
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
      other.canonicalServerId === delegation.canonicalServerId &&
      other.originWorkspaceId === delegation.originWorkspaceId &&
      other.ownerSubjectId === delegation.ownerSubjectId &&
      sameProviderDomain(other.providerDomain, delegation.providerDomain) &&
      other.kind === delegation.kind &&
      other.connectionType === delegation.connectionType &&
      JSON.stringify(other.personalGitHubRepositorySelection ?? null) ===
        JSON.stringify(delegation.personalGitHubRepositorySelection ?? null)
    );
  });
}

export function personalConnectionDelegationForServer(
  delegations: McpPersonalConnectionDelegation[],
  server: Pick<McpServerConfig, "id" | "connectionRef">,
): McpPersonalConnectionDelegation | null {
  const ref = server.connectionRef;
  if (!isNativeSubjectConnectionRef(ref)) return null;
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
  /**
   * Does the frozen delegation owner still hold workspace authority? Supply
   * the canonical `namedSubjectHasLiveWorkspaceAuthority` resolver, never a bare
   * `workspace_memberships` lookup: a managed human's personal workspace has
   * no membership row, so a bare lookup revokes the owner's own connections.
   */
  ownerHasWorkspaceMembership: (subjectId: string) => Promise<boolean>;
}): ConnectionCredentialResolver {
  return async (request) => {
    let effectiveRequest = request;
    const nativeSubjectAuthority = isNativeSubjectConnectionRef(request.connectionRef);
    if (nativeSubjectAuthority) {
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
    if (result.status === "ok" || !nativeSubjectAuthority) {
      return result;
    }
    return personalAuthorityUnavailable(request);
  };
}

/** Freeze all native account routes without conflating workspace ownership
 * with the exact causal human required for personal connections. */
export async function freezeConnectionAccounts(
  input: Parameters<typeof freezePersonalConnectionDelegations>[0] & { accountId: string },
): Promise<{
  mcpAccountBindings: McpConnectionAccountBinding[] | null;
  personalConnectionDelegations: McpPersonalConnectionDelegation[];
}> {
  const selectedIds = new Set(input.tools.map((tool) => tool.id));
  const servers = input.settings.mcpServers.filter(
    (server) =>
      selectedIds.has(server.id) &&
      server.connectionRef &&
      server.connectionRef.authoritySource !== "host",
  );
  const serverIds = new Set(servers.map((server) => server.id));
  let mcpAccountBindings: McpConnectionAccountBinding[];
  if (input.source.kind === "turn") {
    if (input.authoritySelections?.length) {
      throw new ConnectionAccountSelectionError(
        "Agent-created work inherits the exact parent accounts",
      );
    }
    const inherited = await getSessionTurnMcpAccountBindings(
      input.db,
      input.workspaceId,
      input.source.sessionId,
      input.source.turnId,
    );
    if (inherited === null) {
      return {
        mcpAccountBindings: null,
        personalConnectionDelegations: await freezePersonalConnectionDelegations(input),
      };
    }
    mcpAccountBindings = inherited.filter((binding) => serverIds.has(binding.canonicalServerId));
  } else {
    const personal =
      input.source.kind === "subject" &&
      (await ownerStillBelongsToWorkspace(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.source.subjectId,
      }))
        ? await listOwnConnectionMetadata(input.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.source.subjectId,
          })
        : [];
    const workspace = await listConnectionsMetadata(input.db, input.workspaceId, null);
    mcpAccountBindings = mcpAccountBindingsFromVisibleConnections({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.source.kind === "subject" ? input.source.subjectId : null,
      servers,
      selectionsFrozen: input.authoritySelectionsFrozen === true,
      connections: [
        ...workspace.filter((connection) => connection.subjectId === null),
        ...personal,
      ],
      ...(input.authoritySelections
        ? {
            selections: input.authoritySelections.filter((selection) =>
              serverIds.has(selection.serverId),
            ),
          }
        : {}),
    });
  }
  // Dedicated first-party publication/repository/social surfaces keep their
  // existing selection and authority contracts; they are not generic MCP routes.
  const special = await freezePersonalConnectionDelegations({
    ...input,
    settings: {
      ...input.settings,
      mcpServers: input.settings.mcpServers.filter((server) => !serverIds.has(server.id)),
    },
    ...(input.authoritySelections
      ? {
          authoritySelections: input.authoritySelections.filter(
            (selection) => !serverIds.has(selection.serverId),
          ),
        }
      : {}),
  });
  return {
    mcpAccountBindings,
    personalConnectionDelegations: [
      ...personalDelegationsForAccountBindings(mcpAccountBindings),
      ...special,
    ],
  };
}

export async function freezePersonalConnectionDelegations(input: {
  db: Database;
  workspaceId: string;
  settings: Pick<Settings, "mcpServers"> & Partial<Pick<Settings, "githubPersonalOauthEnabled">>;
  tools: ToolRef[];
  resources?: ResourceRef[];
  source: PersonalConnectionDelegationSource;
  authoritySelections?: McpConnectionAccountSelection[];
  /** Internal durable schedule snapshot, not a default account selector. */
  authoritySelectionsFrozen?: boolean;
  /** Exact first-party export tool + permission gate, not broad opengeni attachment. */
  googleDrivePublicationEnabled?: boolean;
  /** Exact first-party Atlassian tool + permission gate. */
  atlassianEnabled?: boolean;
  /** Exact target for successor-mode projection (`session` never crosses it). */
  targetSessionId?: string;
}): Promise<McpPersonalConnectionDelegation[]> {
  const servers = selectedPersonalConnectionServers(input.settings, input.tools);
  const includeFirstPartyConnections = input.tools.some((tool) => tool.id === "opengeni");
  const personalGitHubResources = personalGitHubRepositoryResources(input.resources ?? []);
  if (personalGitHubResources.length > 0 && input.settings.githubPersonalOauthEnabled !== true) {
    throw new Error("personal GitHub repository authority is not enabled");
  }
  if (personalGitHubResources.length > 0 && input.source.kind === "none") {
    throw new Error("personal GitHub repository authority requires an authenticated causal human");
  }
  if (
    servers.length === 0 &&
    !includeFirstPartyConnections &&
    personalGitHubResources.length === 0
  ) {
    return [];
  }
  if (input.source.kind === "none") {
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
      personalGitHubResources,
      ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
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
  const membership = await ownerStillBelongsToWorkspace(input.db, {
    accountId: input.source.accountId,
    workspaceId: input.workspaceId,
    subjectId: ownerSubjectId,
  });
  if (!membership) {
    if ((input.authoritySelections?.length ?? 0) > 0) {
      throw new ConnectionAccountSelectionError(
        "Selected connection account requires live owner workspace access",
      );
    }
    if (personalGitHubResources.length > 0) {
      throw new Error("personal GitHub repository authority requires live causal user authority");
    }
    return [];
  }
  const visibleConnections = await listOwnConnectionMetadata(input.db, {
    accountId: input.source.accountId,
    workspaceId: input.workspaceId,
    subjectId: ownerSubjectId,
  });
  const selectedMcpServerIds = new Set(servers.map((server) => server.id));
  const supportedSelectionIds = new Set(selectedMcpServerIds);
  if (input.googleDrivePublicationEnabled) {
    supportedSelectionIds.add(GOOGLE_DRIVE_PUBLICATION_SERVER_ID);
  }
  if (personalGitHubResources.length > 0) {
    supportedSelectionIds.add(PERSONAL_GITHUB_CONNECTION_SURFACE_ID);
  }
  const unsupportedSelections = (input.authoritySelections ?? []).filter(
    (selection) => !supportedSelectionIds.has(selection.serverId),
  );
  if (unsupportedSelections.length > 0) {
    throw new ConnectionAccountSelectionError(
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
  });
  const personalGitHubAuthoritySelection = (input.authoritySelections ?? []).find(
    (selection) => selection.serverId === PERSONAL_GITHUB_CONNECTION_SURFACE_ID,
  );
  const personalGitHub = await personalGitHubDelegationFromVisibleConnections({
    db: input.db,
    accountId: input.source.accountId,
    subjectId: ownerSubjectId,
    connections: input.authoritySelectionsFrozen
      ? visibleConnections.filter(
          (connection) => connection.id === personalGitHubAuthoritySelection?.connectionId,
        )
      : visibleConnections,
    resources: input.resources ?? [],
    ...(personalGitHubAuthoritySelection
      ? { authoritySelection: personalGitHubAuthoritySelection }
      : {}),
  });
  if (!includeFirstPartyConnections) {
    return [...mcp, ...(personalGitHub ? [personalGitHub] : [])];
  }
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
        connections: input.authoritySelectionsFrozen
          ? visibleConnections.filter(
              (connection) => connection.id === googleDriveAuthoritySelection?.connectionId,
            )
          : visibleConnections,
        ...(googleDriveAuthoritySelection
          ? { authoritySelection: googleDriveAuthoritySelection }
          : {}),
      })
    : null;
  return [
    ...mcp,
    ...(personalGitHub ? [personalGitHub] : []),
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
