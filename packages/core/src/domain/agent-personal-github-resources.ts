import type { Settings } from "@opengeni/config";
import type {
  AccessGrant,
  McpPersonalConnectionDelegation,
  RepositoryResourceRef,
  ResourceRef,
} from "@opengeni/contracts";
import { randomUUID } from "node:crypto";
import {
  GITHUB_OWNER_LOGIN_PATTERN,
  PERSONAL_GITHUB_PROVIDER_DOMAIN,
  type PersonalGitHubRepositoryAccess,
} from "@opengeni/contracts/personal-github";
import {
  buildConnectionTokenResolver,
  getSessionRepositoryMembershipForAuthority,
  getSessionTurnPersonalConnectionDelegations,
  resolveAcceptedConnectionUse,
  sessionRepositoryRemoved,
  type Database,
  type SessionRepositoryMembership,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { personalConnectionDelegationSourceForGrant } from "./personal-connection-delegations";
import {
  checkPersonalGitHubRepositoryAccess,
  personalGitHubRepositoryDenialMessage,
  type PersonalGitHubAcceptedRepositorySelection,
  type PersonalGitHubRepositoryAccessResult,
  type PersonalGitHubRepositoryLookup,
} from "./personal-github-repository-access";

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A repository an agent asks to use as the person without every internal
 * field: typically just `uri`, `ref` and `connectionType: "github_personal"`.
 * Agents cannot know the binding, provider repository id or the access their
 * turn holds, so the server fills in whatever is missing from the turn's own
 * accepted Your GitHub delegation, and checks whatever was given.
 */
export function isUnresolvedPersonalGitHubRepositoryResource(
  resource: ResourceRef,
): resource is RepositoryResourceRef & { connectionType: "github_personal" } {
  return (
    resource.kind === "repository" &&
    resource.connectionType === "github_personal" &&
    (resource.provider === undefined || resource.provider === "github") &&
    (resource.credentialBindingId === undefined ||
      resource.repositoryId === undefined ||
      resource.access === undefined)
  );
}

/** `owner/name` from a GitHub repository URI, or null when it names none. */
export function personalGitHubRepositoryFullNameFromUri(uri: string): string | null {
  const value = uri.trim();
  let path: string;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/iu.exec(value);
  if (ssh) {
    path = ssh[1]!;
  } else if (/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_.-]+$/u.test(value)) {
    path = value;
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      (host !== "github.com" && host !== "www.github.com") ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    path = url.pathname;
  }
  const [owner, name, ...rest] = path
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .split("/")
    .filter(Boolean);
  if (
    !owner ||
    !name ||
    rest.length > 0 ||
    !GITHUB_OWNER_LOGIN_PATTERN.test(owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(name)
  ) {
    return null;
  }
  return `${owner}/${name}`;
}

export type ResolveAgentPersonalGitHubRepositoryServices = {
  loadTurnDelegations: (input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
  }) => Promise<McpPersonalConnectionDelegation[]>;
  loadSessionMembership: (input: {
    workspaceId: string;
    sessionId: string;
  }) => Promise<SessionRepositoryMembership | null>;
  checkAccess: (input: {
    delegation: McpPersonalConnectionDelegation;
    accepted: PersonalGitHubAcceptedRepositorySelection;
    repository: PersonalGitHubRepositoryLookup;
    access: PersonalGitHubRepositoryAccess;
    /** The calling attempt, when known; GitHub lookups are attributed to it. */
    attempt: AgentTurnAttempt | null;
  }) => Promise<PersonalGitHubRepositoryAccessResult>;
};

/** The agent attempt whose turn is creating the work. */
export type AgentTurnAttempt = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

function agentTurnAttempt(grant: AccessGrant): AgentTurnAttempt | null {
  const metadata = grant.metadata ?? {};
  const sessionId = metadata["sessionId"];
  const turnId = metadata["turnId"];
  const attemptId = metadata["attemptId"];
  const executionGeneration = metadata["executionGeneration"];
  return typeof sessionId === "string" &&
    typeof turnId === "string" &&
    typeof attemptId === "string" &&
    typeof executionGeneration === "number" &&
    Number.isSafeInteger(executionGeneration) &&
    executionGeneration > 0
    ? { sessionId, turnId, attemptId, executionGeneration }
    : null;
}

function rejected(message: string): HTTPException {
  return new HTTPException(422, { message });
}

const NEW_MESSAGE =
  "The person needs to send a new message so this chat picks up their current Your GitHub access.";

function noDelegationMessage(fullName: string): string {
  return `This turn has no Your GitHub access to pass on, so a new session can't use ${fullName} as the person. Your GitHub access comes from the person who sent the current message: they connect Your GitHub and attach the repository to this chat as themselves or turn on All my repositories, then send a new message. Omit connectionType to use the workspace's GitHub app instead.`;
}

