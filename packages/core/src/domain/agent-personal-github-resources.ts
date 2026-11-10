import type { Settings } from "@opengeni/config";
import type {
  AccessGrant,
  McpPersonalConnectionDelegation,
  RepositoryResourceRef,
  ResourceRef,
} from "@opengeni/contracts";
import {
  PERSONAL_GITHUB_PROVIDER_DOMAIN,
  personalGitHubAccessCovers,
  type PersonalGitHubRepositoryAccess,
} from "@opengeni/contracts/personal-github";
import {
  buildConnectionTokenResolver,
  getSessionRepositoryMembershipForAuthority,
  getSessionTurnPersonalConnectionDelegations,
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
 * A repository an agent asks to use as the person by naming only `uri`, `ref`
 * and `connectionType: "github_personal"`. Agents cannot know the binding,
 * provider repository id or the access their turn holds, so the server fills
 * them in from the turn's own accepted Your GitHub delegation.
 */
export function isUnresolvedPersonalGitHubRepositoryResource(
  resource: ResourceRef,
): resource is RepositoryResourceRef & { connectionType: "github_personal" } {
  return (
    resource.kind === "repository" &&
    resource.connectionType === "github_personal" &&
    (resource.provider === undefined || resource.provider === "github") &&
    resource.credentialBindingId === undefined &&
    resource.repositoryId === undefined
  );
}

/** `owner/name` from a GitHub repository URI, or null when it names none. */
export function personalGitHubRepositoryFullNameFromUri(uri: string): string | null {
  const value = uri.trim();
  let path: string;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/iu.exec(value);
  if (ssh) {
    path = ssh[1]!;
  } else if (/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
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
    !/^[A-Za-z0-9-]{1,39}$/u.test(owner) ||
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
  }) => Promise<PersonalGitHubRepositoryAccessResult>;
};

function rejected(message: string): HTTPException {
  return new HTTPException(422, { message });
}

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
  const delegations = await input.services.loadTurnDelegations({
    workspaceId: input.workspaceId,
    sessionId: source.sessionId,
    turnId: source.turnId,
  });
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
    // One accepted turn carries at most one Your GitHub account.
    const delegation = githubDelegations.length === 1 ? githubDelegations[0]! : null;
    const accepted = delegation?.personalGitHubRepositorySelection;
    if (!delegation || !accepted) throw rejected(noDelegationMessage(fullName));
    const requested = resource.access;
    const result = await input.services.checkAccess({
      delegation,
      accepted,
      repository: { fullName },
      access: requested ?? "read",
    });
    if (!result.allowed) throw rejected(deniedMessage(fullName, result, requested ?? "read"));
    const repository = result.repository;
    // The turn's own ceiling for this repository: never more than the person
    // allows now (result.access) or than the turn accepted.
    const access: PersonalGitHubRepositoryAccess =
      requested ??
      (result.access === "write" &&
      (personalGitHubAccessCovers(accepted.allRepositoriesAccess, "write") ||
        accepted.repositories.some(
          (listed) => listed.repositoryId === repository.repositoryId && listed.access === "write",
        ))
        ? "write"
        : "read");
    membership ??= await input.services.loadSessionMembership({
      workspaceId: input.workspaceId,
      sessionId: source.sessionId,
    });
    if (
      !membership ||
      sessionRepositoryRemoved(membership, {
        uris: [repository.canonicalUrl, resource.uri],
        githubRepositoryId: repository.repositoryId,
      })
    ) {
      throw rejected(
        `A person removed ${repository.fullName} from this chat, so new sessions can't use it. Only a person can attach it again.`,
      );
    }
    resolved.push({
      ...resource,
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
  githubPersonalFetch?: typeof fetch | undefined;
}): ResolveAgentPersonalGitHubRepositoryServices {
  const fetchImpl = input.githubPersonalFetch ?? fetch;
  return {
    loadTurnDelegations: async ({ workspaceId, sessionId, turnId }) =>
      await getSessionTurnPersonalConnectionDelegations(input.db, workspaceId, sessionId, turnId),
    loadSessionMembership: async ({ workspaceId, sessionId }) =>
      await getSessionRepositoryMembershipForAuthority(input.db, workspaceId, sessionId),
    checkAccess: async ({ delegation, accepted, repository, access }) => {
      const originWorkspaceId = delegation.originWorkspaceId;
      if (!originWorkspaceId) {
        return {
          allowed: false,
          reason: "connection_unavailable",
          message: personalGitHubRepositoryDenialMessage("connection_unavailable"),
        };
      }
      const resolver = buildConnectionTokenResolver(input.db, input.settings, undefined, {
        ...(input.githubPersonalFetch
          ? { refreshTransport: { fetchImpl: input.githubPersonalFetch } }
          : {}),
      });
      return await checkPersonalGitHubRepositoryAccess({
        db: input.db,
        accountId: input.accountId,
        originWorkspaceId,
        ownerSubjectId: delegation.ownerSubjectId,
        connectionId: delegation.connectionId,
        repository,
        access,
        accepted,
        // Only All my repositories asks GitHub, as the person, which
        // repository this is and whether they can use it.
        githubGet: async (url) => {
          const credential = await resolver({
            workspaceId: originWorkspaceId,
            subjectId: delegation.ownerSubjectId,
            serverId: "github-personal-repository-picker",
            toolName: "repository_verify",
            connectionRef: {
              connectionId: delegation.connectionId,
              providerDomain: PERSONAL_GITHUB_PROVIDER_DOMAIN,
              kind: "oauth2",
              subjectScope: "subject",
              scopes: ["repo"],
            },
            destinationUrl: url.toString(),
            credentialTarget: "http_api",
          });
          const authorization =
            credential.status === "ok" && credential.connectionId === delegation.connectionId
              ? Object.entries(credential.headers).find(
                  ([name]) => name.toLowerCase() === "authorization",
                )?.[1]
              : undefined;
          if (!authorization) throw new Error("Your GitHub credential is unavailable");
          return await fetchImpl(url, {
            method: "GET",
            redirect: "manual",
            headers: {
              accept: "application/vnd.github+json",
              authorization,
              "user-agent": "Opengeni",
              "x-github-api-version": GITHUB_API_VERSION,
            },
            signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
          });
        },
      });
    },
  };
}
