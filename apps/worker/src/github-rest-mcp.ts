import type { Settings } from "@opengeni/config";
import {
  mergeToolRefs,
  resourcesIncludeRepository,
  type McpPersonalConnectionDelegation,
  type ResourceRef,
  type ToolRef,
} from "@opengeni/contracts";
import {
  isPersonalGitHubConnection,
  PERSONAL_GITHUB_RECONNECT_MESSAGE,
  PersonalGitHubConnectionMetadata,
  personalGitHubAllRepositoriesEffectiveAccess,
  personalGitHubConnectionNeedsReconnect,
  type PersonalGitHubRepositoryAccess,
} from "@opengeni/contracts/personal-github";
import {
  livePersonalGitHubRepository,
  personalGitHubRepositoryAuthority,
  personalGitHubRepositoryResources,
} from "@opengeni/core";
import {
  getConnectionMetadata,
  getPersonalGitHubRepositorySelectionState,
  getSessionRepositoryMembershipForAuthority,
  getSessionResourcesForAuthority,
  hasAuditableGitHubInstallationAuthority,
  listGitHubInstallationAccessForWorkspace,
  resolveAcceptedConnectionUse,
  sessionRepositoryRemoved,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  type SessionTurnForExecution,
} from "@opengeni/db";
import { createGitHubAppInstallationTokenWithExpiry, githubAppBotIdentity } from "@opengeni/github";
import {
  type AttemptConnectorActionBinding,
  ConnectorActionBindingRejectedError,
  type LocalMcpServerRegistration,
  prefixedMcpToolName,
} from "@opengeni/runtime";
import {
  GITHUB_REST_API_ORIGIN,
  GITHUB_REST_MCP_APP_SERVER_ID,
  GITHUB_REST_MCP_PERSONAL_SERVER_ID,
  GITHUB_REST_READ_TOOL_NAMES,
  GITHUB_REST_REPOSITORYLESS_TOOL_NAMES,
  GITHUB_REST_TOOL_NAMES,
  GitHubRestAuthorityError,
  GitHubRestRepositoryDetachedError,
  githubRestConnectorActionOutcome,
  GitHubRestMcpServer,
  type GitHubRestRepository,
  type GitHubRestResolvedAuthority,
} from "@opengeni/runtime/github-rest-mcp";

const PERSONAL_GITHUB_DELEGATION_SERVER_ID = "github:personal";
const INTERNAL_GITHUB_MCP_TIMEOUT_MS = 20_000;

type ResolveCredential = (
  request: ResolveConnectionCredentialInput,
) => Promise<ResolveConnectionCredentialResult>;

export type GitHubRestMcpRuntime = {
  settings: Settings;
  tools: ToolRef[];
  localMcpServers: LocalMcpServerRegistration[];
  connectorBindings: AttemptConnectorActionBinding[];
};

