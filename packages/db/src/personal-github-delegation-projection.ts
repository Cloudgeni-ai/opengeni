import { ResourceRef, type McpPersonalConnectionDelegation } from "@opengeni/contracts";

type RepositorySnapshot = NonNullable<
  McpPersonalConnectionDelegation["personalGitHubRepositorySelection"]
>["repositories"][number];
type RepositoryResource = Extract<ResourceRef, { kind: "repository" }>;

/**
 * Another session's Your GitHub authority, fitted to the repositories of the
 * session it now runs in.
 *
 * An agent message or steer carries its sender's accepted delegations, whose
 * repository list names the sender's repositories. The receiving turn checks
 * that list against its own repositories exactly, so a sender with other
 * repositories (or none) made every such turn fail at start. The list is
 * rebuilt for the receiver's repositories, never beyond what the sender held:
 * a repository the sender held at that access, or any repository its All my
 * repositories covers. When one is outside that, the turn runs without Your
 * GitHub rather than failing.
 */
export function projectPersonalGitHubDelegationsOntoResources(
  delegations: McpPersonalConnectionDelegation[],
  /** The session's stored resources; an unreadable entry grants nothing. */
  resources: readonly unknown[],
): McpPersonalConnectionDelegation[] {
  const requested: RepositoryResource[] = [];
  let unreadable = false;
  for (const stored of resources) {
    const parsed = ResourceRef.safeParse(stored);
    if (!parsed.success) unreadable = true;
    else if (parsed.data.kind === "repository" && parsed.data.connectionType === "github_personal")
      requested.push(parsed.data);
  }
  return delegations.flatMap((delegation) => {
    const snapshot = delegation.personalGitHubRepositorySelection;
    if (delegation.connectionType !== "github_personal" || !snapshot) return [delegation];
    if (unreadable) return [];
    const all = snapshot.allRepositoriesAccess;
    const repositories: RepositorySnapshot[] = [];
    for (const resource of requested) {
      const access = resource.access;
      const ref = resource.ref;
      if (
        resource.credentialBindingId !== snapshot.credentialBindingId ||
        typeof resource.repositoryId !== "string" ||
        (access !== "read" && access !== "write") ||
        typeof ref !== "string" ||
        ref.length === 0
      ) {
        return [];
      }
      const held = snapshot.repositories.find(
        (candidate) =>
          candidate.repositoryId === resource.repositoryId &&
          candidate.canonicalUrl === resource.uri,
      );
      if (held && (access === "read" || held.access === "write")) {
        repositories.push({ ...held, ref, access });
        continue;
      }
      const fullName = gitHubFullName(resource.uri);
      if (all && (access === "read" || all === "write") && fullName) {
        repositories.push({
          repositoryId: resource.repositoryId,
          fullName,
          canonicalUrl: resource.uri,
          ref,
          access,
          selectionGeneration: snapshot.selectionGeneration,
        });
        continue;
      }
      return [];
    }
    if (repositories.length === 0 && !all) return [];
    return [{ ...delegation, personalGitHubRepositorySelection: { ...snapshot, repositories } }];
  });
}

/** The owner whose Your GitHub delegation the fit dropped, if it dropped one. */
export function droppedPersonalGitHubOwner(
  before: readonly McpPersonalConnectionDelegation[],
  after: readonly McpPersonalConnectionDelegation[],
): string | null {
  const isPersonalGitHub = (delegation: McpPersonalConnectionDelegation) =>
    delegation.connectionType === "github_personal" &&
    delegation.personalGitHubRepositorySelection !== undefined;
  const dropped = before.find(isPersonalGitHub);
  return dropped && !after.some(isPersonalGitHub) ? dropped.ownerSubjectId : null;
}

/** True when the session has Your GitHub repositories but no delegation for them. */
export function lacksPersonalGitHubForResources(
  delegations: readonly McpPersonalConnectionDelegation[],
  resources: readonly unknown[],
): boolean {
  if (
    delegations.some(
      (delegation) =>
        delegation.connectionType === "github_personal" &&
        delegation.personalGitHubRepositorySelection !== undefined,
    )
  )
    return false;
  return resources.some((stored) => {
    const parsed = ResourceRef.safeParse(stored);
    return (
      parsed.success &&
      parsed.data.kind === "repository" &&
      parsed.data.connectionType === "github_personal"
    );
  });
}

/**
 * The receiving session's own Your GitHub delegation for the same person,
 * newest first, fitted to its repositories: what that person already gave
 * this chat, so a message from a session with fewer repositories doesn't take
 * this chat's GitHub away. Null when none fits.
 */
export function ownPersonalGitHubDelegation(
  history: readonly (readonly McpPersonalConnectionDelegation[])[],
  ownerSubjectId: string,
  resources: readonly unknown[],
): McpPersonalConnectionDelegation | null {
  for (const delegations of history) {
    const own = delegations.find(
      (delegation) =>
        delegation.connectionType === "github_personal" &&
        delegation.ownerSubjectId === ownerSubjectId &&
        delegation.personalGitHubRepositorySelection !== undefined,
    );
    if (!own) continue;
    const [fitted] = projectPersonalGitHubDelegationsOntoResources([own], resources);
    if (fitted) return fitted;
  }
  return null;
}

function gitHubFullName(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.hostname !== "github.com") return null;
    const clonePath = url.pathname.split("/").filter(Boolean).join("/");
    // The same name the worker derives: a clone URL's ".git" is not part of it.
    const path = clonePath.endsWith(".git") ? clonePath.slice(0, -4) : clonePath;
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(path) ? path : null;
  } catch {
    return null;
  }
}
