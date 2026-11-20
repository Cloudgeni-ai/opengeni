// The customizable sidebar's data (docs/sidebar-layout.md): one shared copy
// per person and workspace, so the rail and the Customize page agree, and a
// remount (switching pages) draws the last known layout at once.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SidebarLayoutResponse, UpdateSidebarLayoutRequest } from "@opengeni/sdk";
import { readResolvedSidebarItems } from "@opengeni/contracts/sidebar-layout";
import { useAppContext } from "@opengeni/react/app/app-context";

type Entry = { layout: SidebarLayoutResponse | null; failed: boolean; loading: boolean };

const EMPTY: Entry = { layout: null, failed: false, loading: true };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();

/** Something else (an agent's tool call, another tab) may have changed the layout. */
export const SIDEBAR_LAYOUT_CHANGED = "opengeni:sidebar-layout-changed";

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Lenient: item types this version doesn't know are left out, never an error. */
function normalize(layout: SidebarLayoutResponse): SidebarLayoutResponse {
  return {
    ...layout,
    items: readResolvedSidebarItems(layout.items) as SidebarLayoutResponse["items"],
    hidden: (Array.isArray(layout.hidden) ? layout.hidden : []).flatMap((entry) => {
      const [item] = readResolvedSidebarItems([entry?.item]);
      return item ? [{ parentId: entry.parentId ?? null, item }] : [];
    }) as SidebarLayoutResponse["hidden"],
    workspace: {
      ...layout.workspace,
      ...(layout.workspace?.items
        ? {
            items: readResolvedSidebarItems(
              layout.workspace.items,
            ) as SidebarLayoutResponse["items"],
          }
        : {}),
    },
  };
}

function set(key: string, entry: Entry) {
  entries.set(key, entry);
  emit();
}

type Client = ReturnType<typeof useAppContext>["client"];

function load(client: Client, key: string, workspaceId: string): Promise<void> {
  const running = inFlight.get(key);
  if (running) return running;
  const request = client
    .getSidebarLayout(workspaceId)
    .then((layout) => set(key, { layout: normalize(layout), failed: false, loading: false }))
    .catch(() => {
      const previous = entries.get(key);
      // Keep a known layout on a transient failure; retry on focus.
      set(key, { layout: previous?.layout ?? null, failed: true, loading: false });
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export function useSidebarLayout(workspaceId: string, enabled = true) {
  const { client, accessContext } = useAppContext();
  const key = `${accessContext?.subjectId ?? ""}:${workspaceId}`;
  const entry = useSyncExternalStore(
    subscribe,
    () => entries.get(key) ?? EMPTY,
    () => EMPTY,
  );
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load(client, key, workspaceId);
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(SIDEBAR_LAYOUT_CHANGED, refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 120_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(SIDEBAR_LAYOUT_CHANGED, refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [client, enabled, key, workspaceId]);
  const update = useCallback(
    async (request: UpdateSidebarLayoutRequest) => {
      const layout = normalize(await client.updateSidebarLayout(workspaceId, request));
      set(key, { layout, failed: false, loading: false });
      return layout;
    },
    [client, key, workspaceId],
  );
  return { ...entry, update };
}

/** For tests: forget every cached layout. */
export function resetSidebarLayoutCache() {
  entries.clear();
  inFlight.clear();
  emit();
}
