import type { RetainedArtifactReference } from "./types";

export type ArtifactCatalogKind =
  | "site"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "image"
  | "file";

/** Native IDs are unique within a kind; use `${kind}:${id}` as a UI key. */
export type ArtifactCatalogItem = {
  id: string;
  kind: ArtifactCatalogKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "archived";
  /** Shared workspace pin; absent on older servers. Never grants content access. */
  pinned?: boolean;
  /** Present only when the viewer can read this session. */
  sourceSessionId?: string;
  versionId?: string;
  file?: RetainedArtifactReference;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
};

export type ArtifactCatalogListOptions = {
  sourceSessionId?: string;
  q?: string;
  kind?: ArtifactCatalogKind;
  sort?: "updated" | "newest" | "title";
  status?: "active" | "archived";
  limit?: number;
  cursor?: string;
};

export type ArtifactCatalogListResponse = {
  items: ArtifactCatalogItem[];
  nextCursor: string | null;
};

export type ArtifactPinResponse = {
  kind: ArtifactCatalogKind;
  artifactId: string;
  pinned: boolean;
};
