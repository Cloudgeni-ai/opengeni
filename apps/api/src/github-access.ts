import type {
  GitHubBindingStatus,
  GitHubInstallationBinding,
  GitHubRepository,
} from "@opengeni/contracts";
import {
  hasAuditableGitHubInstallationAuthority,
  listGitHubInstallationAccessForWorkspace,
} from "@opengeni/db";
import { listGitHubAppInstallationSummaries, listGitHubAppRepositories } from "@opengeni/github";
import type { ApiRouteDeps } from "@opengeni/core";

export async function listWorkspaceGitHubInstallationBindings(
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<GitHubInstallationBinding[]> {
  const installations = await listGitHubInstallationAccessForWorkspace(deps.db, workspaceId);
  if (installations.length === 0) {
    return [];
  }
  let liveById = new Map<number, LiveGitHubInstallation | null>();
  let lifecycleVerified = false;
  try {
    if (deps.githubAppApi?.getInstallation) {
      liveById = new Map(
        await Promise.all(
          installations.map(
            async (installation) =>
              [
                installation.installationId,
                await deps.githubAppApi!.getInstallation!({
                  installationId: installation.installationId,
                }),
              ] as const,
          ),
        ),
      );
      lifecycleVerified = true;
    } else if (!deps.githubAppApi) {
      liveById = new Map(
        (await listGitHubAppInstallationSummaries(deps.settings)).map((installation) => [
          installation.installationId,
          installation,
        ]),
      );
      lifecycleVerified = true;
    }
  } catch {
    // A provider outage cannot make a stored row healthy. Preserve the row for
    // audit/unlink but project it as unverified and keep workspace status
    // unbound until GitHub can be checked again.
    liveById = new Map();
  }
  return installations.map((installation) => ({
    installationId: installation.installationId,
    githubAccountId: installation.githubAccountId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    lifecycle: githubInstallationBindingLifecycle(
      installation,
      liveById,
      installation.installationId,
      lifecycleVerified,
    ),
    repositoryScope: installation.repositoryScope,
    repositoryCount: installation.repositoryIds.length,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  }));
}

export function githubBindingStatus(
  configured: boolean,
  installations: GitHubInstallationBinding[],
): GitHubBindingStatus {
  if (!configured) {
    return "disabled";
  }
  return installations.some((installation) => installation.lifecycle === "active")
    ? "bound"
    : "unbound";
}

export type LiveGitHubInstallation = {
  installationId: number;
  accountId: number;
  suspended: boolean;
};

export function githubInstallationBindingLifecycle(
  stored: Awaited<ReturnType<typeof listGitHubInstallationAccessForWorkspace>>[number],
  liveById: Map<number, LiveGitHubInstallation | null>,
  installationId: number,
  lifecycleVerified: boolean,
): GitHubInstallationBinding["lifecycle"] {
  if (!hasAuditableGitHubInstallationAuthority(stored)) {
    return "unverified";
  }
  if (!lifecycleVerified) {
    return "unverified";
  }
  if (!liveById.has(installationId)) {
    return "deleted";
  }
  const live = liveById.get(installationId);
  if (!live) {
    return "deleted";
  }
  if (live.suspended) {
    return "suspended";
  }
  if (live.installationId !== installationId || stored.githubAccountId !== live.accountId) {
    return "unverified";
  }
  return "active";
}

export async function listWorkspaceGitHubRepositories(
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<GitHubRepository[]> {
  const bindings = await listWorkspaceGitHubInstallationBindings(deps, workspaceId);
  const activeInstallationIds = new Set(
    bindings
      .filter((installation) => installation.lifecycle === "active")
      .map((installation) => installation.installationId),
  );
  if (activeInstallationIds.size === 0) {
    return [];
  }
  const access = await listGitHubInstallationAccessForWorkspace(deps.db, workspaceId);
  const authorizedAccess = access.filter(
    (installation) =>
      activeInstallationIds.has(installation.installationId) &&
      hasAuditableGitHubInstallationAuthority(installation),
  );
  if (authorizedAccess.length === 0) {
    return [];
  }
  const installationIds = authorizedAccess.map((installation) => installation.installationId);
  const repositories = deps.githubAppApi?.listRepositories
    ? await deps.githubAppApi.listRepositories({ installationIds })
    : await listGitHubAppRepositories(deps.settings, { installationIds });
  const accessByInstallation = new Map(
    authorizedAccess.map((installation) => [installation.installationId, installation]),
  );
  return repositories.filter((repository) => {
    const installation = accessByInstallation.get(repository.installationId);
    if (!installation) {
      return false;
    }
    return installation.repositoryIds.includes(repository.id);
  });
}
