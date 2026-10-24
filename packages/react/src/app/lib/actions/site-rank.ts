/** Ranking for the ⌘K menu's Sites; kept apart from the sidebar's store so the sidebar never loads it. */
import { LOOSE_MATCH_BELOW, rankLabel } from "./rank";
import type { SiteRecord } from "./site-directory";

export type RankedSite = { site: SiteRecord; rank: number; loose: boolean };

/**
 * Ranks Sites by title the way the menu ranks chat titles. `known` are the
 * Sites the app already holds (instant), most recently active first; `found`
 * are the server's matches for this query, which always count even when the
 * title alone would not match locally. As with recently opened chats, the
 * Sites someone was active in lately get a small lift within a match tier,
 * and recent activity breaks ties.
 */
export function rankSites(
  known: readonly SiteRecord[],
  found: readonly SiteRecord[],
  query: string,
): RankedSite[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const candidates = new Map<
    string,
    { site: SiteRecord; fromServer: boolean; recency: number | undefined }
  >();
  known.forEach((site, index) =>
    candidates.set(site.id, { site, fromServer: false, recency: index }),
  );
  for (const site of found) {
    const current = candidates.get(site.id);
    // The server's read has the current title; keep the later activity.
    candidates.set(site.id, {
      site: current
        ? { ...site, updatedAt: Math.max(site.updatedAt, current.site.updatedAt) }
        : site,
      fromServer: true,
      recency: current?.recency,
    });
  }
  const ranked: RankedSite[] = [];
  for (const { site, fromServer, recency } of candidates.values()) {
    let rank = rankLabel(site.title, trimmed);
    const loose = rank !== null && rank < LOOSE_MATCH_BELOW;
    // The server matched the title; folding can differ, so keep it.
    if (rank === null && fromServer) rank = 50;
    if (rank === null) continue;
    if (recency !== undefined) rank += Math.max(0, 20 - recency);
    ranked.push({ site, rank, loose });
  }
  return ranked.sort((a, b) => b.rank - a.rank || b.site.updatedAt - a.site.updatedAt);
}

/** Sites for the empty menu: the most recently active ones, without the one on screen. */
export function recentSites(
  known: readonly SiteRecord[],
  currentSiteId: string | null,
  limit: number,
): SiteRecord[] {
  return [...known]
    .filter((site) => site.id !== currentSiteId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}
