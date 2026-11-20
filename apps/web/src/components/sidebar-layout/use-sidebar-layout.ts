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
/** Bumped by each update, so a read that started before it can't overwrite its answer. */
const generations = new Map<string, number>();

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
  const generation = generations.get(key) ?? 0;
  const current = () => (generations.get(key) ?? 0) === generation;
  // A host's own client may not have the sidebar (or may throw at once): the
  // sidebar is then just empty, never an error for the page around it.
  if (typeof (client as Partial<Client>).getSidebarLayout !== "function") {
    if (!entries.has(key)) set(key, { layout: null, failed: false, loading: false });
    return Promise.resolve();
  }
  const request = Promise.resolve()
    .then(() => client.getSidebarLayout(workspaceId))
    .then((layout) => {
      if (current()) set(key, { layout: normalize(layout), failed: false, loading: false });
    })
    .catch(() => {
      if (!current()) return;
      const previous = entries.get(key);
      // Keep a known layout on a transient failure; retry on focus.
      set(key, { layout: previous?.layout ?? null, failed: true, loading: false });
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
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
    // Changes made elsewhere (an agent's tool call, another tab or device)
    // show on focus, on return to the tab, or within two minutes.
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 120_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [client, enabled, key, workspaceId]);
  const update = useCallback(
    async (request: UpdateSidebarLayoutRequest) => {
      const layout = normalize(await client.updateSidebarLayout(workspaceId, request));
      // Any read still running started before this answer: drop it.
      generations.set(key, (generations.get(key) ?? 0) + 1);
      inFlight.delete(key);
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
  generations.clear();
  emit();
}