export async function buildGitHubRestMcpForTurn(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  turn: SessionTurnForExecution;
  resources: ResourceRef[];
  tools: ToolRef[];
  resolveCredential: ResolveCredential;
  /** Worker telemetry; defaults to the console. */
  warn?: (message: string, attributes: Record<string, string>) => void;
}): Promise<GitHubRestMcpRuntime> {
  if (!input.settings.githubRestMcpEnabled) {
    return {
      settings: input.settings,
      tools: input.tools,
      localMcpServers: [],
      connectorBindings: [],
    };
  }

  const appRepositories = appRepositoryAuthority(input.resources);
  const personalRepositories = personalRepositoryAuthority(
    input.resources,
    input.turn.personalConnectionDelegations,
  );
  // All my repositories: Your GitHub tools in every chat of the person, for
  // any repository they can use, with or without attached repositories.
  const personalAllRepositories = personalAllRepositoriesDelegation(
    input.turn.personalConnectionDelegations,
  );
  if (
    personalRepositories.length === 0 &&
    input.turn.source !== "compaction" &&
    personalGitHubRepositoryResources(input.resources).length > 0
  ) {
    // A compaction checkpoint never carries personal authority. Any other
    // turn without it (for example a goal continuation with no earlier turn
    // to copy from) is worth seeing, in case a delegation was dropped.
    (input.warn ?? console.warn)(
      "Personal GitHub tools left out: the turn has no personal GitHub authority",
      {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turn.id,
        source: input.turn.source,
      },
    );
  }
  if (
    appRepositories.length === 0 &&
    personalRepositories.length === 0 &&
    !personalAllRepositories
  ) {
    return {
      settings: input.settings,
      tools: input.tools,
      localMcpServers: [],
      connectorBindings: [],
    };
  }
  const configuredIds = new Set(input.settings.mcpServers.map((server) => server.id));
  for (const id of [GITHUB_REST_MCP_APP_SERVER_ID, GITHUB_REST_MCP_PERSONAL_SERVER_ID]) {
    if (configuredIds.has(id)) {
      throw new GitHubRestAuthorityError(
        `Reserved GitHub MCP server id is already configured: ${id}`,
      );
    }
  }

  const configs: Settings["mcpServers"] = [];
  const localMcpServers: LocalMcpServerRegistration[] = [];
  const toolRefs: ToolRef[] = [];
  const connectorBindings: AttemptConnectorActionBinding[] = [];

  if (appRepositories.length > 0) {
    const appResolver = workspaceAppAuthorityResolver(input, appRepositories);
    localMcpServers.push({
      id: GITHUB_REST_MCP_APP_SERVER_ID,
      server: new GitHubRestMcpServer({
        serverId: GITHUB_REST_MCP_APP_SERVER_ID,
        authorityKind: "workspace_app",
        repositories: appRepositories,
        resolveAuthority: appResolver,
      }),
    });
    configs.push(internalMcpConfig(GITHUB_REST_MCP_APP_SERVER_ID, "GitHub — Opengeni bot"));
    toolRefs.push({ kind: "mcp", id: GITHUB_REST_MCP_APP_SERVER_ID });
    connectorBindings.push(
      ...githubConnectorBindings(GITHUB_REST_MCP_APP_SERVER_ID, appRepositories),
    );
  }

  if (personalRepositories.length > 0 || personalAllRepositories) {
    const connectionId =
      personalAllRepositories?.connectionId ?? personalRepositories[0]!.connectionId;
    localMcpServers.push({
      id: GITHUB_REST_MCP_PERSONAL_SERVER_ID,
      server: new GitHubRestMcpServer({
        serverId: GITHUB_REST_MCP_PERSONAL_SERVER_ID,
        authorityKind: "personal_oauth",
        repositories: personalRepositories,
        resolveAuthority: personalAuthorityResolver(input),
        account: {
          connectionId,
          resolveAuthority: personalAccountAuthorityResolver(input),
        },
        ...(personalAllRepositories
          ? { resolveRepository: personalRepositoryResolver(input) }
          : {}),
      }),
    });
    configs.push(internalMcpConfig(GITHUB_REST_MCP_PERSONAL_SERVER_ID, "GitHub — My account"));
    toolRefs.push({ kind: "mcp", id: GITHUB_REST_MCP_PERSONAL_SERVER_ID });
    connectorBindings.push(
      ...githubConnectorBindings(
        GITHUB_REST_MCP_PERSONAL_SERVER_ID,
        personalRepositories,
        connectionId,
        Boolean(personalAllRepositories),
      ),
    );
  }

  return {
    settings: {
      ...input.settings,
      mcpServers: [...input.settings.mcpServers, ...configs],
    },
    tools: mergeToolRefs(input.tools, toolRefs),
    localMcpServers,
    connectorBindings,
  };
}

function internalMcpConfig(id: string, name: string): Settings["mcpServers"][number] {
  return {
    id,
    name,
    url: `${GITHUB_REST_API_ORIGIN}/`,
    allowedTools: [...GITHUB_REST_TOOL_NAMES],
    timeoutMs: INTERNAL_GITHUB_MCP_TIMEOUT_MS,
    cacheToolsList: true,
  };
}

function appRepositoryAuthority(resources: ResourceRef[]): GitHubRestRepository[] {
  return resources.flatMap((resource) => {
    if (resource.kind !== "repository" || resource.connectionType === "github_personal") {
      return [];
    }
    const hasAppIdentity =
      resource.githubInstallationId !== undefined ||
      resource.installationId !== undefined ||
      resource.githubRepositoryId !== undefined;
    if (!hasAppIdentity) return [];
    if (resource.provider !== undefined && resource.provider !== "github") {
      throw new GitHubRestAuthorityError("GitHub App repository provider is invalid");
    }
    const installationId = positiveSafeInteger(
      resource.githubInstallationId ?? resource.installationId,
    );
    const repositoryId = positiveSafeInteger(resource.githubRepositoryId ?? resource.repositoryId);
    const fullName = canonicalGitHubFullName(resource.uri);
    if (!installationId || !repositoryId) {
      throw new GitHubRestAuthorityError("GitHub App repository authority is incomplete");
    }
    if (!fullName) {
      throw new GitHubRestAuthorityError("GitHub App repository URL is invalid");
    }
    return [
      {
        repositoryId: String(repositoryId),
        fullName,
        canonicalUrl: `https://github.com/${fullName}`,
        defaultRef: resource.ref,
        access: resource.access === "read" ? "read" : "write",
        authorityKind: "workspace_app" as const,
        connectionId: `github-app:${installationId}`,
      },
    ];
  });
}

