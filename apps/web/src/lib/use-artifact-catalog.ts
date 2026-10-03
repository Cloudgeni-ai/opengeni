import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { artifactKey, type ArtifactCatalogFilters } from "./artifact-catalog";
import { artifactCatalogs, type CachedArtifactCatalog } from "./artifact-catalog-cache";
import { retainArtifactsAfterRefreshFailure } from "./artifact-refresh";

const FRESH_FOR_MS = 30_000;
const MAX_CACHED_QUERIES = 40;
type CatalogClient = Pick<OpenGeniBrowserClient, "listArtifactCatalog">;
type CatalogPages = Pick<CachedArtifactCatalog, "items" | "nextCursor" | "pages">;

/** Drop every cached view of a workspace, e.g. after a Site mutation. */
export function invalidateArtifactCatalog(client: object, workspaceId: string) {
  for (const [key, entry] of artifactCatalogs.get(client) ?? []) {
    if (entry.workspaceId === workspaceId) artifactCatalogs.get(client)!.delete(key);
  }
}

function saveCatalog(client: CatalogClient, key: string, entry: CachedArtifactCatalog) {
  let cache = artifactCatalogs.get(client);
  if (!cache) {
    cache = new Map();
    artifactCatalogs.set(client, cache);
  }
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value!);
}

const isFresh = (entry: CachedArtifactCatalog | undefined) =>
  !!entry && Date.now() - entry.updatedAt < FRESH_FOR_MS;

function isAccessFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  return error.status === 401 || error.status === 403 || error.status === 404;
}

const uniqueItems = (items: ArtifactCatalogItem[]) => [
  ...new Map(items.map((item) => [artifactKey(item), item])).values(),
];

/**
 * Metadata-only query lifecycle, independent of app context and content runtimes.
 * Views are cached per client, workspace and filters, so tab switches and revisits
 * render immediately; a view older than FRESH_FOR_MS refetches on revisit or focus.
 */
export function useArtifactCatalog(
  client: CatalogClient,
  workspaceId: string,
  filters: ArtifactCatalogFilters,
  accessKeyVersion: number,
) {
  const q = filters.q.trim();
  const { kind, sort, status } = filters;
  const key = JSON.stringify([workspaceId, accessKeyVersion, q, kind, sort, status]);
  const [state, setState] = useState<
    | (CatalogPages & {
        key: string;
        client: CatalogClient;
        loading: boolean;
        error: Error | null;
      })
    | null
  >(null);
  // This stable controller is not a DOM ref. Cleanup invalidates pagination too.
  const requests = useRef({
    generation: 0,
    active: false,
    shown: null as (CatalogPages & { key: string; client: CatalogClient }) | null,
  }).current;
  const load = useCallback(
    async (more = false) => {
      const shown =
        requests.shown?.key === key && requests.shown.client === client ? requests.shown : null;
      if (more && (requests.active || !shown?.nextCursor)) return;
      const request = ++requests.generation;
      requests.active = true;
      setState({
        key,
        client,
        items: shown?.items ?? [],
        nextCursor: shown?.nextCursor ?? null,
        pages: shown?.pages ?? 0,
        loading: true,
        error: null,
      });
      const fetchPage = (cursor?: string) =>
        client.listArtifactCatalog(workspaceId, {
          q: q || undefined,
          kind: kind === "all" ? undefined : kind,
          sort,
          status,
          limit: 60,
          cursor,
        });
      try {
        let next: CatalogPages;
        if (more && shown) {
          const page = await fetchPage(shown.nextCursor!);
          next = {
            items: uniqueItems([...shown.items, ...page.items]),
            nextCursor: page.nextCursor,
            pages: shown.pages + 1,
          };
        } else {
          // Refetch every page already shown, so a refresh after "Load more"
          // updates the whole list instead of collapsing it to the first page.
          const items: ArtifactCatalogItem[] = [];
          let nextCursor: string | null = null;
          let pages = 0;
          do {
            const page = await fetchPage(nextCursor ?? undefined);
            if (requests.generation !== request) return;
            items.push(...page.items);
            nextCursor = page.nextCursor;
            pages++;
          } while (nextCursor && pages < (shown?.pages ?? 1));
          next = { items: uniqueItems(items), nextCursor, pages };
        }
        if (requests.generation !== request) return;
        const cached = artifactCatalogs.get(client)?.get(key);
        saveCatalog(client, key, {
          workspaceId,
          ...next,
          // Appending a page does not refresh the pages already shown.
          updatedAt: more ? (cached?.updatedAt ?? 0) : Date.now(),
        });
        requests.shown = { key, client, ...next };
        setState({ key, client, ...next, loading: false, error: null });
      } catch (error) {
        if (requests.generation !== request) return;
        const retain = retainArtifactsAfterRefreshFailure(error);
        if (isAccessFailure(error)) invalidateArtifactCatalog(client, workspaceId);
        else if (!retain) artifactCatalogs.get(client)?.delete(key);
        if (!retain) requests.shown = null;
        setState({
          key,
          client,
          items: retain ? (shown?.items ?? []) : [],
          nextCursor: retain ? (shown?.nextCursor ?? null) : null,
          pages: retain ? (shown?.pages ?? 0) : 0,
          loading: false,
          error: error instanceof Error ? error : new Error("Artifacts could not be loaded."),
        });
      } finally {
        if (requests.generation === request) requests.active = false;
      }
    },
    [client, workspaceId, key, requests, q, kind, sort, status],
  );
  useEffect(() => {
    const cached = artifactCatalogs.get(client)?.get(key);
    requests.shown = cached ? { key, client, ...cached } : null;
    if (cached && isFresh(cached)) {
      setState({ key, client, ...cached, loading: false, error: null });
    } else {
      void load();
    }
    const refreshIfStale = () => {
      if (document.visibilityState === "hidden" || requests.active) return;
      if (!isFresh(artifactCatalogs.get(client)?.get(key))) void load();
    };
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
      requests.generation++;
      requests.active = false;
    };
  }, [client, key, load, requests]);
  // Before the effect runs for a new view, show its cached rows instead of a spinner.
  const cached = artifactCatalogs.get(client)?.get(key);
  const current =
    state?.key === key && state.client === client
      ? state
      : cached
        ? { ...cached, loading: false, error: null }
        : null;
  return {
    items: current?.items ?? [],
    loading: current?.loading ?? true,
    error: current?.error ?? null,
    nextCursor: current?.nextCursor ?? null,
    retry: () => void load(),
    loadMore: () => void load(true),
  };
}
