import { useLayoutEffect, useRef } from "react";
import type { ArtifactCatalogFilters } from "./artifact-catalog";
import { defaultArtifactFilters } from "./artifact-catalog";
import type { ArtifactReturnSearch } from "./routes";

/** The same query travels with the library and every type-specific viewer. */
export function artifactLibraryFilters(search: ArtifactReturnSearch): ArtifactCatalogFilters {
  return {
    q: search.q ?? defaultArtifactFilters.q,
    kind: search.kind ?? defaultArtifactFilters.kind,
    sort: search.sort ?? defaultArtifactFilters.sort,
    status: search.status ?? defaultArtifactFilters.status,
  };
}

export function artifactLibrarySearch(
  filters: ArtifactCatalogFilters,
  fromSession?: string,
  browse = false,
): ArtifactReturnSearch {
  return {
    ...(fromSession ? { fromSession } : {}),
    ...(filters.kind !== "all" ? { kind: filters.kind } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.sort !== "updated" ? { sort: filters.sort } : {}),
    ...(filters.status !== "active" ? { status: filters.status } : {}),
    ...(browse ? { browse: true } : {}),
  };
}

type LibraryPosition = { top: number; pages: number };
// Never share a previous viewer's list position or loaded-page count with a
// different client, workspace or credential generation. Metadata stays in the
// existing catalog cache; this bounded store holds only presentation state.
const positions = new WeakMap<object, Map<string, LibraryPosition>>();
const MAX_POSITIONS = 40;

export function artifactLibraryPositionKey(
  workspaceId: string,
  accessKeyVersion: number,
  filters: ArtifactCatalogFilters,
) {
  return JSON.stringify([workspaceId, accessKeyVersion, filters]);
}

export function readArtifactLibraryPosition(client: object, key: string): LibraryPosition {
  return positions.get(client)?.get(key) ?? { top: 0, pages: 1 };
}

export function rememberArtifactLibraryPosition(
  client: object,
  key: string,
  value: LibraryPosition,
) {
  let cache = positions.get(client);
  if (!cache) {
    cache = new Map();
    positions.set(client, cache);
  }
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_POSITIONS) cache.delete(cache.keys().next().value!);
}

/** Restore only after retained pages are ready, so a partial list cannot clamp scrollTop. */
export function useArtifactLibraryPosition(
  client: object,
  key: string,
  loading: boolean,
  itemCount: number,
  pages: number,
) {
  const ref = useRef<HTMLDivElement>(null);
  const restored = useRef<{ client: object; key: string } | null>(null);
  const isRestored = restored.current?.client === client && restored.current.key === key;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || isRestored || loading) return;
    element.scrollTop = readArtifactLibraryPosition(client, key).top;
    restored.current = { client, key };
  }, [client, key, loading, itemCount, isRestored]);
  const remember = () => {
    if (
      loading ||
      restored.current?.client !== client ||
      restored.current.key !== key ||
      !ref.current
    )
      return;
    rememberArtifactLibraryPosition(client, key, { top: ref.current.scrollTop, pages });
  };
  useLayoutEffect(() => {
    // Keep pagination even if appending a page does not cause a scroll event.
    if (
      !loading &&
      restored.current?.client === client &&
      restored.current.key === key &&
      ref.current
    )
      rememberArtifactLibraryPosition(client, key, { top: ref.current.scrollTop, pages });
  }, [client, key, pages, loading, itemCount]);
  return { ref, onScroll: remember };
}
