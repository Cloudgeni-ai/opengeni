import type { ArtifactCatalogItem } from "@opengeni/sdk";

export type ArtifactKind = ArtifactCatalogItem["kind"];
export function isEditableArtifactKind(
  kind: string,
): kind is "document" | "spreadsheet" | "presentation" {
  return kind === "document" || kind === "spreadsheet" || kind === "presentation";
}
export type ArtifactCatalogFilters = {
  q: string;
  kind: ArtifactKind | "all";
  sort: "updated" | "newest" | "title";
  status: "active" | "archived";
};
export const defaultArtifactFilters: ArtifactCatalogFilters = {
  q: "",
  kind: "all",
  sort: "updated",
  status: "active",
};
export const artifactKinds = [
  ["all", "All"],
  ["site", "Sites"],
  ["image", "Images"],
  ["document", "Documents"],
  ["spreadsheet", "Spreadsheets"],
  ["presentation", "Presentations"],
  ["file", "Other"],
] as const;
export const artifactKindLabel: Record<ArtifactKind, string> = {
  site: "Site",
  image: "Image",
  document: "Document",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  file: "File",
};
export const artifactKey = (item: { kind: ArtifactKind; id: string }) => `${item.kind}:${item.id}`;
export function artifactRoute(kind: ArtifactKind) {
  if (kind === "site") return "/workspaces/$workspaceId/artifacts/$artifactId" as const;
  if (kind === "image" || kind === "file")
    return "/workspaces/$workspaceId/artifacts/files/$artifactId" as const;
  return "/workspaces/$workspaceId/artifacts/editable/$artifactId" as const;
}

export function filterArtifactCatalog(
  items: readonly ArtifactCatalogItem[],
  filters: ArtifactCatalogFilters,
) {
  const query = filters.q.trim().toLocaleLowerCase();
  return items
    .filter(
      (item) =>
        item.status === filters.status &&
        (filters.kind === "all" || item.kind === filters.kind) &&
        (!query || item.title.toLocaleLowerCase().includes(query)),
    )
    .sort((a, b) => {
      const order =
        filters.sort === "title"
          ? a.title.localeCompare(b.title)
          : filters.sort === "newest"
            ? b.createdAt.localeCompare(a.createdAt)
            : b.updatedAt.localeCompare(a.updatedAt);
      return order || artifactKey(a).localeCompare(artifactKey(b));
    });
}

export const ARTIFACT_VIEW_KEY = "opengeni:artifact-library:view:v1";
export function readArtifactView(): "grid" | "list" {
  try {
    return localStorage.getItem(ARTIFACT_VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}
export function rememberArtifactView(view: "grid" | "list") {
  try {
    localStorage.setItem(ARTIFACT_VIEW_KEY, view);
  } catch {
    /* Storage may be disabled. */
  }
}
