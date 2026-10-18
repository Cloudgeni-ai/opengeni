import type { ArtifactCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SessionEditableArtifactSummary } from "@/components/session/editable-artifacts-workspace";
import { retainArtifactsAfterRefreshFailure } from "./artifact-refresh";
import { artifactKey } from "./artifact-catalog";

/** Sub-sessions whose artifacts also belong to the chat that started them. */
const MAX_SUB_SESSIONS = 50;

type DiscoveryClient = Pick<OpenGeniBrowserClient, "listArtifactCatalog"> &
  Partial<Pick<OpenGeniBrowserClient, "getSessionLineage">>;

type ArtifactSource = {
  id: string;
  /**
   * Lineage activity version of a sub-session. Null for the chat itself, whose
   * own new events are what trigger a refresh, so it is always read again.
   */
  version: string | null;
};

/**
 * Catalog results per sub-session, keyed by the activity version lineage
 * reported when they were read. A sub-session can only publish an artifact by
 * running a tool, which appends events and so advances its version; an
 * unchanged version therefore cannot hide a new artifact. Callers own one
 * cache per chat view and drop it to force a complete re-read.
 */
export type SessionArtifactSourceCache = Map<
  string,
  { version: string; active: ArtifactCatalogItem[]; archived: ArtifactCatalogItem[] }
>;

function lineageVersion(session: {
  status?: string;
  lastSequence?: number;
  updatedAt?: string;
}): string | null {
  if (session.lastSequence === undefined || session.updatedAt === undefined) return null;
  return `${session.status ?? ""}:${session.lastSequence}:${session.updatedAt}`;
}

/**
 * The chat plus every sub-session it started, depth-first. Work a sub-agent
 * publishes belongs to the chat that delegated it. Lineage is best effort: when
 * it cannot be read, the chat's own artifacts still load.
 */
async function sourceSessionIds(
  workspaceId: string,
  sessionId: string,
  client: DiscoveryClient,
): Promise<ArtifactSource[]> {
  const own = { id: sessionId, version: null };
  if (!client.getSessionLineage) return [own];
  try {
    const lineage = await client.getSessionLineage(workspaceId, sessionId);
    const sources: ArtifactSource[] = [own];
    const ids = new Set([sessionId]);
    const visit = (nodes: typeof lineage.children) => {
      for (const node of nodes) {
        if (sources.length > MAX_SUB_SESSIONS) return;
        if (!ids.has(node.session.id)) {
          ids.add(node.session.id);
          sources.push({ id: node.session.id, version: lineageVersion(node.session) });
        }
        visit(node.children);
      }
    };
    visit(lineage.children);
    return sources;
  } catch {
    return [own];
  }
}

/**
 * The session dock and workspace library discover the same durable resources.
 * With a cache, sub-sessions whose activity version is unchanged since the
 * last successful read reuse that read instead of listing the catalog again.
 */
export async function discoverSessionArtifacts(
  workspaceId: string,
  sessionId: string,
  current: () => boolean,
  client: DiscoveryClient,
  cache?: SessionArtifactSourceCache,
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
    const readSource = async (source: ArtifactSource) => {
      const cached = source.version !== null ? cache?.get(source.id) : undefined;
      if (cached && cached.version === source.version) return cached;
      let complete = true;
      const [active, archived] = await Promise.all(
        (["active", "archived"] as const).map(async (status) => {
          try {
            return await listSource(source.id, status);
          } catch (error) {
            // A sub-session that cannot be read must not hide the chat's own work.
            if (source.id === sessionId) throw error;
            complete = false;
            return [];
          }
        }),
      );
      const read = { version: source.version ?? "", active: active!, archived: archived! };
      if (cache && source.version !== null && complete && current()) cache.set(source.id, read);
      return read;
    };
    const reads = await Promise.all(sources.map(readSource));
    if (cache && current()) {
      const listed = new Set(sources.map((source) => source.id));
      for (const id of cache.keys()) if (!listed.has(id)) cache.delete(id);
    }
    const groups = [...reads.map((read) => read.active), ...reads.map((read) => read.archived)];
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
