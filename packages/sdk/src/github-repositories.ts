import type { OpenGeniClient } from "./client";
import type {
  GitHubRepositoryBranchesResponse,
  ListGitHubRepositoryBranchesOptions,
  VerifyPublicGitHubRepositoryRefRequest,
  VerifyPublicGitHubRepositoryRefResponse,
} from "./types";

type GitHubRepositoryRequestClient = Pick<OpenGeniClient, "requestJson">;

/** Verify one exact public github.com repository and branch/tag/SHA anonymously. */
export async function verifyPublicGitHubRepositoryRef(
  client: GitHubRepositoryRequestClient,
  workspaceId: string,
  request: VerifyPublicGitHubRepositoryRefRequest,
): Promise<VerifyPublicGitHubRepositoryRefResponse> {
  return await client.requestJson<VerifyPublicGitHubRepositoryRefResponse>(
    "POST",
    `/v1/workspaces/${workspaceId}/github/public-repositories/verify`,
    request,
  );
}

/** List one bounded page of branch suggestions for one exact workspace App repository. */
export async function listGitHubRepositoryBranches(
  client: GitHubRepositoryRequestClient,
  workspaceId: string,
  installationId: number,
  repositoryId: number,
  options: ListGitHubRepositoryBranchesOptions = {},
): Promise<GitHubRepositoryBranchesResponse> {
  return await client.requestJson<GitHubRepositoryBranchesResponse>(
    "GET",
    `/v1/workspaces/${workspaceId}/github/installations/${installationId}/repositories/${repositoryId}/branches`,
    undefined,
    {
      ...(options.cursor !== undefined ? { cursor: String(options.cursor) } : {}),
      ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
    },
  );
}

/** List one bounded page of branch suggestions for one currently selected personal repository. */
export async function listPersonalGitHubRepositoryBranches(
  client: GitHubRepositoryRequestClient,
  workspaceId: string,
  connectionId: string,
  repositoryId: string,
  options: ListGitHubRepositoryBranchesOptions = {},
): Promise<GitHubRepositoryBranchesResponse> {
  return await client.requestJson<GitHubRepositoryBranchesResponse>(
    "GET",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/github/repositories/${encodeURIComponent(repositoryId)}/branches`,
    undefined,
    {
      ...(options.cursor !== undefined ? { cursor: String(options.cursor) } : {}),
      ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
    },
  );
}