function deniedMessage(
  fullName: string,
  result: Extract<PersonalGitHubRepositoryAccessResult, { allowed: false }>,
  access: PersonalGitHubRepositoryAccess,
): string {
  switch (result.reason) {
    case "outside_accepted_work":
    case "not_selected":
      return access === "write" && result.reason === "outside_accepted_work"
        ? `This turn's Your GitHub access does not cover ${fullName} with write access. Ask for access "read", or the person can attach it to this chat as themselves with write access (or turn on All my repositories with read and write) and send a new message.`
        : `${fullName} is not part of this turn's Your GitHub access. The person can attach it to this chat as themselves or turn on All my repositories, then send a new message.`;
    case "write_denied":
      return `${fullName} can only be read as the person. Ask for access "read", or the person can allow writing to it in their Your GitHub repository choice.`;
    case "not_found":
      return `GitHub has no repository ${fullName} that the person can access.`;
    case "read_denied":
      return `The person cannot read ${fullName} on GitHub.`;
    case "reconnect_required":
      return `GitHub no longer accepts the person's Your GitHub connection, so ${fullName} can't be used as them. They need to reconnect Your GitHub (github_connect_link gives the link), then send a new message.`;
    case "connection_changed":
    case "selection_changed":
      return `The person's Your GitHub connection or repository choice changed since this turn started, so ${fullName} can't be used as them from this turn. ${NEW_MESSAGE}`;
    case "connection_unavailable":
      return `The person's Your GitHub connection is unavailable, so ${fullName} can't be used as them. Check it with github_connect_link; the person may need to reconnect.`;
    case "provider_unavailable":
      return `GitHub didn't answer whether the person can use ${fullName}. Try again.`;
    default:
      return `Can't use ${fullName} as the person: ${result.message}`;
  }
}

/**
 * Fill in personal GitHub repository resources that an agent named with just
 * `uri`, `ref` and `connectionType: "github_personal"`, from the calling
 * turn's own accepted Your GitHub delegation: the same person, connection and
 * credential binding, the repository id from the shared allowlist check, and
 * access capped at what the turn holds (the most it holds when the agent did
 * not ask for a level). Nothing is widened: a repository or access outside
 * the turn's delegation, or a repository a person removed from the calling
 * chat, is refused with a message that says what fixes it.
 *
 * Other resources, fully specified personal resources, and callers that are
 * not an agent turn pass through unchanged; the ordinary validation decides.
 */
