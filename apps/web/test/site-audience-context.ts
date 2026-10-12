import type { ArtifactCatalogItem, WorkspaceArtifact } from "@opengeni/sdk";
import type { AppContextValue } from "../src/context";

// `?viewer=other` opens the Site as another member; `?audience=workspace`
// starts it shared; `?only-me-off` turns Only me off; `?share-error` makes the
// change fail.
const params = new URLSearchParams(location.search);
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const siteId = "44444444-4444-4444-8444-444444444440";
const accountId = "99999999-9999-4999-8999-999999999999";
const owner = "user:owner";
const viewer = params.get("viewer") === "other" ? "user:other" : owner;
const version = {
  id: "88888888-8888-4888-8888-888888888888",
  artifactId: siteId,
  revision: 3,
  contentSha256: null,
  sizeBytes: 512,
  requestedTools: [],
  sourceSessionId: null,
  sourceTurnId: null,
  sourceAttemptId: null,
  sourceExecutionGeneration: null,
  createdBySubjectId: owner,
  createdAt: "2026-09-03T00:00:00Z",
};
export const fixtureActivity = { changes: [] as string[] };
Object.assign(window, { siteAudienceFixture: fixtureActivity });
let artifact: WorkspaceArtifact = {
  id: siteId,
  accountId,
  workspaceId,
  slug: "product-analytics",
  title: "Product analytics",
  description: null,
  status: "active",
  visibility: params.get("audience") === "workspace" ? "workspace" : "private",
  ownerSubjectId: owner,
  currentVersion: version,
  createdBySubjectId: owner,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-03T00:00:00Z",
} as unknown as WorkspaceArtifact;
const catalogItem = (): ArtifactCatalogItem => ({
  id: siteId,
  kind: "site",
  title: artifact.title,
  status: "active",
  visibility: artifact.visibility,
  createdAt: artifact.createdAt,
  updatedAt: artifact.updatedAt,
  versionId: version.id,
});
export const client = {
  tools: { forWorkspace: () => ({}) },
  async getWorkspaceArtifact(_workspaceId: string, id: string) {
    if (id !== siteId) throw Object.assign(new Error("Site not found."), { status: 404 });
    return { artifact, versions: [version], events: [] };
  },
  async getWorkspaceArtifactHtml() {
    return `<!doctype html><html><head><style>body{font:15px system-ui;margin:32px;color:#1f2328}h1{font-size:28px}.bar{height:14px;border-radius:7px;background:#2f6feb;margin:10px 0}</style></head><body><h1>Product analytics</h1><p>Weekly active teams by plan.</p><div class="bar" style="width:80%"></div><div class="bar" style="width:55%"></div><div class="bar" style="width:30%"></div></body></html>`;
  },
  async getSessionTenancyCreateCapabilities() {
    return { canCreatePrivate: !params.has("only-me-off") };
  },
  async updateWorkspaceArtifactVisibility(
    _workspaceId: string,
    id: string,
    request: { visibility: "private" | "workspace" },
  ) {
    fixtureActivity.changes.push(request.visibility);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (params.has("share-error"))
      throw Object.assign(new Error("The Site could not be updated. Try again."), { status: 503 });
    if (id !== siteId) throw Object.assign(new Error("Site not found."), { status: 404 });
    artifact = { ...artifact, visibility: request.visibility };
    return { artifact };
  },
  async listArtifactCatalog() {
    return { items: [catalogItem()], nextCursor: null };
  },
  async listSessionPage() {
    return { pinned: [], sessions: [], nextCursor: null, filtersApplied: true };
  },
};
export function useAppContext() {
  return {
    client,
    accessKeyVersion: 0,
    busy: false,
    startSession: async () => null,
    workspaces: [{ id: workspaceId, accountId, name: "Growth team", kind: "shared" }],
    managedSelfContext: null,
    accessContext: {
      subjectId: viewer,
      workspaceGrants: [
        {
          workspaceId,
          accountId,
          subjectId: viewer,
          permissions: ["sessions:create", "sessions:read", "artifacts:read", "artifacts:publish"],
        },
      ],
    },
  } as unknown as AppContextValue;
}
