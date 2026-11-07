import {
  defaultRepositoryMountPath,
  repositoryMembershipKey,
  type RepositoryResourceRef,
} from "@opengeni/contracts";
import { attachSessionRepositoryResource, type ApiRouteDeps } from "@opengeni/core";
import { listPersonApprovedFirstPartyToolCalls } from "@opengeni/db";
import { githubRepositoryResourceRef, listWorkspaceGitHubRepositories } from "./github-access";

export const GITHUB_REPOSITORY_ATTACH_TOOL_NAME = "github_repository_attach";

/** A refusal the agent can act on; its message is returned as the tool error. */
export class SessionRepositoryAttachRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRepositoryAttachRefusedError";
  }
}

/**
 * `owner/name` from what the agent passed: `owner/name`, or a github.com URL
 * of the repository. Lower case, because GitHub names ignore case.
 */
export function repositoryFullNameKey(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//iu, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** The branch the agent asked for, or null for the default branch. */
function requestedRef(ref: string | undefined): string | null {
  const trimmed = ref?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Whether a person approved exactly this call (the same repository and
 * branch) in the chat, and this attempt is running it now. A call that
 * reached the tool any other way attaches nothing.
 */
function approvedCallMatches(
  approved: readonly string[],
  repository: string,
  ref: string | null,
): boolean {
  return approved.some((saved) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(saved);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const args = parsed as Record<string, unknown>;
    return (
      typeof args.repository === "string" &&
      repositoryFullNameKey(args.repository) === repository &&
      requestedRef(typeof args.ref === "string" ? args.ref : undefined) === ref
    );
  });
}

export type SessionRepositoryAttachOutcome = {
  status: "attached" | "already_attached";
  repository: string;
  ref: string;
  mountPath: string;
  reattached: boolean;
  message: string;
};

/**
 * Attach a workspace GitHub App repository to the agent's own chat after a
 * person approved the request in the chat. The repository must be one the
 * workspace GitHub App offers now (the same catalog and `github:use`
 * permission as the repository picker), not archived and not empty. It is
 * attached best effort (`optional`) on the branch asked for or its default
 * branch, and the next turn clones it.
 */
export async function attachApprovedSessionRepository(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    repository: string;
    ref?: string | undefined;
  },
): Promise<SessionRepositoryAttachOutcome> {
  const key = repositoryFullNameKey(input.repository);
  if (!key) {
    throw new SessionRepositoryAttachRefusedError(
      "Give the repository as owner/name, as listed by github_repositories_list.",
    );
  }
  const ref = requestedRef(input.ref);
  const approved = await listPersonApprovedFirstPartyToolCalls(deps.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    toolName: GITHUB_REPOSITORY_ATTACH_TOOL_NAME,
  });
  if (!approvedCallMatches(approved, key, ref)) {
    throw new SessionRepositoryAttachRefusedError(
      "Attaching a repository needs a person's approval in this chat.",
    );
  }
  const catalog = await listWorkspaceGitHubRepositories(deps, input.workspaceId);
  const repository = catalog.find((candidate) => candidate.fullName.toLowerCase() === key);
  if (!repository) {
    throw new SessionRepositoryAttachRefusedError(
      `${input.repository.trim()} is not offered by the workspace GitHub App. Find repositories with github_repositories_list.`,
    );
  }
  if (repository.archived === true) {
    throw new SessionRepositoryAttachRefusedError(`${repository.fullName} is archived.`);
  }
  if (repository.sizeKb === 0) {
    throw new SessionRepositoryAttachRefusedError(
      `${repository.fullName} is empty, so there is nothing to clone.`,
    );
  }
  const catalogResource = githubRepositoryResourceRef(repository);
  const resource: RepositoryResourceRef = {
    ...catalogResource,
    ...(ref ? { ref } : {}),
    optional: true,
  };
  const mountPath = resource.mountPath ?? defaultRepositoryMountPath(resource.uri, "github");
  const result = await attachSessionRepositoryResource(deps, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    resource,
  });
  if (!result.attached) {
    // What the chat has, which may be another branch than the one asked for.
    const memberKey = repositoryMembershipKey(resource.uri);
    const existing = result.session.resources.find(
      (candidate): candidate is RepositoryResourceRef =>
        candidate.kind === "repository" && repositoryMembershipKey(candidate.uri) === memberKey,
    );
    const attachedRef = existing?.ref ?? resource.ref;
    return {
      status: "already_attached",
      repository: repository.fullName,
      ref: attachedRef,
      mountPath:
        existing?.mountPath ?? defaultRepositoryMountPath(existing?.uri ?? resource.uri, "github"),
      reattached: false,
      message:
        attachedRef === resource.ref
          ? `${repository.fullName} is already attached to this chat.`
          : `${repository.fullName} is already attached to this chat, on branch ${attachedRef}.`,
    };
  }
  return {
    status: "attached",
    repository: repository.fullName,
    ref: resource.ref,
    mountPath,
    reattached: result.reattached,
    message: `Attached ${repository.fullName} (branch ${resource.ref}). It is one of this chat's repositories from the next turn; a managed sandbox clones it at ${mountPath}.`,
  };
}
