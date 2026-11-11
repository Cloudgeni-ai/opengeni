import type { ArtifactCatalogItem } from "@opengeni/sdk";

export type CachedArtifactCatalog = {
  workspaceId: string;
  items: ArtifactCatalogItem[];
  nextCursor: string | null;
  /** Pages loaded so far, so a refresh reloads everything already shown. */
  pages: number;
  updatedAt: number;
};

// In-memory catalog metadata only, never persisted. Keying by client identity
// keeps different browser authorities from sharing results. Kept apart from the
// hook so the session view can mark catalogs stale without loading it; keep
// this module minimal, it ships in the direct session bundle.
export const artifactCatalogs = new WeakMap<object, Map<string, CachedArtifactCatalog>>();

/** Keep cached rows for an instant revisit, but refetch them on the next view. */
export function expireArtifactCatalog(client: object, workspaceId: string) {
  for (const entry of artifactCatalogs.get(client)?.values() ?? []) {
    if (entry.workspaceId === workspaceId) entry.updatedAt = 0;
  }
}