export async function resolveAgentPersonalGitHubRepositoryResources<T extends ResourceRef>(input: {
  grant: AccessGrant;
  workspaceId: string;
  settings: Pick<Settings, "githubPersonalOauthEnabled">;
  resources: T[];
  services: ResolveAgentPersonalGitHubRepositoryServices;
  /** The turn's frozen delegations when the caller already loaded them. */
  turnDelegations?: McpPersonalConnectionDelegation[] | null | undefined;
}): Promise<Array<T | RepositoryResourceRef>> {
  if (!input.resources.some(isUnresolvedPersonalGitHubRepositoryResource)) {
    return input.resources;
  }
  const source = personalConnectionDelegationSourceForGrant(input.grant);
  if (source.kind !== "turn") return input.resources;
  if (input.settings.githubPersonalOauthEnabled !== true) {
    throw rejected(
      "Your GitHub is not enabled on this deployment. Omit connectionType to use the workspace's GitHub app.",
    );
  }
  const delegations =
    input.turnDelegations ??
    (await input.services.loadTurnDelegations({
      workspaceId: input.workspaceId,
      sessionId: source.sessionId,
      turnId: source.turnId,
    }));
  const attempt = agentTurnAttempt(input.grant);
  const githubDelegations = delegations.filter(
    (delegation) =>
      delegation.connectionType === "github_personal" &&
      delegation.personalGitHubRepositorySelection !== undefined,
  );
  let membership: SessionRepositoryMembership | null | undefined;
  const resolved: Array<T | RepositoryResourceRef> = [];
  for (const resource of input.resources) {
    if (!isUnresolvedPersonalGitHubRepositoryResource(resource)) {
      resolved.push(resource);
      continue;
    }
    const fullName = personalGitHubRepositoryFullNameFromUri(resource.uri);
    if (!fullName) {
      throw rejected(
        `A repository used as the person needs a GitHub URI like https://github.com/<owner>/<repo>; got ${resource.uri}.`,
      );
    }
    if (githubDelegations.length > 1) {
      throw rejected(
        `This turn carries more than one Your GitHub account, so it can't tell which one to use for ${fullName}. ${NEW_MESSAGE}`,
      );
    }
    const delegation = githubDelegations[0];
    const accepted = delegation?.personalGitHubRepositorySelection;
    if (!delegation || !accepted) throw rejected(noDelegationMessage(fullName));
    if (
      resource.credentialBindingId !== undefined &&
      resource.credentialBindingId !== accepted.credentialBindingId
    ) {
      throw rejected(
        `The credentialBindingId given for ${fullName} is not this turn's Your GitHub account. Omit it; the server fills it in.`,
      );
    }
    const requested = resource.access;
    const check = async (access: PersonalGitHubRepositoryAccess) =>
      await input.services.checkAccess({
        delegation,
        accepted,
        repository: { fullName },
        access,
        attempt,
      });
    const result = await check(requested ?? "read");
    if (!result.allowed) throw rejected(deniedMessage(fullName, result, requested ?? "read"));
    const repository = result.repository;
    if (
      resource.repositoryId !== undefined &&
      String(resource.repositoryId) !== String(repository.repositoryId)
    ) {
      throw rejected(
        `The repositoryId given does not match ${repository.fullName} on GitHub. Omit it; the server looks it up.`,
      );
    }
    // Without a requested level, take the most this turn holds: write only
    // when the same shared check allows write now (the turn accepted write,
    // the person still allows it, and GitHub lets them push).
    const access: PersonalGitHubRepositoryAccess =
      requested ?? (result.access === "write" && (await check("write")).allowed ? "write" : "read");
    membership ??= await input.services.loadSessionMembership({
      workspaceId: input.workspaceId,
      sessionId: source.sessionId,
    });
    if (!membership) {
      throw rejected(
        `This chat could not be found, so ${repository.fullName} can't be passed on as the person.`,
      );
    }
    if (
      sessionRepositoryRemoved(membership, {
        uris: [repository.canonicalUrl, resource.uri],
        githubRepositoryId: repository.repositoryId,
      })
    ) {
      throw rejected(
        `A person removed ${repository.fullName} from this chat, so new sessions can't use it. Only a person can attach it again.`,
      );
    }
    // Fields of the GitHub app or other providers mean nothing here.
    const {
      connectionId: _connectionId,
      installationId: _installationId,
      githubInstallationId: _githubInstallationId,
      githubRepositoryId: _githubRepositoryId,
      projectId: _projectId,
      ...rest
    } = resource;
    resolved.push({
      ...rest,
      uri: repository.canonicalUrl,
      provider: "github",
      connectionType: "github_personal",
      credentialBindingId: accepted.credentialBindingId,
      repositoryId: repository.repositoryId,
      access,
    });
  }
  return resolved;
}

/** The database-backed services: the turn's frozen delegation and the shared allowlist check. */
export function agentPersonalGitHubRepositoryServices(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  /** The calling session's workspace, where its turn accepted the connection use. */
  workspaceId: string;
  githubPersonalFetch?: typeof fetch | undefined;
}): ResolveAgentPersonalGitHubRepositoryServices {
  const fetchImpl = input.githubPersonalFetch ?? fetch;
  return {
    loadTurnDelegations: async ({ workspaceId, sessionId, turnId }) =>
      await getSessionTurnPersonalConnectionDelegations(input.db, workspaceId, sessionId, turnId),
    loadSessionMembership: async ({ workspaceId, sessionId }) =>
      await getSessionRepositoryMembershipForAuthority(input.db, workspaceId, sessionId),
    checkAccess: async ({ delegation, accepted, repository, access, attempt }) => {
      const originWorkspaceId = delegation.originWorkspaceId;
      if (!originWorkspaceId) {
        return denial("connection_unavailable");
      }
      const resolver = buildConnectionTokenResolver(input.db, input.settings, undefined, {
        ...(input.githubPersonalFetch
          ? { refreshTransport: { fetchImpl: input.githubPersonalFetch } }
          : {}),
      });
      // Why a GitHub lookup failed, so the agent hears "reconnect" or "the
      // connection changed" instead of "try again" when that is the cause.
      let lookupFailure: "reconnect" | "denied" | "transient" | null = null;
      const check = async () =>
        await checkPersonalGitHubRepositoryAccess({
          db: input.db,
          accountId: input.accountId,
          originWorkspaceId,
          ownerSubjectId: delegation.ownerSubjectId,
          connectionId: delegation.connectionId,
          repository,
          access,
          accepted,
          // Only All my repositories asks GitHub, as the person, which
          // repository this is and whether they can use it. The request is
          // this turn's own accepted use of the person's connection.
          githubGet: async (url) => {
            if (!attempt) {
              lookupFailure = "denied";
              throw new Error("no agent attempt to attribute the GitHub lookup to");
            }
            const authorization = await turnGitHubAuthorization({
              db: input.db,
              resolver,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              originWorkspaceId,
              delegation,
              accepted,
              attempt,
              url,
            });
            if (authorization.status !== "ok") {
              lookupFailure = authorization.status;
              throw new Error("Your GitHub credential is unavailable for this turn");
            }
            const response = await fetchImpl(url, {
              method: "GET",
              redirect: "manual",
              headers: {
                accept: "application/vnd.github+json",
                authorization: authorization.authorization,
                "user-agent": "Opengeni",
                "x-github-api-version": GITHUB_API_VERSION,
              },
              signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
            });
            if (response.status === 401) lookupFailure = "reconnect";
            return response;
          },
        });
      const result = await check();
      if (result.allowed || result.reason !== "provider_unavailable") return result;
      const failure = lookupFailure as "reconnect" | "denied" | "transient" | null;
      if (failure === "reconnect") return denial("reconnect_required");
      if (failure === "denied") {
        // A refused credential may have just marked the connection for
        // reconnecting or changed its generation; the shared check says which.
        const again = await check();
        return !again.allowed && again.reason === "provider_unavailable"
          ? denial("connection_unavailable")
          : again;
      }
      return result;
    },
  };
}

