import {
  defaultRepositoryMountPath,
  type GitHubAppRepositoryBranchPage,
  type GitHubBindingStatus,
  type GitHubInstallationBinding,
  type GitHubRepository,
  type RepositoryResourceRef,
} from "@opengeni/contracts";
import {
  GitHubRepositoryBranchesResponse as GitHubRepositoryBranchesResponseSchema,
  type GitHubRepositoryBranchesResponse,
  type ListGitHubRepositoryBranchesQuery,
} from "@opengeni/contracts/github-repository-contracts";
import {
  applyGitHubInstallationRepositoryObservation,
  areGitHubRepositoriesAllowedForWorkspace,
  hasAuditableGitHubInstallationAuthority,
  hasGitHubInstallationOwnerAuthority,
  listGitHubInstallationAccessForWorkspace,
  type GitHubInstallationAccess,
} from "@opengeni/db";
import {
  GitHubAppApiError,
  GitHubAppConfigurationError,
  getGitHubAppWebhookSetup,
  getGitHubAppInstallationSummary,
  listGitHubAppRepositories,
  listGitHubAppRepositoryBranches,
  setGitHubAppWebhookUrl,
} from "@opengeni/github";
import type { ApiRouteDeps, GitHubAppWebhookPort } from "@opengeni/core";
import {
  createGitHubRepositoryCatalog,
  type GitHubRepositoryCatalog,
} from "./github-repository-catalog";
import {
  requestGitHubInstallationRepositorySync,
  withoutRecentlyRemovedGitHubRepositories,
} from "./github-installation-sync";

/** How often a passive read may ask GitHub about one installation by itself. */
const GITHUB_BACKGROUND_SYNC_INTERVAL_MS = 60_000;
/**
 * How long a passive repository read waits for GitHub when it has a last good
 * list to answer with instead; GitHub's answer then applies in the background.
 */
export const GITHUB_PASSIVE_LIST_WAIT_MS = 3_000;

/**
 * The GitHub App's webhook settings for GitHub event sources: the host's App
 * when it provides one (null if the host manages the webhook itself), else
 * this deployment's own App when it is configured.
 */
