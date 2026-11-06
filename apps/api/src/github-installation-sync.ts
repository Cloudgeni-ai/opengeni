import type { GitHubRepository } from "@opengeni/contracts";
import type { ApiRouteDeps, VerifiedGitHubDelivery } from "@opengeni/core";
import {
  applyGitHubInstallationRepositoryObservation,
  listGitHubInstallationBindingWorkspaces,
  type GitHubInstallationRepositoryObservation,
} from "@opengeni/db";
import {
  getGitHubAppInstallationSummary,
  githubAppMissingSettings,
  listGitHubAppRepositories,
} from "@opengeni/github";

/**
 * Workspace GitHub App repository allowlists follow GitHub.
 *
 * An owner binds an installation once, with an owner-authority proof; from
 * then on the workspace may use the repositories the installation shares, as
 * GitHub reports them. A repository added to the installation (including a
 * new repository of an "All repositories" installation) becomes available
 * without reconnecting; one removed from it stops being available at once.
 *
 * GitHub tells Opengeni in two ways, and either repairs the other:
 * - the App's webhooks (`installation_repositories`, `installation`,
 *   `repository`), handled by `handleVerifiedGitHubAppDelivery`;
 * - every repository listing, which already reads GitHub's live list
 *   (`listWorkspaceGitHubRepositories`) and applies it.
 *
 * Removals reported by GitHub apply immediately. Each binding stores a
 * short-lived removal marker in the database, so a list read soon after (on
 * any API replica) never adds the repository back while GitHub's list still
 * lags its webhook; a repository shared again shows up once the hold ends. Additions are never taken from a webhook body: the
 * installation's complete list is read from GitHub, once per installation at
 * a time, and applied with an ordering fence.
 */

type InstallationRepositorySource = {
  /** undefined when the provider cannot report the installation's state. */
  installation: (installationId: number) => Promise<{ suspended: boolean } | null | undefined>;
  repositories: (installationId: number) => Promise<GitHubRepository[]>;
};

function installationRepositorySource(deps: ApiRouteDeps): InstallationRepositorySource | null {
  const host = deps.githubAppApi;
  if (host) {
    const { getInstallation, listRepositories } = host;
    if (!listRepositories) return null;
    return {
      installation: async (installationId) =>
        getInstallation ? await getInstallation({ installationId }) : undefined,
      repositories: async (installationId) =>
        await listRepositories({ installationIds: [installationId] }),
    };
  }
  if (githubAppMissingSettings(deps.settings).length > 0) return null;
  return {
    installation: async (installationId) =>
      await getGitHubAppInstallationSummary(deps.settings, installationId),
    repositories: async (installationId) =>
      await listGitHubAppRepositories(deps.settings, { installationIds: [installationId] }),
  };
}

function warn(message: string, installationId: number, error?: unknown): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      message,
      githubInstallationId: installationId,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    }),
  );
}

function githubAppSourceKey(deps: ApiRouteDeps): object {
  return deps.githubAppApi ?? deps.settings;
}

async function applyToBoundWorkspaces(
  deps: ApiRouteDeps,
  installationId: number,
  observation: GitHubInstallationRepositoryObservation,
  workspaces?: Array<{ accountId: string; workspaceId: string }>,
): Promise<void> {
  const targets =
    workspaces ?? (await listGitHubInstallationBindingWorkspaces(deps.db, installationId));
  for (const target of targets) {
    try {
      await applyGitHubInstallationRepositoryObservation(deps.db, {
        ...target,
        installationId,
        observation,
      });
    } catch (error) {
      warn("GitHub repository allowlist update failed", installationId, error);
    }
  }
}

/** Read the installation's complete repository list from GitHub and apply it. */
async function syncInstallationOnce(deps: ApiRouteDeps, installationId: number): Promise<void> {
  const workspaces = await listGitHubInstallationBindingWorkspaces(deps.db, installationId);
  if (workspaces.length === 0) return;
  const source = installationRepositorySource(deps);
  if (!source) return;
  // Taken before GitHub is asked: a list is only as new as its request.
  const observedAt = new Date();
  const live = await source.installation(installationId);
  // A suspended or missing installation is already unusable through the
  // binding's live lifecycle check; its allowlist is kept for when it returns.
  if (live === null || live?.suspended) return;
  const repositories = (await source.repositories(installationId)).filter(
    (repository) => repository.installationId === installationId,
  );
  if (repositories.length === 0) {
    // GitHub lists nothing for an installation it just suspended or removed
    // as well, and a provider may answer an empty list for a failure: only an
    // installation GitHub confirms is still live really shares nothing.
    const after = await source.installation(installationId);
    if (!after || after.suspended) return;
  }
  await applyToBoundWorkspaces(
    deps,
    installationId,
    { kind: "mirror", repositoryIds: repositories.map((repository) => repository.id), observedAt },
    workspaces,
  );
}

