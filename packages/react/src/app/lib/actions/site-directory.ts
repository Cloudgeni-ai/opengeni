/**
 * What the app already knows about Sites, so the ⌘K menu can list them
 * instantly: the Site rows the sidebar has loaded for each workspace, most
 * recent activity first (the person's own opens count). It is a cache for
 * speed, never a source of authority: opening a Site still goes through the
 * normal authorized reads, and the menu's server search answers with only the
 * Sites the person may see.
 */
import { useSyncExternalStore } from "react";
import { LOOSE_MATCH_BELOW, rankLabel } from "./rank";

export type SiteRecord = {
  id: string;
  workspaceId: string;
  title: string;
  /** Latest activity (ms): conversations, a new version, or the person opening it. */
  updatedAt: number;
};

/** The fields of a sidebar Site row or a catalog item the menu reads. */
export type SiteSource = { siteId?: string; id?: string; title: string; updatedAt: string };

type DirectoryState = { sites: Map<string, readonly SiteRecord[]>; version: number };

const directories = new Map<string, DirectoryState>();
const listeners = new Map<string, Set<() => void>>();

function directory(subjectId: string): DirectoryState {
  let state = directories.get(subjectId);
  if (!state) {
    state = { sites: new Map(), version: 0 };
    directories.set(subjectId, state);
  }
  return state;
}

/** Turns sidebar rows or catalog items into records, dropping anything malformed. */
export function siteRecords(workspaceId: string, sources: readonly SiteSource[]): SiteRecord[] {
  const seen = new Set<string>();
  const records: SiteRecord[] = [];
  for (const source of sources) {
    const id = source.siteId ?? source.id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    records.push({
      id,
      workspaceId,
      title: (typeof source.title === "string" && source.title.trim()) || "Untitled Site",
      updatedAt: Date.parse(source.updatedAt) || 0,
    });
  }
  return records;
}

/** The sidebar reports the Site rows it shows for a workspace; the newest list replaces the last. */
export function rememberSidebarSites(
  subjectId: string,
  workspaceId: string,
  sources: readonly SiteSource[],
): void {
  const state = directory(subjectId);
  const next = siteRecords(workspaceId, sources).sort((a, b) => b.updatedAt - a.updatedAt);
  const current = state.sites.get(workspaceId);
  if (
    current &&
    current.length === next.length &&
    current.every(
      (site, index) =>
        site.id === next[index]!.id &&
        site.title === next[index]!.title &&
        site.updatedAt === next[index]!.updatedAt,
    )
  )
    return;
  state.sites.set(workspaceId, next);
  state.version += 1;
  for (const listener of listeners.get(subjectId) ?? []) listener();
}

/** The workspace's Sites the sidebar knows, most recent activity first. */
export function readSidebarSites(subjectId: string, workspaceId: string): readonly SiteRecord[] {
  return directory(subjectId).sites.get(workspaceId) ?? [];
}

/** Re-renders when the directory changes; read it through `readSidebarSites`. */
export function useSiteDirectoryVersion(subjectId: string): number {
  return useSyncExternalStore(
    (listener) => {
      let set = listeners.get(subjectId);
      if (!set) {
        set = new Set();
        listeners.set(subjectId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    () => directory(subjectId).version,
    () => 0,
  );
}

/** A Site's page in the app, as a plain path (new tab). */
export function sitePath(workspaceId: string, siteId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/sites/${encodeURIComponent(siteId)}`;
}

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