function personalRepositoryAuthority(
  resources: ResourceRef[],
  delegations: McpPersonalConnectionDelegation[],
): GitHubRestRepository[] {
  const personalResources = personalGitHubRepositoryResources(resources);
  if (personalResources.length === 0) return [];
  // A turn can run without the person's GitHub authority, for example a
  // background compaction checkpoint. Its personal GitHub tools are left out
  // instead of failing the whole turn; they could not act without that
  // authority anyway. A delegation that only partly matches is malformed and
  // still fails below.
  if (!delegations.some(mayBePersonalGitHubDelegation)) return [];
  const delegation = exactPersonalDelegation(delegations);
  const snapshot = delegation.personalGitHubRepositorySelection!;
  const acceptedById = new Map(
    snapshot.repositories.map((repository) => [repository.repositoryId, repository]),
  );
  return personalResources.map((resource) => {
    const accepted = acceptedById.get(resource.repositoryId);
    const fullName = canonicalGitHubFullName(resource.uri);
    if (
      !accepted ||
      !fullName ||
      accepted.fullName !== fullName ||
      accepted.canonicalUrl !== resource.uri ||
      accepted.ref !== resource.ref ||
      accepted.access !== resource.access
    ) {
      throw new GitHubRestAuthorityError(
        "Personal GitHub repository does not match the accepted selection",
      );
    }
    return {
      repositoryId: resource.repositoryId,
      fullName,
      canonicalUrl: resource.uri,
      defaultRef: resource.ref,
      access: resource.access,
      authorityKind: "personal_oauth" as const,
      connectionId: delegation.connectionId,
    };
  });
}

/** The turn's Your GitHub delegation when it carries All my repositories. */
function personalAllRepositoriesDelegation(
  delegations: McpPersonalConnectionDelegation[],
): McpPersonalConnectionDelegation | null {
  if (!delegations.some(mayBePersonalGitHubDelegation)) return null;
  try {
    const delegation = exactPersonalDelegation(delegations);
    return delegation.personalGitHubRepositorySelection?.allRepositoriesAccess ? delegation : null;
  } catch {
    return null;
  }
}

/**
 * Session membership is live authority: a repository removed from the chat
 * stops working on the next call, even for a turn, child or goal
 * continuation that captured an older resource snapshot.
 */
async function assertRepositoryStillAttached(
  input: { db: Database; workspaceId: string; sessionId: string },
  repository: GitHubRestRepository,
): Promise<void> {
  const resources = await getSessionResourcesForAuthority(
    input.db,
    input.workspaceId,
    input.sessionId,
  );
  if (!resources || !resourcesIncludeRepository(resources, repository.canonicalUrl)) {
    throw new GitHubRestRepositoryDetachedError(
      `${repository.fullName} was removed from this chat`,
    );
  }
}

/** All my repositories: a repository a person removed from the chat stays refused. */
async function assertRepositoryNotRemoved(
  input: { db: Database; workspaceId: string; sessionId: string },
  repository: GitHubRestRepository,
): Promise<void> {
  const membership = await getSessionRepositoryMembershipForAuthority(
    input.db,
    input.workspaceId,
    input.sessionId,
  );
  if (
    !membership ||
    sessionRepositoryRemoved(membership, [
      repository.canonicalUrl,
      `https://github.com/${repository.fullName}`,
    ])
  ) {
    throw new GitHubRestRepositoryDetachedError(
      `${repository.fullName} was removed from this chat`,
    );
  }
}

