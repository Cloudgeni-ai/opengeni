import { resourcesIncludeRepository, type ResourceRef } from "@opengeni/contracts";
import { getSessionResourcesForAuthority, type Database } from "@opengeni/db";

/**
 * Session membership is live repository authority for credential minting: a
 * repository removed from the chat (or from a parent chat) must not reach a
 * token request again, even from a turn, child or goal continuation that
 * captured an older resource snapshot.
 */
type SessionRef = { db: Database; workspaceId: string; sessionId: string };

export class GitHubTokenMintRepositoryRemovedError extends Error {
  constructor() {
    super("A GitHub repository in this token request was removed from the session");
  }
}

/** `resources` without repositories that are no longer attached to the session. */
export async function attachedRepositoryResources(
  session: SessionRef,
  resources: readonly ResourceRef[],
): Promise<ResourceRef[]> {
  if (!resources.some((resource) => resource.kind === "repository")) return [...resources];
  const live = await getSessionResourcesForAuthority(
    session.db,
    session.workspaceId,
    session.sessionId,
  );
  return resources.filter(
    (resource) =>
      resource.kind !== "repository" ||
      (live !== null && resourcesIncludeRepository(live, resource.uri)),
  );
}

/** Fails closed when a token request names a repository no longer attached. */
export async function assertTokenRepositoriesAttached(
  session: SessionRef,
  repositories: readonly { uri: string }[],
): Promise<void> {
  const live = await getSessionResourcesForAuthority(
    session.db,
    session.workspaceId,
    session.sessionId,
  );
  if (
    !live ||
    repositories.some((repository) => !resourcesIncludeRepository(live, repository.uri))
  ) {
    throw new GitHubTokenMintRepositoryRemovedError();
  }
}
