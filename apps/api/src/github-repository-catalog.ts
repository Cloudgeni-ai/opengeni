import type { GitHubRepository } from "@opengeni/contracts";

/**
 * GitHub's repository list for a set of App installations, kept briefly per
 * API process.
 *
 * The web app reads the workspace's repositories on every load and every time
 * its window comes back into focus. Each read used to sign an App JWT, list
 * every installation, mint an installation token and page through the
 * repositories on GitHub (2-4 s), and any GitHub hiccup became a 502 for a
 * read nobody asked to be live. Passive reads now reuse a list fetched in the
 * last `freshMs`, share one GitHub call while it is in flight, and keep
 * serving the last good list for up to `staleIfErrorMs` when GitHub fails.
 * An explicit sync (`fresh: true`) always goes to GitHub and reports its
 * failure.
 *
 * Only GitHub's metadata is kept. The caller still decides, on every read,
 * which installations are active and which repositories the workspace may
 * use, so a binding or allowlist change applies immediately.
 */
export type GitHubRepositoryCatalog = {
  read(
    installationIds: readonly number[],
    load: () => Promise<GitHubRepository[]>,
    options?: { fresh?: boolean },
  ): Promise<GitHubRepository[]>;
};

export type GitHubRepositoryCatalogOptions = {
  /** How long a fetched list answers passive reads without asking GitHub. */
  freshMs?: number;
  /** How long the last good list may answer a passive read GitHub failed. */
  staleIfErrorMs?: number;
  /** Installation sets kept per process; the oldest is dropped first. */
  maxEntries?: number;
  now?: () => number;
};

export const GITHUB_REPOSITORY_CATALOG_FRESH_MS = 60_000;
export const GITHUB_REPOSITORY_CATALOG_STALE_IF_ERROR_MS = 30 * 60_000;
const GITHUB_REPOSITORY_CATALOG_MAX_ENTRIES = 500;

type Entry = { repositories: GitHubRepository[]; fetchedAt: number };

export function createGitHubRepositoryCatalog(
  options: GitHubRepositoryCatalogOptions = {},
): GitHubRepositoryCatalog {
  const freshMs = options.freshMs ?? GITHUB_REPOSITORY_CATALOG_FRESH_MS;
  const staleIfErrorMs = options.staleIfErrorMs ?? GITHUB_REPOSITORY_CATALOG_STALE_IF_ERROR_MS;
  const maxEntries = Math.max(1, options.maxEntries ?? GITHUB_REPOSITORY_CATALOG_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<GitHubRepository[]>>();

  function remember(key: string, repositories: GitHubRepository[], fetchedAt: number): void {
    entries.delete(key);
    entries.set(key, { repositories, fetchedAt });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  async function fetchAndRemember(
    key: string,
    load: () => Promise<GitHubRepository[]>,
  ): Promise<GitHubRepository[]> {
    const startedAt = now();
    const repositories = await load();
    // A slower, older fetch never replaces a newer list.
    const current = entries.get(key);
    if (!current || current.fetchedAt <= startedAt) remember(key, repositories, startedAt);
    return repositories;
  }

  /** Passive reads of one installation set share a single GitHub call. */
  function fetchShared(
    key: string,
    load: () => Promise<GitHubRepository[]>,
  ): Promise<GitHubRepository[]> {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const request = fetchAndRemember(key, load).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, request);
    return request;
  }

  return {
    async read(installationIds, load, readOptions = {}) {
      const key = [...new Set(installationIds)].sort((left, right) => left - right).join(",");
      // A sync asks GitHub itself, never a fetch that began before it.
      if (readOptions.fresh) return await fetchAndRemember(key, load);
      const cached = entries.get(key);
      if (cached && now() - cached.fetchedAt < freshMs) return cached.repositories;
      try {
        return await fetchShared(key, load);
      } catch (error) {
        const fallback = entries.get(key);
        if (fallback && now() - fallback.fetchedAt < staleIfErrorMs) return fallback.repositories;
        throw error;
      }
    },
  };
}
