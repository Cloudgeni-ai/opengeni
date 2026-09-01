import type {
  GitHubAppRepositoryBranchPage,
  GitHubBindingStatus,
  GitHubInstallationBinding,
  GitHubRepository,
  GitHubRepositoryBranchesResponse,
  ListGitHubRepositoryBranchesQuery,
} from "@opengeni/contracts";
import { GitHubRepositoryBranchesResponse as GitHubRepositoryBranchesResponseSchema } from "@opengeni/contracts";
import {
  areGitHubRepositoriesAllowedForWorkspace,
  hasAuditableGitHubInstallationAuthority,
  listGitHubInstallationAccessForWorkspace,
} from "@opengeni/db";
import {
  GitHubAppApiError,
  listGitHubAppInstallationSummaries,
  listGitHubAppRepositories,
  listGitHubAppRepositoryBranches,
} from "@opengeni/github";
import type { ApiRouteDeps } from "@opengeni/core";

export type GitHubRepositoryBranchAuthorityErrorCode = "changed" | "not_authorized";

export class GitHubRepositoryBranchAuthorityError extends Error {
  constructor(readonly code: GitHubRepositoryBranchAuthorityErrorCode) {
    super(code);
    this.name = "GitHubRepositoryBranchAuthorityError";
  }
}

export type WorkspaceGitHubRepositoryBranchServices = {
  listInstallationAccess: typeof listGitHubInstallationAccessForWorkspace;
  areRepositoriesAllowed: typeof areGitHubRepositoriesAllowedForWorkspace;
  listProviderBranches: (
    deps: ApiRouteDeps,
    input: {
      installationId: number;
      repositoryId: number;
      page: number;
      limit: number;
    },
  ) => Promise<GitHubAppRepositoryBranchPage | null>;
};

const workspaceGitHubRepositoryBranchServices: WorkspaceGitHubRepositoryBranchServices = {
  listInstallationAccess: listGitHubInstallationAccessForWorkspace,
  areRepositoriesAllowed: areGitHubRepositoriesAllowedForWorkspace,
  listProviderBranches: async (deps, input) =>
    deps.githubAppApi?.listRepositoryBranches
      ? await deps.githubAppApi.listRepositoryBranches(input)
      : deps.githubAppApi
        ? null
        : await listGitHubAppRepositoryBranches(deps.settings, input),
};

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
    configureUrl: null,
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

export async function listWorkspaceGitHubRepositoryBranches(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    installationId: number;
    repositoryId: number;
    query: ListGitHubRepositoryBranchesQuery;
  },
  services: WorkspaceGitHubRepositoryBranchServices = workspaceGitHubRepositoryBranchServices,
): Promise<GitHubRepositoryBranchesResponse> {
  const installations = await services.listInstallationAccess(deps.db, input.workspaceId);
  const installation = installations.find(
    (candidate) => candidate.installationId === input.installationId,
  );
  if (
    !installation ||
    installation.accountId !== input.accountId ||
    !hasAuditableGitHubInstallationAuthority(installation) ||
    !installation.repositoryIds.includes(input.repositoryId)
  ) {
    throw new GitHubRepositoryBranchAuthorityError("not_authorized");
  }
  if (
    !(await services.areRepositoriesAllowed(deps.db, input.workspaceId, input.installationId, [
      input.repositoryId,
    ]))
  ) {
    throw new GitHubRepositoryBranchAuthorityError("changed");
  }
  const page = await services.listProviderBranches(deps, {
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    page: input.query.cursor,
    limit: input.query.limit,
  });
  if (!page) {
    throw new GitHubAppApiError(
      "The configured GitHub provider cannot list exact repository branches",
    );
  }
  if (
    page.installationId !== input.installationId ||
    page.repositoryId !== input.repositoryId ||
    page.branches.length > input.query.limit ||
    (page.nextPage !== null && page.nextPage !== input.query.cursor + 1) ||
    (page.branches.length < input.query.limit && page.nextPage !== null)
  ) {
    throw new GitHubAppApiError("GitHub returned an invalid repository branches page");
  }
  const response = GitHubRepositoryBranchesResponseSchema.safeParse({
    branches: page.branches.map((name) => ({
      name,
      isDefault: name === page.defaultBranch,
    })),
    nextCursor: page.nextPage,
  });
  if (!response.success) {
    throw new GitHubAppApiError("GitHub returned an invalid repository branches page");
  }
  if (
    !(await services.areRepositoriesAllowed(deps.db, input.workspaceId, input.installationId, [
      input.repositoryId,
    ]))
  ) {
    throw new GitHubRepositoryBranchAuthorityError("changed");
  }
  return response.data;
}
