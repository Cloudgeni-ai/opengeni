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

function gitHubFullName(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.hostname !== "github.com") return null;
    const path = url.pathname.split("/").filter(Boolean).join("/");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(path) ? path : null;
  } catch {
    return null;
  }
}
