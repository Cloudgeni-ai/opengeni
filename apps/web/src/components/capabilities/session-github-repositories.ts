import { resourceMountPath, resourceMountPathCollisionKey } from "@opengeni/contracts";

import {
  gitHubRepositoryResource,
  isRepositoryResourceForGitHubRepo,
  repositoryDisplayName,
} from "@/lib/session-tools";
import type { GitHubRepository, ResourceRef } from "@/types";

type RepositoryResource = Extract<ResourceRef, { kind: "repository" }>;

/** Rows shown before "Show more"; one more page is revealed per click. */
export const GITHUB_CARD_PAGE_SIZE = 5;
/** The list offers search once scanning it by eye stops being quick. */
export const GITHUB_CARD_SEARCH_THRESHOLD = 6;

export type GitHubRepositoryChatState =
  | { kind: "available"; resource: RepositoryResource }
  | { kind: "attached" }
  | {
      kind: "blocked";
      cause: "other_account" | "mount_conflict";
      reason: string;
      /** The account whose App token this chat already uses. */
      usingAccount?: string;
    };

function repositoryResources(resources: readonly ResourceRef[]): RepositoryResource[] {
  return resources.filter(
    (resource): resource is RepositoryResource => resource.kind === "repository",
  );
}

/**
 * What "Use in this chat" may do for one workspace App repository. It applies
 * the composer picker's own rules to the chat's mounted resources: a repository
 * already mounted (by App identity, or as the member's personal identity) is
 * already usable, one GitHub App token per chat, and resources are additive, so
 * a mount-path collision is refused here instead of by the server.
 */
export function gitHubRepositoryChatState(
  repository: GitHubRepository,
  mounted: readonly ResourceRef[],
  accountLabel: (installationId: number) => string,
): GitHubRepositoryChatState {
  const repositories = repositoryResources(mounted);
  if (repositories.some((resource) => isRepositoryResourceForGitHubRepo(resource, repository))) {
    return { kind: "attached" };
  }
  if (
    repositories.some(
      (resource) =>
        resource.connectionType === "github_personal" &&
        repositoryDisplayName(resource).toLowerCase() === repository.fullName.toLowerCase(),
    )
  ) {
    return { kind: "attached" };
  }
  const otherInstallation = repositories.find(
    (resource) =>
      resource.githubInstallationId !== undefined &&
      resource.githubInstallationId !== repository.installationId,
  )?.githubInstallationId;
  if (otherInstallation !== undefined) {
    const usingAccount = accountLabel(otherInstallation);
    return {
      kind: "blocked",
      cause: "other_account",
      usingAccount,
      reason: `This chat already uses ${usingAccount}'s repositories. Start a new chat to use this one.`,
    };
  }
  const resource = gitHubRepositoryResource(repository, repository.defaultBranch);
  const mountKey = resourceMountPathCollisionKey(resourceMountPath(resource));
  if (
    mounted.some(
      (existing) => resourceMountPathCollisionKey(resourceMountPath(existing)) === mountKey,
    )
  ) {
    return {
      kind: "blocked",
      cause: "mount_conflict",
      reason: "Another repository in this chat already uses this folder name.",
    };
  }
  return { kind: "available", resource };
}

/**
 * App repositories this chat mounted that the workspace catalog no longer
 * lists: GitHub access was removed after the chat started. Only a loaded
 * catalog can prove absence; an unloaded or failed one is unknown.
 */
export function revokedGitHubRepositoryResources(
  mounted: readonly ResourceRef[],
  catalog: readonly GitHubRepository[],
  catalogReady: boolean,
): RepositoryResource[] {
  if (!catalogReady) return [];
  return repositoryResources(mounted).filter(
    (resource) =>
      resource.githubRepositoryId !== undefined &&
      resource.githubInstallationId !== undefined &&
      !catalog.some((repository) => isRepositoryResourceForGitHubRepo(resource, repository)),
  );
}

/** The ordinary human message that carries the repository. Short and natural. */
export function repositoryUseMessage(repository: Pick<GitHubRepository, "fullName">): string {
  return `Use ${repository.fullName}`;
}

/** Mounted repositories first (what the chat already uses), then by name. */
export function orderRepositoriesForChat(
  repositories: readonly GitHubRepository[],
  isAttached: (repository: GitHubRepository) => boolean,
): GitHubRepository[] {
  return [...repositories].sort((left, right) => {
    const attached = Number(isAttached(right)) - Number(isAttached(left));
    return attached !== 0
      ? attached
      : left.fullName.localeCompare(right.fullName, undefined, { sensitivity: "base" });
  });
}

export function matchesRepositorySearch(repository: GitHubRepository, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || repository.fullName.toLowerCase().includes(needle);
}

/** "Using acme/api in this chat", naming at most one repository. */
export function usingRepositoriesLabel(fullNames: readonly string[]): string | null {
  if (fullNames.length === 0) return null;
  const [first, ...rest] = fullNames;
  return rest.length === 0
    ? `Using ${first} in this chat`
    : `Using ${first} and ${rest.length} more in this chat`;
}
