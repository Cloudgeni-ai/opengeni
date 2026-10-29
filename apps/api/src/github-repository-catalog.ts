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
 * failure. A list fetched before the workspace's binding last changed
 * (`notBefore`, e.g. a reconnect on any API replica) is never reused.
 *
 * Only GitHub's metadata is kept. The caller still decides, on every read,
 * which installations are active and which repositories the workspace may
 * use, so a binding or allowlist change applies immediately.
 */
export type GitHubRepositoryCatalog = {
  read(
    installationIds: readonly number[],
    load: () => Promise<GitHubRepository[]>,
    options?: GitHubRepositoryCatalogReadOptions,
  ): Promise<GitHubRepository[]>;
};

export type GitHubRepositoryCatalogReadOptions = {
  /** Ask GitHub now and report its failure (an explicit sync). */
  fresh?: boolean;
  /** Epoch ms: lists fetched before this are out of date for this read. */
  notBefore?: number;
};

export type GitHubRepositoryCatalogOptions = {
  /** How long a fetched list answers passive reads without asking GitHub. */
  freshMs?: number;
  /** How long the last good list may answer a passive read GitHub failed. */
  staleIfErrorMs?: number;
  /** Installation sets kept per process; the oldest is dropped first. */
  maxEntries?: number;
  /**
   * Whether a failure may be answered with the last good list. Defaults to
   * every failure; callers pass a transient-only check so a removed
   * installation or broken configuration is reported, not hidden.
   */
  serveStaleOn?: (error: unknown) => boolean;
  now?: () => number;
};

export const GITHUB_REPOSITORY_CATALOG_FRESH_MS = 60_000;
export const GITHUB_REPOSITORY_CATALOG_STALE_IF_ERROR_MS = 30 * 60_000;
const GITHUB_REPOSITORY_CATALOG_MAX_ENTRIES = 500;

type Entry = { repositories: GitHubRepository[]; fetchedAt: number };
type Pending = { request: Promise<GitHubRepository[]>; startedAt: number };

export function createGitHubRepositoryCatalog(
  options: GitHubRepositoryCatalogOptions = {},
): GitHubRepositoryCatalog {
  const freshMs = options.freshMs ?? GITHUB_REPOSITORY_CATALOG_FRESH_MS;
  const staleIfErrorMs = Math.max(
    freshMs,
    options.staleIfErrorMs ?? GITHUB_REPOSITORY_CATALOG_STALE_IF_ERROR_MS,
  );
  const maxEntries = Math.max(1, options.maxEntries ?? GITHUB_REPOSITORY_CATALOG_MAX_ENTRIES);
  const serveStaleOn = options.serveStaleOn ?? (() => true);
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Pending>();

  /** An entry past the stale window is of no use to any read. */
  function usable(key: string): Entry | undefined {
    const entry = entries.get(key);
    if (entry && now() - entry.fetchedAt >= staleIfErrorMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function remember(key: string, repositories: GitHubRepository[], fetchedAt: number): void {
    entries.delete(key);
    entries.set(key, { repositories, fetchedAt });
    const at = now();
    for (const [candidate, entry] of entries) {
      if (at - entry.fetchedAt >= staleIfErrorMs) entries.delete(candidate);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  async function fetchAndRemember(
    key: string,
    load: () => Promise<GitHubRepository[]>,
    startedAt: number,
  ): Promise<GitHubRepository[]> {
    const repositories = await load();
    // A slower, older fetch never replaces a newer list.
    const current = entries.get(key);
    if (!current || current.fetchedAt <= startedAt) remember(key, repositories, startedAt);
    return repositories;
  }

  /**
   * Passive reads of one installation set share a single GitHub call, unless
   * it began before the binding the reader knows about.
   */
  function fetchShared(
    key: string,
    load: () => Promise<GitHubRepository[]>,
    notBefore: number,
  ): Promise<GitHubRepository[]> {
    const pending = inFlight.get(key);
    if (pending && pending.startedAt >= notBefore) return pending.request;
    const startedAt = now();
    const request = fetchAndRemember(key, load, startedAt).finally(() => {
      if (inFlight.get(key)?.request === request) inFlight.delete(key);
    });
    inFlight.set(key, { request, startedAt });
    return request;
  }

  return {
    async read(installationIds, load, readOptions = {}) {
      const key = [...new Set(installationIds)].sort((left, right) => left - right).join(",");
      // A sync asks GitHub itself, never a fetch that began before it.
      if (readOptions.fresh) return await fetchAndRemember(key, load, now());
      const notBefore = readOptions.notBefore ?? Number.NEGATIVE_INFINITY;
      const cached = usable(key);
      if (cached && cached.fetchedAt >= notBefore && now() - cached.fetchedAt < freshMs) {
        return cached.repositories;
      }
      try {
        return await fetchShared(key, load, notBefore);
      } catch (error) {
        const fallback = usable(key);
        if (fallback && serveStaleOn(error)) return fallback.repositories;
        throw error;
      }
    },
  };
}
