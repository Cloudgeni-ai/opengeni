import type {
  OpenGeniClient,
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
} from "@opengeni/sdk";

export type SiteDisplayContent = Pick<
  WorkspaceArtifactContentResponse,
  "artifactId" | "versionId" | "html" | "requestedTools"
>;

/** The reads a Site snapshot needs. */
export type SiteSnapshotReadClient = Pick<
  OpenGeniClient,
  "getWorkspaceArtifact" | "getWorkspaceArtifactHtml"
> &
  Partial<Pick<OpenGeniClient, "getWorkspaceArtifactContent">>;

// Hermes (React Native) has no structuredClone; snapshots are plain JSON.
const clone = <T>(value: T): T =>
  typeof structuredClone === "function"
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);

/** Shared web/native/embedded read boundary: pin content to the observed version,
 * and never accept a response belonging to another workspace or Site. DOM-free. */
export async function loadSiteSnapshot(
  client: SiteSnapshotReadClient,
  workspaceId: string,
  siteId: string,
  options: { signal?: AbortSignal; includeArchivedContent?: boolean; versionId?: string } = {},
): Promise<{
  detail: WorkspaceArtifactDetailResponse;
  content: SiteDisplayContent | null;
}> {
  const requestOptions = options.signal ? { signal: options.signal } : {};
  const detail = await client.getWorkspaceArtifact(workspaceId, siteId, requestOptions);
  options.signal?.throwIfAborted();
  if (detail.artifact.id !== siteId || detail.artifact.workspaceId !== workspaceId)
    throw new Error("Site scope mismatch");
  const selectedVersion = options.versionId
    ? detail.versions.find((version) => version.id === options.versionId)
    : detail.artifact.currentVersion;
  const versionId = options.versionId ?? selectedVersion?.id;
  let content: SiteDisplayContent | null =
    selectedVersion &&
    versionId &&
    (detail.artifact.status === "active" || options.includeArchivedContent)
      ? {
          artifactId: siteId,
          versionId,
          requestedTools: selectedVersion!.requestedTools,
          html: await client.getWorkspaceArtifactHtml(workspaceId, siteId, {
            ...requestOptions,
            versionId,
          }),
        }
      : null;
  if (
    versionId &&
    !selectedVersion &&
    (detail.artifact.status === "active" || options.includeArchivedContent)
  ) {
    if (!client.getWorkspaceArtifactContent) throw new Error("Site version unavailable");
    content = await client.getWorkspaceArtifactContent(workspaceId, siteId, {
      ...requestOptions,
      versionId,
    });
  }
  options.signal?.throwIfAborted();
  if (content && (content.artifactId !== siteId || content.versionId !== versionId))
    throw new Error("Site content mismatch");
  return { detail: clone(detail), content: content ? clone(content) : null };
}
