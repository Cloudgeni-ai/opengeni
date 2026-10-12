import type { ArtifactCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SessionEditableArtifactSummary } from "@/components/session/editable-artifacts-workspace";
import { retainArtifactsAfterRefreshFailure } from "./artifact-refresh";
import { artifactKey } from "./artifact-catalog";

/** Sub-sessions whose artifacts also belong to the chat that started them. */
const MAX_SUB_SESSIONS = 50;

type DiscoveryClient = Pick<OpenGeniBrowserClient, "listArtifactCatalog"> &
  Partial<Pick<OpenGeniBrowserClient, "getSessionLineage">>;

/**
 * The chat plus every sub-session it started, depth-first. Work a sub-agent
 * publishes belongs to the chat that delegated it. Lineage is best effort: when
 * it cannot be read, the chat's own artifacts still load.
 */
async function sourceSessionIds(
  workspaceId: string,
  sessionId: string,
  client: DiscoveryClient,
): Promise<string[]> {
  if (!client.getSessionLineage) return [sessionId];
  try {
    const lineage = await client.getSessionLineage(workspaceId, sessionId);
    const ids = [sessionId];
    const visit = (nodes: typeof lineage.children) => {
      for (const node of nodes) {
        if (ids.length > MAX_SUB_SESSIONS) return;
        if (!ids.includes(node.session.id)) ids.push(node.session.id);
        visit(node.children);
      }
    };
    visit(lineage.children);
    return ids;
  } catch {
    return [sessionId];
  }
}

/** The session dock and workspace library discover the same durable resources. */
export async function discoverSessionArtifacts(
  workspaceId: string,
  sessionId: string,
  current: () => boolean,
  client: DiscoveryClient,
) {
  try {
    const sources = await sourceSessionIds(workspaceId, sessionId, client);
    const listSource = async (sourceSessionId: string, status: "active" | "archived") => {
      const items: ArtifactCatalogItem[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.listArtifactCatalog(workspaceId, {
          sourceSessionId,
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
    const groups = await Promise.all(
      (["active", "archived"] as const).flatMap((status) =>
        sources.map(async (source) => {
          try {
            return await listSource(source, status);
          } catch (error) {
            // A sub-session that cannot be read must not hide the chat's own work.
            if (source === sessionId) throw error;
            return [];
          }
        }),
      ),
    );
    const merged = groups.flat();
    // Several sources interleave like the catalog orders one: active first, then
    // pinned, then recency. Ties keep source order (the chat before its
    // sub-sessions) and each source's server order. One source keeps the server order.
    if (sources.length > 1)
      merged.sort(
        (a, b) =>
          Number(a.status === "archived") - Number(b.status === "archived") ||
          Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
    const items = [...new Map(merged.map((item) => [artifactKey(item), item])).values()];
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