function workspaceAppAuthorityResolver(
  input: {
    db: Database;
    settings: Settings;
    accountId: string;
    workspaceId: string;
    sessionId: string;
  },
  repositories: GitHubRestRepository[],
): ConstructorParameters<typeof GitHubRestMcpServer>[0]["resolveAuthority"] {
  const installationByRepository = new Map(
    repositories.map((repository) => [
      repositoryKey(repository),
      Number(repository.connectionId.slice("github-app:".length)),
    ]),
  );
  const tokenCache = new Map<string, { token: string; expiresAt: number }>();
  const validate = async (repository: GitHubRestRepository): Promise<number> => {
    const installationId = installationByRepository.get(repositoryKey(repository));
    const repositoryId = Number(repository.repositoryId);
    if (!installationId || !Number.isSafeInteger(repositoryId)) {
      throw new GitHubRestAuthorityError("GitHub App repository binding changed");
    }
    await assertRepositoryStillAttached(input, repository);
    const installations = await listGitHubInstallationAccessForWorkspace(
      input.db,
      input.workspaceId,
    );
    const installation = installations.find(
      (candidate) => candidate.installationId === installationId,
    );
    if (
      !installation ||
      installation.accountId !== input.accountId ||
      !hasAuditableGitHubInstallationAuthority(installation) ||
      !installation.repositoryIds.includes(repositoryId)
    ) {
      throw new GitHubRestAuthorityError("GitHub App repository authority is no longer current");
    }
    return installationId;
  };
  return async ({ toolName, repository, forceRefresh }): Promise<GitHubRestResolvedAuthority> => {
    const installationId = await validate(repository);
    const repositoryId = Number(repository.repositoryId);
    const identity = githubAppBotIdentity(input.settings);
    if (!identity) throw new GitHubRestAuthorityError("GitHub App identity is unavailable");
    if (toolName === "repositories_list") {
      return {
        headers: {},
        connectionId: repository.connectionId,
        actor: { kind: "workspace_app", login: identity.name },
        authorizeProviderRequest: async () => {
          try {
            await validate(repository);
            return true;
          } catch {
            return false;
          }
        },
      };
    }
    const cacheKey = repositoryKey(repository);
    let cached = tokenCache.get(cacheKey);
    if (forceRefresh || !cached || cached.expiresAt <= Date.now() + 60_000) {
      const minted = await createGitHubAppInstallationTokenWithExpiry(input.settings, {
        installationId,
        repositoryIds: [repositoryId],
      });
      const parsedExpiry = minted.expiresAt ? Date.parse(minted.expiresAt) : Number.NaN;
      cached = {
        token: minted.token,
        // An absent or malformed expiry must shorten the cache lifetime rather
        // than turning NaN into an indefinitely reusable credential.
        expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 5 * 60_000,
      };
      tokenCache.set(cacheKey, cached);
    }
    return {
      headers: { authorization: `Bearer ${cached.token}` },
      connectionId: repository.connectionId,
      actor: { kind: "workspace_app", login: identity.name },
      authorizeProviderRequest: async () => {
        try {
          await validate(repository);
          return true;
        } catch {
          return false;
        }
      },
    };
  };
}

function personalAuthorityResolver(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  turn: SessionTurnForExecution;
  resolveCredential: ResolveCredential;
}): ConstructorParameters<typeof GitHubRestMcpServer>[0]["resolveAuthority"] {
  return async ({
    toolName,
    destinationUrl,
    repository,
    forceRefresh,
  }): Promise<GitHubRestResolvedAuthority> => {
    // A grant GitHub refused bumps the connection out of `active`; tell the
    // agent the person must reconnect instead of a generic authority error.
    const reconnectOr = (error: GitHubRestAuthorityError) =>
      personalReconnectOr(error, () => personalConnectionNeedsReconnect(input));
    let current: Awaited<ReturnType<typeof validatePersonalRepository>>;
    try {
      current = await validatePersonalRepository(
        input,
        repository,
        toolName === "repositories_list",
      );
    } catch (error) {
      throw error instanceof GitHubRestAuthorityError ? await reconnectOr(error) : error;
    }
    if (toolName === "repositories_list") {
      return {
        headers: {},
        connectionId: repository.connectionId,
        actor: { kind: "personal_oauth", login: current.login },
        authorizeProviderRequest: async () => {
          try {
            await validatePersonalRepository(input, repository, true);
            return true;
          } catch {
            return false;
          }
        },
      };
    }
    const resolution = await input.resolveCredential({
      workspaceId: input.workspaceId,
      subjectId: current.delegation.ownerSubjectId,
      serverId: PERSONAL_GITHUB_DELEGATION_SERVER_ID,
      toolName,
      connectionRef: {
        connectionId: current.delegation.connectionId,
        provider: "github",
        providerDomain: "github.com",
        kind: "oauth2",
        scopes: ["repo"],
        subjectScope: "subject",
      },
      destinationUrl,
      credentialTarget: "http_api",
      forceRefresh,
    });
    if (resolution.status !== "ok" || resolution.connectionId !== repository.connectionId) {
      throw await reconnectOr(
        new GitHubRestAuthorityError("Personal GitHub credential is unavailable"),
      );
    }
    return {
      headers: githubAuthorizationHeaders(resolution.headers),
      connectionId: resolution.connectionId,
      actor: { kind: "personal_oauth", login: current.login },
      authorizeProviderRequest: async () => {
        if (resolution.authorizeProviderRequest && !(await resolution.authorizeProviderRequest())) {
          return false;
        }
        try {
          await validatePersonalRepository(
            input,
            repository,
            false,
            githubGetWith(githubAuthorizationHeaders(resolution.headers)),
          );
          return true;
        } catch {
          return false;
        }
      },
    };
  };
}

