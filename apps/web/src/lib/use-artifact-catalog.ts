import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { artifactKey, type ArtifactCatalogFilters } from "./artifact-catalog";
import { retainArtifactsAfterRefreshFailure } from "./artifact-refresh";

/** Metadata-only query lifecycle, independent of app context and content runtimes. */
export function useArtifactCatalog(
  client: Pick<OpenGeniBrowserClient, "listArtifactCatalog">,
  workspaceId: string,
  filters: ArtifactCatalogFilters,
  accessKeyVersion: number,
) {
  const key = JSON.stringify([workspaceId, accessKeyVersion, filters]);
  const [retry, setRetry] = useState(0);
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
      setState((previous) => ({
        key,
        client,
        items: previous?.key === key && previous.client === client ? previous.items : [],
        nextCursor: cursor ?? null,
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
        setState((previous) => {
          const items =
            cursor && previous?.key === key && previous.client === client
              ? [...previous.items, ...result.items]
              : result.items;
          return {
            key,
            client,
            items: [...new Map(items.map((item) => [artifactKey(item), item])).values()],
            nextCursor: result.nextCursor,
            loading: false,
            error: null,
          };
        });
      } catch (error) {
        if (requests.generation !== request) return;
        setState((previous) => ({
          key,
          client,
          items:
            previous?.key === key &&
            previous.client === client &&
            retainArtifactsAfterRefreshFailure(error)
              ? previous.items
              : [],
          nextCursor: cursor ?? null,
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
    void load();
    return () => {
      requests.generation++;
      requests.active = false;
    };
  }, [load, retry, requests]);
  const current = state?.key === key && state.client === client ? state : null;
  return {
    items: current?.items ?? [],
    loading: current?.loading ?? true,
    error: current?.error ?? null,
    nextCursor: current?.nextCursor ?? null,
    retry: () => setRetry((value) => value + 1),
    loadMore: () => {
      if (current?.nextCursor) void load(current.nextCursor);
    },
  };
}
