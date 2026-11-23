import type { Settings } from "@opengeni/config";
import type { AccessGrant, McpPersonalConnectionDelegation } from "@opengeni/contracts";
import {
  isPersonalGitHubConnection,
  PERSONAL_GITHUB_RECONNECT_MESSAGE,
  PersonalGitHubConnectionMetadata,
  personalGitHubAllRepositoriesEffectiveAccess,
  personalGitHubConnectionNeedsReconnect,
  type PersonalGitHubRepositoryAccess,
} from "@opengeni/contracts/personal-github";
import {
  freezePersonalConnectionDelegations,
  listOwnConnectionMetadata,
  livePersonalGitHubRepository,
  personalConnectionDelegationSourceForGrant,
} from "@opengeni/core";
import {
  getConnectionMetadata,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "@opengeni/db";
import type { LocalMcpServerRegistration } from "@opengeni/runtime";
import {
  GITHUB_REST_API_ORIGIN,
  GITHUB_REST_MCP_PERSONAL_SERVER_ID,
  GitHubRestAuthorityError,
  GitHubRestMcpServer,
  githubRestBearerHeaders,
  githubRestGetter,
  githubRestInternalServerConfig,
  personalGitHubRestCacheScope,
  type GitHubRestRepository,
  type GitHubRestResolvedAuthority,
} from "@opengeni/runtime/github-rest-mcp";

/**
 * Your GitHub tools (`github_personal__*`) for a person using Opengeni
 * directly, outside a chat turn: an app they view, or a tool call they make
 * through the workspace tool gateway. A turn gets the same tools from the
 * worker with its accepted delegation (`apps/worker/src/github-rest-mcp.ts`).
 *
 * Only the caller's own connection with All my repositories, exactly as a new
 * chat of theirs would receive it (`freezePersonalConnectionDelegations`), and
 * only for a person (never a service, key, delegated bearer or agent attempt).
 * Every call re-reads that authority, so disconnecting, reconnecting as
 * someone else or switching All my repositories off stops it at once.
 */
export const PERSONAL_GITHUB_TOOLS_SERVER_ID = GITHUB_REST_MCP_PERSONAL_SERVER_ID;

/** The serverId personal GitHub credentials are requested under (as in a turn). */
const PERSONAL_GITHUB_CREDENTIAL_SERVER_ID = "github:personal";

export type PersonalGitHubToolsAuthority = Readonly<{
  subjectId: string;
  connectionId: string;
  originWorkspaceId: string;
  login: string;
  credentialBindingId: string;
  connectionAuthorityGeneration: number;
  /** All my repositories access: the most any repository gets. */
  access: PersonalGitHubRepositoryAccess;
}>;

type GitHubSettings = Pick<
  Settings,
  "githubRestMcpEnabled" | "githubPersonalOauthEnabled" | "githubPersonalAllRepositoriesEnabled"
>;

/** The deployment offers Your GitHub tools outside chats. */
export function personalGitHubToolsOffered(settings: Partial<GitHubSettings>): boolean {
  return (
    settings.githubRestMcpEnabled === true &&
    settings.githubPersonalOauthEnabled === true &&
    settings.githubPersonalAllRepositoriesEnabled === true
  );
}

/** The caller's own Your GitHub with All my repositories, or null when they have none. */
export async function readPersonalGitHubToolsAuthority(
  db: Database,
  settings: Partial<GitHubSettings>,
  grant: AccessGrant,
): Promise<PersonalGitHubToolsAuthority | null> {
  if (!personalGitHubToolsOffered(settings) || grant.principalKind === "api_key") return null;
  const source = personalConnectionDelegationSourceForGrant(grant);
  if (source.kind !== "subject") return null;
  const delegations = await freezePersonalConnectionDelegations({
    db,
    workspaceId: grant.workspaceId,
    settings: {
      mcpServers: [],
      githubPersonalOauthEnabled: true,
      githubPersonalAllRepositoriesEnabled: true,
    },
    tools: [],
    source,
  });
  const delegation = delegations.find(isAllRepositoriesDelegation);
  const selection = delegation?.personalGitHubRepositorySelection;
  if (!delegation?.originWorkspaceId || !selection?.allRepositoriesAccess) return null;
  const connection = await getConnectionMetadata(
    db,
    delegation.originWorkspaceId,
    delegation.connectionId,
    source.subjectId,
  );
  if (
    !connection ||
    connection.subjectId !== source.subjectId ||
    connection.status !== "active" ||
    !isPersonalGitHubConnection(connection)
  )
    return null;
  const metadata = PersonalGitHubConnectionMetadata.safeParse(connection.metadata);
  if (!metadata.success || metadata.data.credentialBindingId !== selection.credentialBindingId)
    return null;
  return {
    subjectId: source.subjectId,
    connectionId: delegation.connectionId,
    originWorkspaceId: delegation.originWorkspaceId,
    login: metadata.data.githubLogin,
    credentialBindingId: selection.credentialBindingId,
    connectionAuthorityGeneration: selection.connectionAuthorityGeneration,
    access: selection.allRepositoriesAccess,
  };
}

/**
 * The caller's own Your GitHub connection that GitHub stopped accepting, so
 * they are offered Reconnect for it rather than Connect for a new one.
 */
export async function readPersonalGitHubReconnectAccount(
  db: Database,
  settings: Partial<GitHubSettings>,
  grant: AccessGrant,
): Promise<{ connectionId: string; login: string | null } | null> {
  if (!personalGitHubToolsOffered(settings) || grant.principalKind === "api_key") return null;
  const source = personalConnectionDelegationSourceForGrant(grant);
  if (source.kind !== "subject") return null;
  const connections = await listOwnConnectionMetadata(db, {
    accountId: source.accountId,
    workspaceId: grant.workspaceId,
    subjectId: source.subjectId,
    reach: "anywhere",
    includeInactive: true,
  });
  const stale = connections.find(personalGitHubConnectionNeedsReconnect);
  if (!stale) return null;
  const login = stale.metadata.githubLogin;
  return { connectionId: stale.id, login: typeof login === "string" ? login : null };
}

function isAllRepositoriesDelegation(delegation: McpPersonalConnectionDelegation): boolean {
  return (
    delegation.connectionType === "github_personal" &&
    delegation.providerDomain === "github.com" &&
    delegation.kind === "oauth2" &&
    delegation.personalGitHubRepositorySelection?.allRepositoriesAccess !== undefined
  );
}

/** The gateway's configuration entry for the tools (no remote server is contacted). */
export function personalGitHubToolsServerConfig(): Settings["mcpServers"][number] {
  return githubRestInternalServerConfig(PERSONAL_GITHUB_TOOLS_SERVER_ID, "GitHub — My account");
}

/** `settings` with the Your GitHub server added when the caller has it. */
export function withPersonalGitHubToolsServer<T extends Pick<Settings, "mcpServers">>(
  settings: T,
  authority: PersonalGitHubToolsAuthority | null,
): T {
  // The id is reserved for these tools; a configured server never shares it.
  if (!authority || settings.mcpServers.some((s) => s.id === PERSONAL_GITHUB_TOOLS_SERVER_ID))
    return settings;
  return { ...settings, mcpServers: [...settings.mcpServers, personalGitHubToolsServerConfig()] };
}

/** Same person, same connection and the same grant of it. */
export function samePersonalGitHubToolsAuthority(
  left: PersonalGitHubToolsAuthority | null,
  right: PersonalGitHubToolsAuthority | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.subjectId === right.subjectId &&
    left.connectionId === right.connectionId &&
    left.originWorkspaceId === right.originWorkspaceId &&
    left.credentialBindingId === right.credentialBindingId &&
    left.connectionAuthorityGeneration === right.connectionAuthorityGeneration
  );
}

