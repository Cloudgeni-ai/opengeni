import type {
  ArtifactCatalogItem,
  ArtifactCatalogListOptions,
  RetainedArtifactReference,
} from "@opengeni/sdk";
import type { AppContextValue } from "../src/context";
import { filterArtifactCatalog, defaultArtifactFilters } from "../src/lib/artifact-catalog";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const sessionId = "33333333-3333-4333-8333-333333333333";
export const imageId = "22222222-2222-4222-8222-222222222222";
export const generatedImageId = "66666666-6666-4666-8666-666666666666";
export const fixtureActivity = {
  metadata: [] as string[],
  downloads: [] as string[],
  signedUrls: [] as string[],
  prompts: [] as string[],
};
Object.assign(window, { artifactLibraryFixture: fixtureActivity });
const retained: RetainedArtifactReference = {
  available: true,
  artifactId: imageId,
  kind: "file",
  contentType: "image/svg+xml",
  originalBytes: 350,
  sha256: "a".repeat(64),
  retainedAt: "2026-09-01T00:00:00Z",
  retention: { policy: "workspace_file", expiresAt: null },
  retrieval: {
    method: "GET",
    path: `/v1/workspaces/${workspaceId}/artifacts/${imageId}/content`,
    acceptRanges: "bytes",
    maxRangeBytes: 1048576,
  },
};
export const items: ArtifactCatalogItem[] = [
  ["site", "Product analytics"],
  ["image", "Project mark"],
  ["document", "Launch brief"],
  ["spreadsheet", "Growth forecast"],
  ["presentation", "Quarterly review"],
  ["file", "Research export.csv"],
].map(([kind, title], index) => ({
  id: kind === "image" ? imageId : `44444444-4444-4444-8444-44444444444${index}`,
  kind: kind as ArtifactCatalogItem["kind"],
  title: title!,
  status: "active",
  sourceSessionId: sessionId,
  createdAt: `2026-09-0${index + 1}T00:00:00Z`,
  updatedAt: `2026-09-0${index + 1}T00:00:00Z`,
  ...(kind === "image" ? { file: retained } : { versionId: "version" }),
}));
items.push({
  ...items[0]!,
  id: "55555555-5555-4555-8555-555555555555",
  title: "Previous dashboard",
  status: "archived",
});
items.push({
  ...items[1]!,
  id: generatedImageId,
  title: "Generated cover",
  file: { ...retained, artifactId: generatedImageId, kind: "generated_image" },
});
const gallery: ArtifactCatalogItem[] = Array.from({ length: 60 }, (_, index) => ({
  id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
  kind: "image",
  title: `Gallery image ${index + 1}`,
  status: "active",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  sourceSessionId: sessionId,
}));
const client = {
  async listArtifactCatalog(_workspaceId: string, options: ArtifactCatalogListOptions = {}) {
    const state = new URLSearchParams(location.search).get("state");
    if (state === "loading") return new Promise<never>(() => {});
    if (state === "error")
      throw Object.assign(new Error("Unable to reach the artifact catalog."), { status: 503 });
    return {
      items:
        state === "empty"
          ? []
          : filterArtifactCatalog(
              new URLSearchParams(location.search).has("many") ? gallery : items,
              {
                ...defaultArtifactFilters,
                ...options,
                q: options.q ?? "",
                kind: options.kind ?? "all",
              },
            ),
      nextCursor: null,
    };
  },
  async getRetainedArtifact(_workspaceId: string, id: string) {
    fixtureActivity.metadata.push(id);
    return {
      ...retained,
      artifactId: id,
      kind: id === generatedImageId ? "generated_image" : "file",
      contentType:
        id === imageId || id === generatedImageId || id.startsWith("77777777-")
          ? "image/svg+xml"
          : "text/csv",
      retrieval: {
        ...retained.retrieval,
        path: `/v1/workspaces/${workspaceId}/artifacts/${id}/content`,
      },
    };
  },
  async getFile(_workspaceId: string, id: string) {
    return {
      id,
      workspaceId,
      filename:
        id === imageId
          ? "Project mark.svg"
          : id === generatedImageId
            ? "Generated cover.svg"
            : id.startsWith("77777777-")
              ? `Gallery image ${Number(id.slice(-12)) + 1}.svg`
              : "Research export.csv",
    };
  },
  async downloadRetainedArtifact(_workspaceId: string, artifact: RetainedArtifactReference) {
    fixtureActivity.downloads.push(artifact.artifactId);
    return {
      artifact,
      bytes:
        artifact.contentType === "text/csv"
          ? new TextEncoder().encode("topic,count\nresearch,3\n")
          : new Uint8Array(await (await fetch("/test/artifact-library-image.svg")).arrayBuffer()),
    };
  },
  async createRetainedArtifactDownloadUrl(
    _workspaceId: string,
    artifact: RetainedArtifactReference,
  ) {
    fixtureActivity.signedUrls.push(artifact.artifactId);
    if (artifact.kind !== "generated_image")
      throw new Error("Only generated fixture images use signed URLs.");
    return {
      url: new URL("/test/artifact-library-image.svg", location.origin).href,
      expiresAt: "2026-09-12T23:59:59Z",
    };
  },
};
export function useAppContext() {
  return {
    client,
    accessKeyVersion: 0,
    busy: false,
    startSession: async (_workspaceId: string, input: { text: string }) => {
      fixtureActivity.prompts.push(input.text);
      return null;
    },
    accessContext: { subjectId: "fixture" },
  } as unknown as AppContextValue;
}