/**
 * A generic personal authority failure becomes "reconnect" when GitHub refused
 * the person's stored grant; any other failure keeps its own message.
 */
export async function personalReconnectOr(
  error: GitHubRestAuthorityError,
  needsReconnect: () => Promise<boolean>,
): Promise<GitHubRestAuthorityError> {
  return (await needsReconnect().catch(() => false))
    ? new GitHubRestAuthorityError(PERSONAL_GITHUB_RECONNECT_MESSAGE)
    : error;
}

/** Whether the turn's frozen personal GitHub connection now needs reconnecting. */
export async function personalConnectionNeedsReconnect(
  input: {
    db: Database;
    accountId: string;
    turn: Pick<SessionTurnForExecution, "personalConnectionDelegations">;
  },
  readConnection: typeof getConnectionMetadata = getConnectionMetadata,
): Promise<boolean> {
  try {
    const delegation = exactPersonalDelegation(input.turn.personalConnectionDelegations);
    if (!delegation.originWorkspaceId) return false;
    const connection = await readConnection(
      input.db,
      delegation.originWorkspaceId,
      delegation.connectionId,
      delegation.ownerSubjectId,
    );
    return (
      connection !== null &&
      connection.accountId === input.accountId &&
      connection.subjectId === delegation.ownerSubjectId &&
      personalGitHubConnectionNeedsReconnect(connection)
    );
  } catch {
    return false;
  }
}

type PersonalValidationInput = {
  db: Database;
  accountId: string;
  workspaceId: string;
  turn: SessionTurnForExecution;
  sessionId: string;
  attemptId: string;
};

/**
 * The turn's Your GitHub delegation, connection and current choice, still
 * matching what the turn accepted. Shared by repository and account reads.
 */
async function validatePersonalConnection(
  input: PersonalValidationInput,
  connectionId: string,
  validateAcceptedUse: boolean,
) {
  const delegation = exactPersonalDelegation(input.turn.personalConnectionDelegations);
  if (delegation.connectionId !== connectionId || !delegation.originWorkspaceId) {
    throw new GitHubRestAuthorityError("Personal GitHub delegation changed");
  }
  const snapshot = delegation.personalGitHubRepositorySelection!;
  const acceptedUse = validateAcceptedUse
    ? await resolveAcceptedConnectionUse(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turn.id,
        attemptId: input.attemptId,
        executionGeneration: input.turn.executionGeneration,
        physicalRequestId: crypto.randomUUID(),
        usePhase: "credential_resolution",
        serverId: PERSONAL_GITHUB_DELEGATION_SERVER_ID,
        connectionId: delegation.connectionId,
        providerDomain: "github.com",
        connectionKind: "oauth2",
        subjectScope: "subject",
        ownerSubjectId: delegation.ownerSubjectId,
      })
    : null;
  if (
    acceptedUse &&
    (acceptedUse.status !== "authorized" ||
      acceptedUse.originWorkspaceId !== delegation.originWorkspaceId ||
      acceptedUse.attribution.connectionId !== delegation.connectionId ||
      acceptedUse.attribution.connectionGeneration !== snapshot.connectionAuthorityGeneration ||
      acceptedUse.attribution.ownerSubjectId !== delegation.ownerSubjectId)
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub connection authority changed");
  }
  const connection = await getConnectionMetadata(
    input.db,
    delegation.originWorkspaceId,
    delegation.connectionId,
    delegation.ownerSubjectId,
  );
  if (
    !connection ||
    connection.accountId !== input.accountId ||
    connection.workspaceId !== delegation.originWorkspaceId ||
    connection.subjectId !== delegation.ownerSubjectId ||
    connection.status !== "active" ||
    connection.grantedScopes.length !== 1 ||
    connection.grantedScopes[0] !== "repo" ||
    !isPersonalGitHubConnection(connection)
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub connection is unavailable");
  }
  const metadata = PersonalGitHubConnectionMetadata.parse(connection.metadata);
  const current = await getPersonalGitHubRepositorySelectionState(input.db, {
    accountId: input.accountId,
    originWorkspaceId: delegation.originWorkspaceId,
    subjectId: delegation.ownerSubjectId,
    connectionId: delegation.connectionId,
  });
  if (
    !current ||
    current.connectionAuthorityGeneration !== snapshot.connectionAuthorityGeneration ||
    current.credentialBindingId !== snapshot.credentialBindingId ||
    current.credentialBindingId !== metadata.credentialBindingId ||
    current.providerPrincipalId !== metadata.providerPrincipalId ||
    metadata.githubUserId !== metadata.providerPrincipalId
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub connection authority changed");
  }
  return { delegation, snapshot, metadata, current };
}

