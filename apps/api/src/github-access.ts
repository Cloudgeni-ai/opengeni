import type { GitHubInstallationBinding, GitHubRepository } from "@opengeni/contracts";
import { listGitHubInstallationAccessForWorkspace } from "@opengeni/db";
import { listGitHubAppRepositories } from "@opengeni/github";
import type { ApiRouteDeps } from "@opengeni/core";

export async function listWorkspaceGitHubInstallationBindings(
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<GitHubInstallationBinding[]> {
  const installations = await listGitHubInstallationAccessForWorkspace(deps.db, workspaceId);
  return installations.map((installation) => ({
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repositoryScope: installation.repositoryScope,
    repositoryCount: installation.repositoryIds.length,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  }));
}

export async function listWorkspaceGitHubRepositories(
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<GitHubRepository[]> {
  const access = await listGitHubInstallationAccessForWorkspace(deps.db, workspaceId);
  if (access.length === 0) {
    return [];
  }
  const installationIds = access.map((installation) => installation.installationId);
  const repositories = deps.githubAppApi?.listRepositories
    ? await deps.githubAppApi.listRepositories({ installationIds })
    : await listGitHubAppRepositories(deps.settings, { installationIds });
  const accessByInstallation = new Map(
    access.map((installation) => [installation.installationId, installation]),
  );
  return repositories.filter((repository) => {
    const installation = accessByInstallation.get(repository.installationId);
    if (!installation) {
      return false;
    }
    return (
      installation.repositoryScope === "all" || installation.repositoryIds.includes(repository.id)
    );
  });
}
