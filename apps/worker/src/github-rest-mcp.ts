import type { Settings } from "@opengeni/config";
import {
  mergeToolRefs,
  type McpPersonalConnectionDelegation,
  type ResourceRef,
  type ToolRef,
} from "@opengeni/contracts";
import {
  isPersonalGitHubConnection,
  PersonalGitHubConnectionMetadata,
} from "@opengeni/contracts/personal-github";
import { personalGitHubRepositoryResources } from "@opengeni/core";
import {
  getConnectionMetadata,
  getPersonalGitHubRepositorySelectionState,
  hasAuditableGitHubInstallationAuthority,
  listGitHubInstallationAccessForWorkspace,
  resolveAcceptedConnectionUse,
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
  GITHUB_REST_TOOL_NAMES,
  GitHubRestAuthorityError,
  githubRestConnectorActionOutcome,
  GitHubRestMcpServer,
  type GitHubRestRepository,
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
  if (appRepositories.length === 0 && personalRepositories.length === 0) {
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
    configs.push(internalMcpConfig(GITHUB_REST_MCP_APP_SERVER_ID, "GitHub — OpenGeni bot"));
    toolRefs.push({ kind: "mcp", id: GITHUB_REST_MCP_APP_SERVER_ID });
    connectorBindings.push(
      ...githubConnectorBindings(GITHUB_REST_MCP_APP_SERVER_ID, appRepositories),
    );
  }

  if (personalRepositories.length > 0) {
    localMcpServers.push({
      id: GITHUB_REST_MCP_PERSONAL_SERVER_ID,
      server: new GitHubRestMcpServer({
        serverId: GITHUB_REST_MCP_PERSONAL_SERVER_ID,
        authorityKind: "personal_oauth",
        repositories: personalRepositories,
        resolveAuthority: personalAuthorityResolver(input),
      }),
    });
    configs.push(internalMcpConfig(GITHUB_REST_MCP_PERSONAL_SERVER_ID, "GitHub — My account"));
    toolRefs.push({ kind: "mcp", id: GITHUB_REST_MCP_PERSONAL_SERVER_ID });
    connectorBindings.push(
      ...githubConnectorBindings(GITHUB_REST_MCP_PERSONAL_SERVER_ID, personalRepositories),
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

function workspaceAppAuthorityResolver(
  input: {
    db: Database;
    settings: Settings;
    accountId: string;
    workspaceId: string;
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
  return async ({ toolName, repository, forceRefresh }) => {
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
  return async ({ toolName, destinationUrl, repository, forceRefresh }) => {
    const current = await validatePersonalRepository(
      input,
      repository,
      toolName === "repositories_list",
    );
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
      throw new GitHubRestAuthorityError("Personal GitHub credential is unavailable");
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
          await validatePersonalRepository(input, repository, false);
          return true;
        } catch {
          return false;
        }
      },
    };
  };
}

async function validatePersonalRepository(
  input: {
    db: Database;
    accountId: string;
    workspaceId: string;
    turn: SessionTurnForExecution;
    sessionId: string;
    attemptId: string;
  },
  repository: GitHubRestRepository,
  validateAcceptedUse: boolean,
) {
  const delegation = exactPersonalDelegation(input.turn.personalConnectionDelegations);
  if (delegation.connectionId !== repository.connectionId || !delegation.originWorkspaceId) {
    throw new GitHubRestAuthorityError("Personal GitHub delegation changed");
  }
  const snapshot = delegation.personalGitHubRepositorySelection!;
  const accepted = snapshot.repositories.find(
    (candidate) => candidate.repositoryId === repository.repositoryId,
  );
  if (
    !accepted ||
    accepted.fullName !== repository.fullName ||
    accepted.canonicalUrl !== repository.canonicalUrl ||
    accepted.ref !== repository.defaultRef ||
    accepted.access !== repository.access
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub repository exceeds accepted authority");
  }
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
  const currentRepository = current?.repositories.find(
    (candidate) => candidate.repositoryId === repository.repositoryId,
  );
  if (
    !current ||
    !currentRepository ||
    current.connectionAuthorityGeneration !== snapshot.connectionAuthorityGeneration ||
    current.selectionGeneration !== snapshot.selectionGeneration ||
    current.credentialBindingId !== snapshot.credentialBindingId ||
    current.credentialBindingId !== metadata.credentialBindingId ||
    current.providerPrincipalId !== metadata.providerPrincipalId ||
    metadata.githubUserId !== metadata.providerPrincipalId ||
    currentRepository.fullName !== accepted.fullName ||
    currentRepository.canonicalUrl !== accepted.canonicalUrl ||
    currentRepository.selectionGeneration !== accepted.selectionGeneration ||
    currentRepository.disabled ||
    !canRead(currentRepository.permissions) ||
    (accepted.access === "write" &&
      (currentRepository.selectedAccess !== "write" ||
        currentRepository.archived ||
        !canWrite(currentRepository.permissions)))
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub repository authority changed");
  }
  return { delegation, login: metadata.githubLogin };
}

function exactPersonalDelegation(
  delegations: McpPersonalConnectionDelegation[],
): McpPersonalConnectionDelegation {
  const matches = delegations.filter(
    (delegation) =>
      delegation.serverId === PERSONAL_GITHUB_DELEGATION_SERVER_ID &&
      delegation.connectionType === "github_personal",
  );
  const delegation = matches[0];
  if (
    matches.length !== 1 ||
    !delegation ||
    delegation.providerDomain !== "github.com" ||
    delegation.kind !== "oauth2" ||
    !delegation.originWorkspaceId ||
    !delegation.userDelegation ||
    !delegation.personalGitHubRepositorySelection
  ) {
    throw new GitHubRestAuthorityError("Personal GitHub delegation is unavailable");
  }
  return delegation;
}

function githubConnectorBindings(
  serverId: string,
  repositories: GitHubRestRepository[],
): AttemptConnectorActionBinding[] {
  const byName = new Map(
    repositories.map((repository) => [repository.fullName.toLowerCase(), repository]),
  );
  return GITHUB_REST_TOOL_NAMES.filter((toolName) => toolName !== "repositories_list").map(
    (toolName) => ({
      modelName: prefixedMcpToolName(serverId, toolName),
      resultOutcome: githubRestConnectorActionOutcome,
      call: (approvalId, arguments_) => {
        const args = objectRecord(arguments_);
        const repository =
          typeof args.repository === "string" ? byName.get(args.repository.toLowerCase()) : null;
        if (!repository) {
          throw new ConnectorActionBindingRejectedError(
            "GitHub action repository does not match an accepted resource",
          );
        }
        return {
          approvalId,
          connectionId: repository.connectionId,
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

function canRead(permissions: {
  pull: boolean;
  triage: boolean;
  push: boolean;
  maintain: boolean;
  admin: boolean;
}): boolean {
  return (
    permissions.pull ||
    permissions.triage ||
    permissions.push ||
    permissions.maintain ||
    permissions.admin
  );
}

function canWrite(permissions: { push: boolean; maintain: boolean; admin: boolean }): boolean {
  return permissions.push || permissions.maintain || permissions.admin;
}