function denial(
  reason: Extract<PersonalGitHubRepositoryAccessResult, { allowed: false }>["reason"],
): PersonalGitHubRepositoryAccessResult {
  return { allowed: false, reason, message: personalGitHubRepositoryDenialMessage(reason) };
}

const PERSONAL_GITHUB_SERVER_ID = "github:personal";

/**
 * The `Authorization` header for one GitHub request as the person, resolved as
 * the calling turn's own accepted use of their connection (the same fences
 * the Git broker applies: credential resolution and provider request are both
 * attributed to this attempt and must name the delegation's exact connection,
 * generation, owner and origin workspace).
 */
async function turnGitHubAuthorization(input: {
  db: Database;
  resolver: ReturnType<typeof buildConnectionTokenResolver>;
  accountId: string;
  workspaceId: string;
  originWorkspaceId: string;
  delegation: McpPersonalConnectionDelegation;
  accepted: PersonalGitHubAcceptedRepositorySelection;
  attempt: AgentTurnAttempt;
  url: URL;
}): Promise<
  { status: "ok"; authorization: string } | { status: "denied" } | { status: "transient" }
> {
  const { delegation, accepted, attempt } = input;
  const useContext = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
  };
  const credential = await input.resolver({
    workspaceId: input.originWorkspaceId,
    subjectId: delegation.ownerSubjectId,
    serverId: PERSONAL_GITHUB_SERVER_ID,
    toolName: "repository_verify",
    connectionRef: {
      connectionId: delegation.connectionId,
      provider: "github",
      providerDomain: PERSONAL_GITHUB_PROVIDER_DOMAIN,
      kind: "oauth2",
      subjectScope: "subject",
      scopes: ["repo"],
    },
    destinationUrl: input.url.toString(),
    credentialTarget: "http_api",
    connectionUseContext: {
      ...useContext,
      physicalRequestId: randomUUID(),
      usePhase: "credential_resolution",
    },
  });
  if (credential.status !== "ok") {
    return credential.reason === "refresh_failed" ? { status: "transient" } : { status: "denied" };
  }
  if (
    credential.connectionId !== delegation.connectionId ||
    credential.connectionUseAttribution?.connectionGeneration !==
      accepted.connectionAuthorityGeneration ||
    credential.connectionUseAttribution.ownerSubjectId !== delegation.ownerSubjectId
  ) {
    return { status: "denied" };
  }
  const providerRequest = await resolveAcceptedConnectionUse(input.db, {
    ...useContext,
    physicalRequestId: randomUUID(),
    usePhase: "provider_request",
    serverId: PERSONAL_GITHUB_SERVER_ID,
    connectionId: delegation.connectionId,
    providerDomain: PERSONAL_GITHUB_PROVIDER_DOMAIN,
    connectionKind: "oauth2",
    subjectScope: "subject",
    ownerSubjectId: delegation.ownerSubjectId,
  });
  if (
    providerRequest.status !== "authorized" ||
    providerRequest.originWorkspaceId !== input.originWorkspaceId ||
    providerRequest.attribution.connectionId !== delegation.connectionId ||
    providerRequest.attribution.connectionGeneration !== accepted.connectionAuthorityGeneration ||
    providerRequest.attribution.ownerSubjectId !== delegation.ownerSubjectId
  ) {
    return { status: "denied" };
  }
  const authorization = Object.entries(credential.headers).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  return authorization ? { status: "ok", authorization } : { status: "denied" };
}
