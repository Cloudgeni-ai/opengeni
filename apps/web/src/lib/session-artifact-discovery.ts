import type { ArtifactCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SessionEditableArtifactSummary } from "@/components/session/editable-artifacts-workspace";
import { retainArtifactsAfterRefreshFailure } from "./artifact-refresh";
import { artifactKey } from "./artifact-catalog";

/** The session dock and workspace library discover the same durable resources. */
export async function discoverSessionArtifacts(
  workspaceId: string,
  sessionId: string,
  current: () => boolean,
  client: Pick<OpenGeniBrowserClient, "listArtifactCatalog">,
) {
  try {
    const groups = await Promise.all(
      (["active", "archived"] as const).map(async (status) => {
        const items: ArtifactCatalogItem[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.listArtifactCatalog(workspaceId, {
            sourceSessionId: sessionId,
            status,
            sort: "updated",
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          if (!current()) return [];
          items.push(...page.items);
          cursor = page.nextCursor ?? undefined;
          if (cursor && seen.has(cursor)) throw new Error("Artifact pagination did not advance.");
          if (cursor) seen.add(cursor);
        } while (cursor);
        return items;
      }),
    );
    const items = [...new Map(groups.flat().map((item) => [artifactKey(item), item])).values()];
    return (_previous: readonly SessionEditableArtifactSummary[]) => ({
      status: "ready" as const,
      artifacts: items.map(
        (item): SessionEditableArtifactSummary => ({
          id: item.id,
          title: item.title,
          modality: item.kind,
          versionId: item.versionId,
          siteStatus: item.status,
          catalogItem: item,
        }),
      ),
    });
  } catch (error) {
    return (previous: readonly SessionEditableArtifactSummary[]) => ({
      status: "error" as const,
      artifacts: retainArtifactsAfterRefreshFailure(error) ? previous : [],
    });
  }
}