type SyncState = { promise: Promise<void>; again: boolean };
/** In-flight syncs per GitHub App source and installation. */
const inFlightSyncs = new WeakMap<object, Map<number, SyncState>>();
/** When each installation's last sync started, per GitHub App source. */
const lastSyncStarts = new WeakMap<object, Map<number, number>>();
const LAST_SYNC_STARTS_MAX = 10_000;
const allInFlight = new Set<Promise<void>>();

/**
 * Read one installation's repositories from GitHub and apply them to every
 * workspace bound to it. One sync per installation runs at a time; requests
 * made while it runs share a single follow-up run, so a burst of webhooks
 * costs at most two GitHub reads. Never rejects: a failure is logged and the
 * next webhook or repository listing repairs the allowlist.
 *
 * `minIntervalMs` is for reads nobody asked GitHub about (a page load): it
 * skips the sync when one started that recently. Webhooks always sync.
 */
export function requestGitHubInstallationRepositorySync(
  deps: ApiRouteDeps,
  installationId: number,
  options: { minIntervalMs?: number } = {},
): Promise<void> {
  const sourceKey = githubAppSourceKey(deps);
  let byInstallation = inFlightSyncs.get(sourceKey);
  if (!byInstallation) {
    byInstallation = new Map();
    inFlightSyncs.set(sourceKey, byInstallation);
  }
  let starts = lastSyncStarts.get(sourceKey);
  if (!starts) {
    starts = new Map();
    lastSyncStarts.set(sourceKey, starts);
  }
  const running = byInstallation.get(installationId);
  if (options.minIntervalMs !== undefined) {
    const lastStart = starts.get(installationId);
    if (running) return running.promise;
    if (lastStart !== undefined && Date.now() - lastStart < options.minIntervalMs) {
      return Promise.resolve();
    }
  }
  if (running) {
    running.again = true;
    return running.promise;
  }
  const state: SyncState = { promise: Promise.resolve(), again: false };
  const map = byInstallation;
  const startTimes = starts;
  state.promise = (async () => {
    try {
      do {
        state.again = false;
        startTimes.delete(installationId);
        startTimes.set(installationId, Date.now());
        if (startTimes.size > LAST_SYNC_STARTS_MAX) {
          const oldest = startTimes.keys().next().value;
          if (oldest !== undefined) startTimes.delete(oldest);
        }
        try {
          await syncInstallationOnce(deps, installationId);
        } catch (error) {
          warn("GitHub repository sync failed", installationId, error);
        }
      } while (state.again);
    } finally {
      map.delete(installationId);
    }
  })();
  map.set(installationId, state);
  allInFlight.add(state.promise);
  void state.promise.finally(() => allInFlight.delete(state.promise));
  return state.promise;
}

/** Wait for every repository sync this process has started (tests). */
export async function settleGitHubInstallationRepositorySyncs(): Promise<void> {
  while (allInFlight.size > 0) await Promise.all([...allInFlight]);
}

function repositoryIdsAt(payload: Record<string, unknown>, key: string): number[] {
  const list = payload[key];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const id = item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? [id] : [];
  });
}

function repositoryIdOf(payload: Record<string, unknown>): number | null {
  const repository = payload.repository;
  const id =
    repository && typeof repository === "object"
      ? (repository as Record<string, unknown>).id
      : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Events that may change which repositories an installation shares. */
const RESYNC_INSTALLATION_ACTIONS = new Set(["created", "new_permissions_accepted", "unsuspend"]);
const RESYNC_REPOSITORY_ACTIONS = new Set(["created", "transferred"]);

/**
 * Keep bound workspaces' repository allowlists in line with one verified
 * delivery from the App. Removals apply before this returns; the complete
 * list is re-read from GitHub in the background. Never throws.
 */
export async function handleVerifiedGitHubAppDelivery(
  deps: ApiRouteDeps,
  delivery: VerifiedGitHubDelivery,
): Promise<void> {
  const { installationId, payload } = delivery;
  if (installationId === null) return;
  const action = typeof payload.action === "string" ? payload.action : "";
  try {
    let removal: readonly number[] | "all" | null = null;
    let resync = false;
    if (delivery.event === "installation_repositories") {
      const removed = repositoryIdsAt(payload, "repositories_removed");
      if (removed.length > 0) removal = removed;
      resync = true;
    } else if (delivery.event === "installation") {
      if (action === "deleted") removal = "all";
      resync = RESYNC_INSTALLATION_ACTIONS.has(action);
    } else if (delivery.event === "repository") {
      const repositoryId = repositoryIdOf(payload);
      if (action === "deleted" && repositoryId !== null) removal = [repositoryId];
      resync = RESYNC_REPOSITORY_ACTIONS.has(action);
    } else {
      return;
    }
    if (removal) {
      await applyToBoundWorkspaces(deps, installationId, {
        kind: "remove",
        repositoryIds: removal,
        observedAt: delivery.receivedAt,
      });
    }
    if (resync) void requestGitHubInstallationRepositorySync(deps, installationId);
  } catch (error) {
    warn("GitHub webhook repository update failed", installationId, error);
  }
}
