import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { artifactKey, type ArtifactCatalogFilters } from "./artifact-catalog";
import { retainArtifactsAfterRefreshFailure } from "./artifact-refresh";

const FRESH_FOR_MS = 30_000;
const MAX_CACHED_QUERIES = 40;
type CatalogClient = Pick<OpenGeniBrowserClient, "listArtifactCatalog">;
type CachedCatalog = {
  workspaceId: string;
  items: ArtifactCatalogItem[];
  nextCursor: string | null;
  updatedAt: number;
};

// Only metadata is cached; the client identity and credential generation keep
// different browser authorities from sharing results. No persistent storage.
const catalogs = new WeakMap<CatalogClient, Map<string, CachedCatalog>>();

function cachedCatalog(client: CatalogClient, key: string) {
  return catalogs.get(client)?.get(key);
}

function saveCatalog(client: CatalogClient, key: string, entry: CachedCatalog) {
  let cache = catalogs.get(client);
  if (!cache) {
    cache = new Map();
    catalogs.set(client, cache);
  }
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value!);
}

/** A successful local Site mutation makes every view of that workspace stale. */
export function invalidateArtifactCatalog(client: CatalogClient, workspaceId: string) {
  const cache = catalogs.get(client);
  if (!cache) return;
  for (const [key, entry] of cache) {
    if (entry.workspaceId === workspaceId) cache.delete(key);
  }
}

function isAccessFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  return error.status === 401 || error.status === 403 || error.status === 404;
}

/** Metadata-only query lifecycle, independent of app context and content runtimes. */
export function useArtifactCatalog(
  client: CatalogClient,
  workspaceId: string,
  filters: ArtifactCatalogFilters,
  accessKeyVersion: number,
) {
  const key = JSON.stringify([
    workspaceId,
    accessKeyVersion,
    filters.q.trim(),
    filters.kind,
    filters.sort,
    filters.status,
  ]);
  const [state, setState] = useState<{
    key: string;
    client: typeof client;
    items: ArtifactCatalogItem[];
    nextCursor: string | null;
    loading: boolean;
    error: Error | null;
  } | null>(null);
  // This stable controller is not a DOM ref. Cleanup invalidates pagination too.
  const requests = useRef({ generation: 0, active: false }).current;
  const load = useCallback(
    async (cursor?: string) => {
      if (cursor && requests.active) return;
      const request = ++requests.generation;
      requests.active = true;
      const cached = cachedCatalog(client, key);
      setState((previous) => ({
        key,
        client,
        items:
          previous?.key === key && previous.client === client
            ? previous.items
            : (cached?.items ?? []),
        nextCursor: cached?.nextCursor ?? null,
        loading: true,
        error: null,
      }));
      try {
        const result = await client.listArtifactCatalog(workspaceId, {
          q: filters.q.trim() || undefined,
          kind: filters.kind === "all" ? undefined : filters.kind,
          sort: filters.sort,
          status: filters.status,
          limit: 60,
          cursor,
        });
        if (requests.generation !== request) return;
        const items = cursor ? [...(cached?.items ?? []), ...result.items] : result.items;
        const nextItems = [...new Map(items.map((item) => [artifactKey(item), item])).values()];
        saveCatalog(client, key, {
          workspaceId,
          items: nextItems,
          nextCursor: result.nextCursor,
          updatedAt: cursor ? (cached?.updatedAt ?? Date.now()) : Date.now(),
        });
        setState({
          key,
          client,
          items: nextItems,
          nextCursor: result.nextCursor,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (requests.generation !== request) return;
        if (isAccessFailure(error)) invalidateArtifactCatalog(client, workspaceId);
        else if (!retainArtifactsAfterRefreshFailure(error)) catalogs.get(client)?.delete(key);
        setState((previous) => ({
          key,
          client,
          items: retainArtifactsAfterRefreshFailure(error)
            ? previous?.key === key && previous.client === client
              ? previous.items
              : (cached?.items ?? [])
            : [],
          nextCursor: retainArtifactsAfterRefreshFailure(error)
            ? (cursor ?? cached?.nextCursor ?? (previous?.key === key ? previous.nextCursor : null))
            : null,
          loading: false,
          error: error instanceof Error ? error : new Error("Artifacts could not be loaded."),
        }));
      } finally {
        if (requests.generation === request) requests.active = false;
      }
    },
    [client, workspaceId, key, requests, filters.kind, filters.status, filters.q, filters.sort],
  );
  useEffect(() => {
    const cached = cachedCatalog(client, key);
    if (cached && Date.now() - cached.updatedAt < FRESH_FOR_MS) {
      setState({
        key,
        client,
        items: cached.items,
        nextCursor: cached.nextCursor,
        loading: false,
        error: null,
      });
    } else {
      void load();
    }
    const refreshOnReturn = () => {
      const current = cachedCatalog(client, key);
      if (!requests.active && (!current || Date.now() - current.updatedAt >= FRESH_FOR_MS))
        void load();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshOnReturn();
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    // Keep an open tab current too, even if the user never changes views.
    const interval = window.setInterval(refreshWhenVisible, FRESH_FOR_MS);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      requests.generation++;
      requests.active = false;
    };
  }, [client, key, load, requests]);
  const cached = cachedCatalog(client, key);
  const current =
    state?.key === key && state.client === client
      ? state
      : cached
        ? {
            key,
            client,
            items: cached.items,
            nextCursor: cached.nextCursor,
            loading: false,
            error: null,
          }
        : null;
  return {
    items: current?.items ?? [],
    loading: current?.loading ?? true,
    error: current?.error ?? null,
    nextCursor: current?.nextCursor ?? null,
    retry: () => void load(),
    loadMore: () => {
      if (current?.nextCursor) void load(current.nextCursor);
    },
  };
}