export function githubAppWebhookPort(
  deps: Pick<ApiRouteDeps, "githubAppApi" | "settings">,
): GitHubAppWebhookPort | null {
  const host = deps.githubAppApi;
  if (host) {
    const { getWebhookSetup, setWebhookUrl } = host;
    return getWebhookSetup && setWebhookUrl ? { getWebhookSetup, setWebhookUrl } : null;
  }
  const { settings } = deps;
  const secret = settings.githubWebhookSecret?.trim();
  if (!settings.githubAppId?.trim() || !settings.githubAppPrivateKey?.trim() || !secret) {
    return null;
  }
  return {
    getWebhookSetup: async () => await getGitHubAppWebhookSetup(settings),
    setWebhookUrl: async ({ url }) => await setGitHubAppWebhookUrl(settings, { url, secret }),
  };
}

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
  const { installations, liveById, lifecycleVerified } = await readWorkspaceGitHubInstallations(
    deps,
    workspaceId,
  );
  for (const installation of installations) {
    // GitHub left this binding with no repositories. If the installation
    // shares some again and its webhook was missed, read them now so the
    // workspace recovers by itself.
    if (
      installation.repositoryIds.length === 0 &&
      githubInstallationLiveLifecycle(installation, liveById, lifecycleVerified) === "active"
    ) {
      void requestGitHubInstallationRepositorySync(deps, installation.installationId, {
        minIntervalMs: GITHUB_BACKGROUND_SYNC_INTERVAL_MS,
      });
    }
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

/** The workspace's stored bindings with GitHub's live view of each installation. */
async function readWorkspaceGitHubInstallations(
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<{
  installations: GitHubInstallationAccess[];
  liveById: Map<number, LiveGitHubInstallation | null>;
  lifecycleVerified: boolean;
}> {
  const installations = await listGitHubInstallationAccessForWorkspace(deps.db, workspaceId);
  if (installations.length === 0) {
    return { installations, liveById: new Map(), lifecycleVerified: false };
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
      // Each bound installation is read by id, never by paging through every
      // installation of the App.
      liveById = new Map(
        await Promise.all(
          installations.map(
            async (installation) =>
              [
                installation.installationId,
                await getGitHubAppInstallationSummary(deps.settings, installation.installationId),
              ] as const,
          ),
        ),
      );
      lifecycleVerified = true;
    }
  } catch {
    // A provider outage cannot make a stored row healthy. Preserve the row for
    // audit/unlink but project it as unverified and keep workspace status
    // unbound until GitHub can be checked again.
    liveById = new Map();
    lifecycleVerified = false;
  }
  return { installations, liveById, lifecycleVerified };
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
  return githubInstallationLiveLifecycle(
    { ...stored, installationId },
    liveById,
    lifecycleVerified,
  );
}

/**
 * The binding's lifecycle from its owner proof and GitHub's live view,
 * whatever its repository allowlist holds: an active binding follows GitHub's
 * repository list even when GitHub left it with none.
 */
function githubInstallationLiveLifecycle(
  stored: GitHubInstallationAccess,
  liveById: Map<number, LiveGitHubInstallation | null>,
  lifecycleVerified: boolean,
): GitHubInstallationBinding["lifecycle"] {
  const installationId = stored.installationId;
  if (!hasGitHubInstallationOwnerAuthority(stored)) {
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

/** One repository catalog per GitHub App source (host App or this deployment's). */
const repositoryCatalogs = new WeakMap<object, GitHubRepositoryCatalog>();

/**
 * Only an outage-like failure (GitHub 5xx, rate limit, timeout, network) is
 * answered with the last good list. Missing configuration or an installation
 * GitHub no longer grants (401, 403, 404) is reported as it happens.
 */
export function isTransientGitHubRepositoryListFailure(error: unknown): boolean {
  if (error instanceof GitHubAppConfigurationError) return false;
  if (error instanceof GitHubAppApiError && error.status !== null) {
    if (error.status === 403) return /rate limit/i.test(error.message);
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
}

function repositoryCatalogFor(deps: ApiRouteDeps): GitHubRepositoryCatalog {
  const source: object = deps.githubAppApi ?? deps.settings;
  let catalog = repositoryCatalogs.get(source);
  if (!catalog) {
    catalog = createGitHubRepositoryCatalog({
      serveStaleOn: isTransientGitHubRepositoryListFailure,
    });
    repositoryCatalogs.set(source, catalog);
  }
  return catalog;
}

/**
 * The GitHub repositories this workspace may use. Bindings and the workspace's
 * repository allowlist are read live every time; GitHub's own repository list
 * comes from a short-lived per-process catalog unless `fresh` is set (an
 * explicit sync), so passive reads survive a brief GitHub failure.
 *
 * The allowlist follows GitHub: a list GitHub just returned is applied to it
 * (repositories the installation now shares are added, ones it no longer
 * shares are dropped), so a missed webhook is repaired by the next listing.
 * A stale fallback list is never applied, and a failed update only means the
 * stored allowlist answers this read.
 */
export async function listWorkspaceGitHubRepositories(
  deps: ApiRouteDeps,
  workspaceId: string,
  options: { fresh?: boolean } = {},
): Promise<GitHubRepository[]> {
  const { installations, liveById, lifecycleVerified } = await readWorkspaceGitHubInstallations(
    deps,
    workspaceId,
  );
  const authorizedAccess = installations.filter(
    (installation) =>
      githubInstallationLiveLifecycle(installation, liveById, lifecycleVerified) === "active",
  );
  if (authorizedAccess.length === 0) {
    return [];
  }
  const installationIds = authorizedAccess.map((installation) => installation.installationId);
  // A (re)connect on any API replica rewrites the binding: a list fetched
  // before that may miss repositories the person just shared.
  const boundAt = Math.max(
    ...authorizedAccess.map((installation) => Date.parse(installation.updatedAt) || 0),
  );
  const host = deps.githubAppApi;
  const observed = await repositoryCatalogFor(deps).readObserved(
    installationIds,
    () =>
      host?.listRepositories
        ? host.listRepositories({ installationIds })
        : listGitHubAppRepositories(deps.settings, { installationIds }),
    { ...options, notBefore: boundAt, waitMs: GITHUB_PASSIVE_LIST_WAIT_MS },
  );
  const allowed = new Map(
    authorizedAccess.map((installation) => [
      installation.installationId,
      new Set(installation.repositoryIds),
    ]),
  );
  if (!observed.stale) {
    await followGitHubRepositoryLists(deps, authorizedAccess, observed, allowed);
  } else if (observed.pending) {
    // GitHub is slow: this read used the last good list; apply GitHub's
    // answer when it arrives so the next read has it.
    const pendingAllowed = new Map([...allowed].map(([id, ids]) => [id, new Set(ids)]));
    void observed.pending
      .then(async (answer) => {
        if (answer)
          await followGitHubRepositoryLists(deps, authorizedAccess, answer, pendingAllowed);
      })
      .catch(() => undefined);
  }
  return observed.repositories.filter(
    (repository) => allowed.get(repository.installationId)?.has(repository.id) === true,
  );
}

/**
 * Apply the lists GitHub just returned to the workspace's allowlists, only
 * where they differ, and update `allowed` with the result.
 */
async function followGitHubRepositoryLists(
  deps: ApiRouteDeps,
  bindings: GitHubInstallationAccess[],
  observed: { repositories: GitHubRepository[]; fetchedAt: number },
  allowed: Map<number, Set<number>>,
): Promise<void> {
  const listed = new Map<number, number[]>();
  for (const repository of observed.repositories) {
    const ids = listed.get(repository.installationId) ?? [];
    ids.push(repository.id);
    listed.set(repository.installationId, ids);
  }
  for (const binding of bindings) {
    const live = new Set(
      withoutRecentlyRemovedGitHubRepositories(
        deps,
        binding.installationId,
        listed.get(binding.installationId) ?? [],
        new Date(observed.fetchedAt),
      ),
    );
    const stored = allowed.get(binding.installationId) ?? new Set<number>();
    // GitHub also lists nothing for an installation suspended or removed
    // since the lifecycle check above; its webhook says which it was.
    if (live.size === 0) continue;
    if (live.size === stored.size && [...live].every((id) => stored.has(id))) continue;
    try {
      const result = await applyGitHubInstallationRepositoryObservation(deps.db, {
        accountId: binding.accountId,
        workspaceId: binding.workspaceId,
        installationId: binding.installationId,
        observation: {
          kind: "mirror",
          repositoryIds: [...live],
          observedAt: new Date(observed.fetchedAt),
        },
      });
      if (result) allowed.set(binding.installationId, new Set(result.repositoryIds));
      else allowed.delete(binding.installationId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "GitHub repository allowlist update failed",
          githubInstallationId: binding.installationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/**
 * The exact session repository resource for one workspace GitHub App
 * repository: its default branch, a canonical clone URI, and the installation
 * identity that platform-brokered Git auth and create-time validation check.
 */
export function githubRepositoryResourceRef(repository: GitHubRepository): RepositoryResourceRef {
  const uri = normalizedRepositoryUri(repository.cloneUrl);
  return {
    kind: "repository",
    uri,
    ref: repository.defaultBranch,
    provider: "github",
    mountPath: defaultRepositoryMountPath(uri, "github"),
    githubInstallationId: repository.installationId,
    githubRepositoryId: repository.id,
  };
}

function normalizedRepositoryUri(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return `https://${url.host.toLowerCase()}/${path}.git`;
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
