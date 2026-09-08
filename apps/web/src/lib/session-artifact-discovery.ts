import type { SessionEditableArtifactSummary } from "@/components/session/editable-artifacts-workspace";
import { editableArtifactClient } from "./editable-artifact-client";
import { createConsoleEditableArtifactReplicaId } from "./editable-artifact-browser";
import { retainArtifactsAfterRefreshFailure } from "./artifact-refresh";

export async function discoverSessionArtifacts(
  workspaceId: string,
  sessionId: string,
  current: () => boolean,
) {
  const [documents, sites] = await Promise.allSettled([
    editableArtifactClient
      .listSessionEditableArtifacts(workspaceId, sessionId, {
        replicaId: createConsoleEditableArtifactReplicaId(),
      })
      .then((result) => result.artifacts),
    (async () => {
      const result: SessionEditableArtifactSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await editableArtifactClient.listWorkspaceArtifacts(workspaceId, {
          sourceSessionId: sessionId,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (!current()) return [];
        result.push(
          ...page.artifacts.map((site) => ({
            id: site.id,
            title: site.title,
            modality: "site" as const,
            versionId: site.currentVersion?.id,
            siteStatus: site.status,
          })),
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return result;
    })(),
  ]);
  return (previous: readonly SessionEditableArtifactSummary[]) => ({
    status:
      documents.status === "fulfilled" && sites.status === "fulfilled"
        ? ("ready" as const)
        : ("error" as const),
    artifacts: [
      ...settledArtifacts(
        documents,
        previous.filter((item) => item.modality !== "site"),
      ),
      ...settledArtifacts(
        sites,
        previous.filter((item) => item.modality === "site"),
      ),
    ],
  });
}

function settledArtifacts(
  result: PromiseSettledResult<readonly SessionEditableArtifactSummary[]>,
  previous: readonly SessionEditableArtifactSummary[],
): readonly SessionEditableArtifactSummary[] {
  return result.status === "fulfilled"
    ? result.value
    : retainArtifactsAfterRefreshFailure(result.reason)
      ? previous
      : [];
}