/**
 * May this turn use `repository` as the person now? The shared Your GitHub
 * allowlist decision; in All my repositories, GitHub is asked too (briefly
 * cached) whenever a credential is at hand (`githubGet`).
 */
async function validatePersonalRepository(
  input: PersonalValidationInput,
  repository: GitHubRestRepository,
  validateAcceptedUse: boolean,
  githubGet?: (url: URL) => Promise<Response>,
) {
  const { delegation, snapshot, metadata, current } = await validatePersonalConnection(
    input,
    repository.connectionId,
    validateAcceptedUse,
  );
  const accepted = snapshot.repositories.find(
    (candidate) => candidate.repositoryId === repository.repositoryId,
  );
  if (
    accepted
      ? accepted.fullName !== repository.fullName ||
        accepted.canonicalUrl !== repository.canonicalUrl ||
        accepted.ref !== repository.defaultRef ||
        accepted.access !== repository.access
      : !snapshot.allRepositoriesAccess
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub repository exceeds accepted authority");
  }
  // Without All my repositories the chat's list is live authority too; with
  // it, a repository a person removed from the chat stays refused.
  if (snapshot.allRepositoriesAccess) await assertRepositoryNotRemoved(input, repository);
  else await assertRepositoryStillAttached(input, repository);
  const decision = personalGitHubRepositoryAuthority({
    current,
    metadata,
    accepted: snapshot,
    repository: { repositoryId: repository.repositoryId, fullName: repository.fullName },
    access: repository.access,
  });
  if (
    !decision.allowed ||
    (decision.mode === "selected" &&
      (!accepted ||
        decision.selected.fullName !== accepted.fullName ||
        decision.selected.canonicalUrl !== accepted.canonicalUrl ||
        decision.selected.selectionGeneration !== accepted.selectionGeneration))
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub repository authority changed");
  }
  if (decision.mode === "all" && githubGet) {
    let live: Awaited<ReturnType<typeof livePersonalGitHubRepository>>;
    try {
      live = await livePersonalGitHubRepository({
        cacheScope: personalCacheScope(delegation.connectionId, current),
        repository: { repositoryId: repository.repositoryId },
        githubGet,
      });
    } catch {
      throw new GitHubRestAuthorityError("GitHub is temporarily unavailable. Try again.");
    }
    const access = live
      ? personalGitHubAllRepositoriesEffectiveAccess(decision.allRepositoriesAccess, live)
      : null;
    if (
      !live ||
      live.fullName.toLowerCase() !== repository.fullName.toLowerCase() ||
      !access ||
      (repository.access === "write" && access !== "write")
    ) {
      throw new GitHubRestAuthorityError(
        `${repository.fullName} is not available to the connected person at ${repository.access} access`,
      );
    }
  }
  return { delegation, login: metadata.githubLogin };
}

function personalCacheScope(
  connectionId: string,
  current: { connectionAuthorityGeneration: number; credentialBindingId: string },
): string {
  return `${connectionId}|${current.connectionAuthorityGeneration}|${current.credentialBindingId}`;
}

function githubGetWith(headers: Record<string, string>) {
  return async (url: URL): Promise<Response> => {
    if (url.origin !== GITHUB_REST_API_ORIGIN) {
      throw new GitHubRestAuthorityError("GitHub REST destination binding mismatch");
    }
    return await fetch(url, {
      method: "GET",
      // A renamed repository answers with a same-origin redirect; the shared
      // lookup follows it only to api.github.com.
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "OpenGeni-GitHub-Bridge/1",
        ...headers,
      },
      signal: AbortSignal.timeout(INTERNAL_GITHUB_MCP_TIMEOUT_MS),
    });
  };
}

