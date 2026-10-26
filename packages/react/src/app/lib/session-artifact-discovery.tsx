import type { ArtifactCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SessionEditableArtifactSummary } from "../components/session/editable-artifacts-workspace";
import { retainArtifactsAfterRefreshFailure } from "./artifact-refresh";
import { artifactKey } from "./artifact-catalog";

type DiscoveryClient = Pick<OpenGeniBrowserClient, "listArtifactCatalog">;

/**
 * The session dock and workspace library discover the same durable resources.
 * Work a sub-agent publishes belongs to the chat that delegated it, so one
 * catalog read covers the chat and every sub-session its lineage lists: a
 * refresh costs two paged reads (active, then archived) however many
 * sub-agents the chat started. The server returns each status in catalog
 * order (pinned first, then most recently updated).
 */
export async function discoverSessionArtifacts(
  workspaceId: string,
  sessionId: string,
  current: () => boolean,
  client: DiscoveryClient,
) {
  try {
    const list = async (status: "active" | "archived") => {
      const items: ArtifactCatalogItem[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.listArtifactCatalog(workspaceId, {
          sourceSessionId: sessionId,
          includeSubSessions: true,
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
    };
    const [active, archived] = await Promise.all([list("active"), list("archived")]);
    const items = [
      ...new Map([...active, ...archived].map((item) => [artifactKey(item), item])).values(),
    ];
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
