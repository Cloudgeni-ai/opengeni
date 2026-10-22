import {
  OpenGeniApiError,
  type ArtifactCatalogItem,
  type FileAsset,
  type RetainedArtifactReference,
} from "@opengeni/sdk";
import type { AppContextValue } from "@opengeni/react/app/app-context";

// The owner's two files (one Only me, one shared), a teammate's shared file,
// and someone else's Only me file that the API refuses as private.
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const draftId = "44444444-4444-4444-8444-444444444441";
export const rosterId = "44444444-4444-4444-8444-444444444442";
export const notesId = "44444444-4444-4444-8444-444444444443";
export const othersId = "44444444-4444-4444-8444-444444444444";
const accountId = "99999999-9999-4999-8999-999999999999";
const owner = "user:owner";
export const fixtureActivity = { changes: [] as string[] };
Object.assign(window, { fileAudienceFixture: fixtureActivity });

const seed = [
  [draftId, "Q3 revenue forecast.csv", "personal", owner],
  [rosterId, "Team roster.csv", "workspace", owner],
  [notesId, "Board meeting notes.csv", "workspace", "user:teammate"],
] as const;
const files = new Map<string, FileAsset>();
seed.forEach(([id, filename, scope, ownerSubjectId], index) => {
  files.set(id, {
    id,
    workspaceId,
    filename,
    scope,
    ownerSubjectId,
    status: "ready",
    contentType: "text/csv",
    sizeBytes: 64,
    createdAt: `2026-10-0${index + 1}T09:00:00Z`,
    updatedAt: `2026-10-0${index + 1}T09:00:00Z`,
  } as unknown as FileAsset);
});
const reference = (id: string): RetainedArtifactReference => ({
  available: true,
  artifactId: id,
  kind: "file",
  contentType: "text/csv",
  originalBytes: 64,
  sha256: "a".repeat(64),
  retainedAt: "2026-10-01T09:00:00Z",
  retention: { policy: "workspace_file", expiresAt: null },
  retrieval: {
    method: "GET",
    path: `/v1/workspaces/${workspaceId}/artifacts/${id}/content`,
    acceptRanges: "bytes",
    maxRangeBytes: 1048576,
  },
});
const catalog = (): ArtifactCatalogItem[] =>
  [...files.values()].map((file) => ({
    id: file.id,
    kind: "file",
    title: file.filename,
    status: "active",
    visibility: file.scope === "personal" ? "private" : "workspace",
    ownedByViewer: file.ownerSubjectId === owner,
    createdAt: String(file.createdAt),
    updatedAt: String(file.updatedAt),
    file: reference(file.id),
  }));

export const client = {
  tools: { forWorkspace: () => ({}) },
  async listArtifactCatalog() {
    return { items: catalog(), nextCursor: null };
  },
  async listSessionPage() {
    return { pinned: [], sessions: [], nextCursor: null, filtersApplied: true };
  },
  async getRetainedArtifact(_workspaceId: string, id: string) {
    if (id === othersId)
      throw new OpenGeniApiError(
        403,
        JSON.stringify({ artifactId: id, available: false, reason: "private" }),
        { correlationId: "req-4f2a9c" },
      );
    if (!files.has(id)) throw new OpenGeniApiError(404, "{}");
    return reference(id);
  },
  async getFile(_workspaceId: string, id: string) {
    return files.get(id) ?? null;
  },
  async downloadRetainedArtifact(_workspaceId: string, artifact: RetainedArtifactReference) {
    return {
      artifact,
      bytes: new TextEncoder().encode(
        "quarter,region,revenue\nQ3,North,1240000\nQ3,South,980000\n",
      ),
    };
  },
  async getSessionTenancyCreateCapabilities() {
    return { canCreatePrivate: true };
  },
  async updateFileVisibility(
    _workspaceId: string,
    id: string,
    request: { visibility: "private" | "workspace" },
  ) {
    fixtureActivity.changes.push(`${id}:${request.visibility}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const file = files.get(id);
    if (!file) throw new OpenGeniApiError(404, "{}");
    const next = {
      ...file,
      scope: request.visibility === "private" ? "personal" : "workspace",
    } as FileAsset;
    files.set(id, next);
    return { file: next };
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
      subjectId: owner,
      workspaceGrants: [
        {
          workspaceId,
          accountId,
          subjectId: owner,
          permissions: [
            "sessions:create",
            "sessions:read",
            "artifacts:read",
            "artifacts:publish",
            "files:read",
            "files:upload",
          ],
        },
      ],
    },
  } as unknown as AppContextValue;
}