async function resolvePersonalCredential(
  input: PersonalValidationInput & { resolveCredential: ResolveCredential },
  delegation: McpPersonalConnectionDelegation,
  toolName: string,
  destinationUrl: string,
  forceRefresh: boolean,
) {
  const resolution = await input.resolveCredential({
    workspaceId: input.workspaceId,
    subjectId: delegation.ownerSubjectId,
    serverId: PERSONAL_GITHUB_DELEGATION_SERVER_ID,
    toolName,
    connectionRef: {
      connectionId: delegation.connectionId,
      provider: "github",
      providerDomain: "github.com",
      kind: "oauth2",
      scopes: ["repo"],
      subjectScope: "subject",
    },
    destinationUrl,
    credentialTarget: "http_api",
    forceRefresh,
  });
  if (resolution.status !== "ok" || resolution.connectionId !== delegation.connectionId) {
    throw await personalReconnectOr(
      new GitHubRestAuthorityError("Personal GitHub credential is unavailable"),
      () => personalConnectionNeedsReconnect(input),
    );
  }
  return { resolution, headers: githubAuthorizationHeaders(resolution.headers) };
}

/**
 * All my repositories: turn `owner/name` into a repository this turn may use,
 * as GitHub describes it now and at the access it gets.
 */
function personalRepositoryResolver(
  input: PersonalValidationInput & { resolveCredential: ResolveCredential },
): (fullName: string) => Promise<GitHubRestRepository | null> {
  return async (fullName) => {
    const reconnectOr = (error: GitHubRestAuthorityError) =>
      personalReconnectOr(error, () => personalConnectionNeedsReconnect(input));
    try {
      const delegation = exactPersonalDelegation(input.turn.personalConnectionDelegations);
      const { snapshot, current, metadata } = await validatePersonalConnection(
        input,
        delegation.connectionId,
        true,
      );
      const acceptedAccess = snapshot.allRepositoriesAccess;
      const decision = personalGitHubRepositoryAuthority({
        current,
        metadata,
        accepted: snapshot,
        repository: { fullName },
        access: "read",
      });
      if (!acceptedAccess || !decision.allowed || decision.mode !== "all") {
        throw new GitHubRestAuthorityError(
          "All my repositories changed for this GitHub account. Start a new message to use the new choice.",
        );
      }
      const currentAccess = decision.allRepositoriesAccess;
      const destination = `${GITHUB_REST_API_ORIGIN}/repos/${fullName}`;
      const { headers } = await resolvePersonalCredential(
        input,
        delegation,
        "repository_get",
        destination,
        false,
      );
      const live = await livePersonalGitHubRepository({
        cacheScope: personalCacheScope(delegation.connectionId, current),
        repository: { fullName },
        githubGet: githubGetWith(headers),
      }).catch(() => {
        throw new GitHubRestAuthorityError("GitHub is temporarily unavailable. Try again.");
      });
      if (!live) return null;
      const limit: PersonalGitHubRepositoryAccess =
        acceptedAccess === "write" && currentAccess === "write" ? "write" : "read";
      const access = personalGitHubAllRepositoriesEffectiveAccess(limit, live);
      if (!access) return null;
      return {
        repositoryId: live.repositoryId,
        fullName: live.fullName,
        canonicalUrl: live.canonicalUrl,
        defaultRef: live.defaultBranch,
        access,
        authorityKind: "personal_oauth",
        connectionId: delegation.connectionId,
      };
    } catch (error) {
      throw error instanceof GitHubRestAuthorityError ? await reconnectOr(error) : error;
    }
  };
}

/** Account-level reads (organizations, an owner's repositories) as the person. */
function personalAccountAuthorityResolver(
  input: PersonalValidationInput & { resolveCredential: ResolveCredential },
): NonNullable<
  ConstructorParameters<typeof GitHubRestMcpServer>[0]["account"]
