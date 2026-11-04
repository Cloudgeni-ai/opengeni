import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import { getConnectionMetadata, type Database } from "@opengeni/db";

/**
 * The GitHub login of the accepted personal GitHub delegation, for the
 * repositories prompt only ("as the person (@login)"). Best effort: a missing or
 * unreadable connection omits the login and never fails the turn, and the
 * login grants nothing. Execution keeps revalidating authority separately.
 */
export async function personalGitHubLoginForTurn(
  db: Database,
  delegations: readonly McpPersonalConnectionDelegation[] | null | undefined,
  readConnection: typeof getConnectionMetadata = getConnectionMetadata,
): Promise<string | undefined> {
  const delegation = delegations?.find(
    (candidate) => candidate.connectionType === "github_personal" && candidate.originWorkspaceId,
  );
  if (!delegation?.originWorkspaceId) return undefined;
  try {
    const connection = await readConnection(
      db,
      delegation.originWorkspaceId,
      delegation.connectionId,
      delegation.ownerSubjectId,
    );
    const login = connection?.metadata.githubLogin;
    return typeof login === "string" && login.length > 0 ? login : undefined;
  } catch {
    return undefined;
  }
}
