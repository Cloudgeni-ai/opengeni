import { useSyncExternalStore } from "react";

import type { SessionSiteOrigin } from "./session-site-origin";

/**
 * The sidebar's Site actions for the Site's own page: Pin and Archive there
 * act exactly as on the Site's row (same optimistic row, toasts and Undo),
 * because the sidebar that owns those rows publishes them here while it is
 * mounted. Absent while there is no sidebar list (a collapsed rail, a closed
 * phone drawer, an embed without Site sidebar state); the page then offers
 * neither.
 */
export type SiteSidebarBridge = {
  workspaceId: string;
  /** Sites pinned in this person's sidebar. */
  pinnedSiteIds: ReadonlySet<string>;
  pin: (origin: SessionSiteOrigin, pinned: boolean) => void;
  archive: (origin: SessionSiteOrigin) => void;
};

// Newest last: when two sidebars are mounted (the shell's and an embedded
// chat's), the newest acts until it unmounts, then the one before it again.
let registrations: readonly SiteSidebarBridge[] = [];
const listeners = new Set<() => void>();

/** Publishes the sidebar's actions; returns the matching withdrawal. */
export function publishSiteSidebarBridge(bridge: SiteSidebarBridge): () => void {
  registrations = [...registrations, bridge];
  for (const listener of listeners) listener();
  return () => {
    if (!registrations.includes(bridge)) return;
    registrations = registrations.filter((registered) => registered !== bridge);
    for (const listener of listeners) listener();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): SiteSidebarBridge | null => registrations.at(-1) ?? null;

/** The sidebar's Pin and Archive for one Site, or null while there are none. */
export function useSiteSidebarActions(
  workspaceId: string,
  origin: SessionSiteOrigin | null,
): { pinned: boolean; togglePin: () => void; archive: () => void } | null {
  const bridge = useSyncExternalStore(subscribe, snapshot, () => null);
  if (!bridge || !origin || bridge.workspaceId !== workspaceId) return null;
  const pinned = bridge.pinnedSiteIds.has(origin.siteId);
  return {
    pinned,
    togglePin: () => bridge.pin(origin, !pinned),
    archive: () => bridge.archive(origin),
  };
}
