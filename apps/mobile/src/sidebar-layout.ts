import {
  readResolvedSidebarItems,
  SIDEBAR_LIVE_LIST_MOBILE_LIMIT,
  sidebarItemsShown,
  sidebarLayoutIsOlder,
} from "@opengeni/contracts/sidebar-layout";
import type {
  ResolvedSidebarChild,
  ResolvedSidebarItem,
  SidebarLayoutResponse,
} from "@opengeni/sdk";

/*
 * The sidebar's links and groups (docs/sidebar-layout.md) in the side menu:
 * the same layout the web rail shows, read only here (it's changed on the web
 * Sidebar page or by agents). Groups are headed sections, like the menu's
 * projects, and live lists show at most 3 apps. An agent opens its page on
 * the web, where agents are managed.
 */

export type SidebarMenuRow =
  | { key: string; kind: "app"; appId: string; path: string | null; label: string }
  | { key: string; kind: "link"; url: string; label: string }
  | {
      key: string;
      kind: "agent";
      agentId: string;
      label: string;
      avatar: Extract<ResolvedSidebarChild, { type: "agent" }>["avatar"];
    };

export type SidebarMenuSection = {
  key: string;
  /** A group's or live list's name; null for top-level links. */
  heading: string | null;
  rows: SidebarMenuRow[];
};

function childRows(item: ResolvedSidebarChild): SidebarMenuRow[] {
  switch (item.type) {
    case "app":
      return [{ key: item.id, kind: "app", appId: item.appId, path: item.path, label: item.label }];
    case "link":
      // Only https links open (the server allows nothing else).
      return /^https:\/\//iu.test(item.url)
        ? [{ key: item.id, kind: "link", url: item.url, label: item.label }]
        : [];
    case "agent":
      return [
        {
          key: item.id,
          kind: "agent",
          agentId: item.agentId,
          label: item.label,
          avatar: item.avatar,
        },
      ];
    case "live_list":
      return item.apps
        .slice(0, Math.min(item.limit, SIDEBAR_LIVE_LIST_MOBILE_LIMIT))
        .map((app) => ({
          key: `${item.id}/${app.appId}`,
          kind: "app" as const,
          appId: app.appId,
          path: null,
          label: app.title,
        }));
    default:
      return [];
  }
}

/** The layout as the side menu's sections, in order. Empty ones are left out. */
export function sidebarMenuSections(
  items: readonly ResolvedSidebarItem[] | null | undefined,
): SidebarMenuSection[] {
  const sections: SidebarMenuSection[] = [];
  let loose: SidebarMenuSection | null = null;
  for (const item of sidebarItemsShown(items ?? [])) {
    if (item.type === "app" || item.type === "link" || item.type === "agent") {
      // Consecutive top-level links share one unheaded section.
      if (!loose) {
        loose = { key: `links/${item.id}`, heading: null, rows: [] };
        sections.push(loose);
      }
      loose.rows.push(...childRows(item));
      continue;
    }
    loose = null;
    const rows = item.type === "group" ? item.items.flatMap(childRows) : childRows(item);
    if (rows.length) sections.push({ key: item.id, heading: item.label, rows });
  }
  return sections.filter((section) => section.rows.length > 0);
}

/** Lenient, as every client must be: item types this version doesn't know are left out. */
export function readSidebarLayout(value: SidebarLayoutResponse): SidebarLayoutResponse {
  return {
    ...value,
    items: readResolvedSidebarItems(value?.items) as SidebarLayoutResponse["items"],
  };
}

type SidebarClient = {
  getSidebarLayout?: (workspaceId: string) => Promise<SidebarLayoutResponse>;
};

/*
 * The last layout per account and workspace, for the app's lifetime, so the
 * menu paints at once and refreshes quietly behind. Reads can overlap (focus
 * and pull to refresh) and finish out of order; an older answer never
 * replaces a newer one.
 */
const layouts = new Map<string, SidebarLayoutResponse>();
const listeners = new Map<string, Set<(layout: SidebarLayoutResponse) => void>>();

export function sidebarLayoutKey(accountId: string, workspaceId: string): string {
  return `${accountId}\n${workspaceId}`;
}

export function cachedSidebarLayout(key: string): SidebarLayoutResponse | null {
  return layouts.get(key) ?? null;
}

/** Keep `layout` unless a newer one is already kept; returns what is kept. */
export function rememberSidebarLayout(
  key: string,
  layout: SidebarLayoutResponse,
): SidebarLayoutResponse {
  const kept = layouts.get(key);
  if (kept && sidebarLayoutIsOlder(layout, kept)) return kept;
  layouts.set(key, layout);
  for (const listener of [...(listeners.get(key) ?? [])]) listener(layout);
  return layout;
}

export function subscribeSidebarLayout(
  key: string,
  listener: (layout: SidebarLayoutResponse) => void,
): () => void {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/**
 * Read the layout and keep it. A server without the sidebar, or a failed
 * read, keeps what is shown (nothing, the first time): the menu never shows
 * an error for it.
 */
export async function refreshSidebarLayout(
  client: SidebarClient,
  key: string,
  workspaceId: string,
): Promise<SidebarLayoutResponse | null> {
  if (typeof client.getSidebarLayout !== "function") return cachedSidebarLayout(key);
  try {
    const layout = readSidebarLayout(await client.getSidebarLayout(workspaceId));
    return rememberSidebarLayout(key, layout);
  } catch {
    return cachedSidebarLayout(key);
  }
}

/** For tests: forget every kept layout. */
export function resetSidebarLayouts(): void {
  layouts.clear();
  listeners.clear();
}