>["resolveAuthority"] {
  return async ({ toolName, destinationUrl, forceRefresh }) => {
    const reconnectOr = (error: GitHubRestAuthorityError) =>
      personalReconnectOr(error, () => personalConnectionNeedsReconnect(input));
    let current: Awaited<ReturnType<typeof validatePersonalConnection>>;
    try {
      const delegation = exactPersonalDelegation(input.turn.personalConnectionDelegations);
      current = await validatePersonalConnection(input, delegation.connectionId, true);
    } catch (error) {
      throw error instanceof GitHubRestAuthorityError ? await reconnectOr(error) : error;
    }
    const { resolution, headers } = await resolvePersonalCredential(
      input,
      current.delegation,
      toolName,
      destinationUrl,
      forceRefresh,
    );
    return {
      headers,
      connectionId: current.delegation.connectionId,
      actor: { kind: "personal_oauth", login: current.metadata.githubLogin },
      authorizeProviderRequest: async () => {
        if (resolution.authorizeProviderRequest && !(await resolution.authorizeProviderRequest())) {
          return false;
        }
        try {
          await validatePersonalConnection(input, current.delegation.connectionId, false);
          return true;
        } catch {
          return false;
        }
      },
    };
  };
}

function exactPersonalDelegation(
  delegations: McpPersonalConnectionDelegation[],
): McpPersonalConnectionDelegation {
  const matches = delegations.filter(isPersonalGitHubDelegation);
  const delegation = matches[0];
  if (
    matches.length !== 1 ||
    !delegation ||
    delegation.providerDomain !== "github.com" ||
    delegation.kind !== "oauth2" ||
    !delegation.originWorkspaceId ||
    !delegation.personalGitHubRepositorySelection
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub delegation is unavailable");
  }
  return delegation;
}

function isPersonalGitHubDelegation(delegation: McpPersonalConnectionDelegation): boolean {
  return (
    delegation.serverId === PERSONAL_GITHUB_DELEGATION_SERVER_ID &&
    delegation.connectionType === "github_personal"
  );
}

function mayBePersonalGitHubDelegation(delegation: McpPersonalConnectionDelegation): boolean {
  return (
    delegation.serverId === PERSONAL_GITHUB_DELEGATION_SERVER_ID ||
    delegation.connectionType === "github_personal"
  );
}

function githubConnectorBindings(
  serverId: string,
  repositories: GitHubRestRepository[],
  /** All my repositories: any repository name binds to this connection; the server checks it. */
  openConnectionId?: string,
  openRepositories = false,
): AttemptConnectorActionBinding[] {
  const byName = new Map(
    repositories.map((repository) => [repository.fullName.toLowerCase(), repository]),
  );
  const repositoryless = new Set<string>(GITHUB_REST_REPOSITORYLESS_TOOL_NAMES);
  return GITHUB_REST_TOOL_NAMES.filter((toolName) => !repositoryless.has(toolName)).map(
    (toolName) => ({
      modelName: prefixedMcpToolName(serverId, toolName),
      resultOutcome: githubRestConnectorActionOutcome,
      call: (approvalId, arguments_) => {
        const args = objectRecord(arguments_);
        const repository =
          typeof args.repository === "string" ? byName.get(args.repository.toLowerCase()) : null;
        const connectionId =
          repository?.connectionId ??
          (openRepositories && typeof args.repository === "string" ? openConnectionId : undefined);
        if (!connectionId) {
          throw new ConnectorActionBindingRejectedError(
            "GitHub action repository does not match an accepted resource",
          );
        }
        return {
          approvalId,
          connectionId,
          serverId,
          toolName,
          arguments: arguments_,
          ...(GITHUB_REST_READ_TOOL_NAMES.includes(
            toolName as (typeof GITHUB_REST_READ_TOOL_NAMES)[number],
          )
            ? {}
            : { approvalMode: "connector_write" as const }),
        };
      },
    }),
  );
}

function canonicalGitHubFullName(uri: string): string | null {
  try {
    const url = new URL(uri);
    const clonePath = url.pathname.replace(/^\/+|\/+$/gu, "");
    const path = clonePath.endsWith(".git") ? clonePath.slice(0, -4) : clonePath;
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(path)
    ) {
      return null;
    }
    return path;
  } catch {
    return null;
  }
}

function positiveSafeInteger(value: unknown): number | null {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function repositoryKey(repository: GitHubRestRepository): string {
  return `${repository.connectionId}\0${repository.repositoryId}`;
}

function githubAuthorizationHeaders(headers: Record<string, string>): Record<string, string> {
  const authorization = new Headers(headers).get("authorization");
  if (
    !authorization ||
    !/^Bearer [^\u0000-\u0020\u007f]+$/u.test(authorization) ||
    authorization.length > 16_384
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub authorization header is unavailable");
  }
  return { authorization };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