type ResolveCredential = (
  input: ResolveConnectionCredentialInput,
) => Promise<ResolveConnectionCredentialResult>;

/**
 * The Your GitHub tools server for one caller. `resolveCredential` is the
 * gateway's own (live-fenced) connection resolver.
 */
export function buildPersonalGitHubToolsServer(input: {
  db: Database;
  settings: Partial<GitHubSettings>;
  grant: AccessGrant;
  authority: PersonalGitHubToolsAuthority;
  resolveCredential: ResolveCredential;
  /** Test seams. */
  readAuthority?: typeof readPersonalGitHubToolsAuthority;
  fetchImpl?: typeof fetch;
}): LocalMcpServerRegistration {
  const { authority } = input;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const readAuthority = input.readAuthority ?? readPersonalGitHubToolsAuthority;
  const unavailable = async (message: string) => {
    const connection = await getConnectionMetadata(
      input.db,
      authority.originWorkspaceId,
      authority.connectionId,
      authority.subjectId,
    ).catch(() => null);
    return new GitHubRestAuthorityError(
      connection && personalGitHubConnectionNeedsReconnect(connection)
        ? PERSONAL_GITHUB_RECONNECT_MESSAGE
        : message,
    );
  };
  /** The caller's authority now; it must still be the one this server was built for. */
  const current = async (): Promise<PersonalGitHubToolsAuthority> => {
    const live = await readAuthority(input.db, input.settings, input.grant);
    if (!live || !samePersonalGitHubToolsAuthority(live, authority))
      throw await unavailable("Your GitHub with All my repositories is no longer available here.");
    return live;
  };
  const credential = async (
    live: PersonalGitHubToolsAuthority,
    toolName: string,
    destinationUrl: string,
    forceRefresh: boolean,
  ) => {
    const resolution = await input.resolveCredential({
      workspaceId: live.originWorkspaceId,
      subjectId: live.subjectId,
      serverId: PERSONAL_GITHUB_CREDENTIAL_SERVER_ID,
      toolName,
      connectionRef: {
        connectionId: live.connectionId,
        provider: "github",
        providerDomain: "github.com",
        kind: "oauth2",
        scopes: ["repo"],
        subjectScope: "subject",
      },
      destinationUrl,
      credentialTarget: "http_api",
      expectedAuthorityGeneration: live.connectionAuthorityGeneration,
      forceRefresh,
    });
    if (resolution.status !== "ok" || resolution.connectionId !== live.connectionId)
      throw await unavailable("Your GitHub credential is unavailable.");
    return { resolution, headers: githubRestBearerHeaders(resolution.headers) };
  };
  /** The repository as GitHub describes it now, at the access the caller gets on it. */
  const liveRepository = async (
    live: PersonalGitHubToolsAuthority,
    headers: Record<string, string>,
    lookup: { repositoryId: string } | { fullName: string },
  ): Promise<GitHubRestRepository | null> => {
    const repository = await livePersonalGitHubRepository({
      cacheScope: personalGitHubRestCacheScope(live.connectionId, live),
      repository: lookup,
      githubGet: githubRestGetter(headers, fetchImpl),
    }).catch(() => {
      throw new GitHubRestAuthorityError("GitHub is temporarily unavailable. Try again.");
    });
    const access = repository
      ? personalGitHubAllRepositoriesEffectiveAccess(live.access, repository)
      : null;
    if (!repository || !access) return null;
    return {
      repositoryId: repository.repositoryId,
      fullName: repository.fullName,
      canonicalUrl: repository.canonicalUrl,
      defaultRef: repository.defaultBranch,
      access,
      authorityKind: "personal_oauth",
      connectionId: live.connectionId,
    };
  };
  /**
   * Checked again before each request GitHub receives. The first one follows
   * the authority read that resolved this credential, so it skips that read.
   */
  const authorizeEach = (
    resolution: Extract<ResolveConnectionCredentialResult, { status: "ok" }>,
    check: (reread: boolean) => Promise<void>,
  ) => {
    let requests = 0;
    return async () => {
      if (resolution.authorizeProviderRequest && !(await resolution.authorizeProviderRequest()))
        return false;
      try {
        await check(requests++ > 0);
        return true;
      } catch {
        return false;
      }
    };
  };
  const resolved = (
    live: PersonalGitHubToolsAuthority,
    headers: Record<string, string>,
    authorizeProviderRequest: () => Promise<boolean>,
  ): GitHubRestResolvedAuthority => ({
    headers,
    connectionId: live.connectionId,
    actor: { kind: "personal_oauth", login: live.login },
    authorizeProviderRequest,
  });

  const server = new GitHubRestMcpServer({
    serverId: PERSONAL_GITHUB_TOOLS_SERVER_ID,
    authorityKind: "personal_oauth",
    repositories: [],
    fetchImpl,
    resolveRepository: async (fullName) => {
      const live = await current();
      const { headers } = await credential(
        live,
        "repository_get",
        `${GITHUB_REST_API_ORIGIN}/repos/${fullName}`,
        false,
      );
      return await liveRepository(live, headers, { fullName });
    },
    resolveAuthority: async ({ toolName, destinationUrl, repository, write, forceRefresh }) => {
      const live = await current();
      const { resolution, headers } = await credential(
        live,
        toolName,
        destinationUrl,
        forceRefresh,
      );
      const check = async (reread: boolean) => {
        const now = reread ? await current() : live;
        const repositoryNow = await liveRepository(now, headers, {
          repositoryId: repository.repositoryId,
        });
        if (
          !repositoryNow ||
          repositoryNow.fullName.toLowerCase() !== repository.fullName.toLowerCase() ||
          ((write || repository.access === "write") && repositoryNow.access !== "write")
        )
          throw new GitHubRestAuthorityError(
            `${repository.fullName} is not available to the connected person at ${write ? "write" : repository.access} access`,
          );
      };
      return resolved(live, headers, authorizeEach(resolution, check));
    },
    account: {
      connectionId: authority.connectionId,
      resolveAuthority: async ({ toolName, destinationUrl, forceRefresh }) => {
        const live = await current();
        const { resolution, headers } = await credential(
          live,
          toolName,
          destinationUrl,
          forceRefresh,
        );
        return resolved(
          live,
          headers,
          authorizeEach(resolution, async (reread) => {
            if (reread) await current();
          }),
        );
      },
    },
  });
  return { id: PERSONAL_GITHUB_TOOLS_SERVER_ID, server };
}
