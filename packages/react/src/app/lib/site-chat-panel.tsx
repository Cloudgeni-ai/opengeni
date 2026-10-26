import { useCallback, useRef, useState } from "react";

/**
 * The Site view's chat panel width and whether it is hidden, remembered per
 * person (not per Site or workspace) in this browser: a reader who likes a
 * wide chat gets it on every Site. Storage that is blocked or full only
 * means the choice lasts until the page reloads.
 */
export const SITE_CHAT_MIN_WIDTH = 320;
export const SITE_CHAT_MAX_WIDTH = 720;
export const SITE_CHAT_DEFAULT_WIDTH = 400;
/** The Site keeps at least this much room beside the chat. */
export const SITE_MIN_WIDTH = 360;

const VERSION = 1;

type PanelStorage = Pick<Storage, "getItem" | "setItem">;

export type SiteChatPanelLayout = Readonly<{ width: number; collapsed: boolean }>;

export function siteChatPanelStorageId(subjectId: string): string {
  return ["og.site-view.chat", `v${VERSION}`, encodeURIComponent(subjectId)].join(":");
}

export function clampSiteChatWidth(width: number): number {
  if (!Number.isFinite(width)) return SITE_CHAT_DEFAULT_WIDTH;
  return Math.round(Math.min(SITE_CHAT_MAX_WIDTH, Math.max(SITE_CHAT_MIN_WIDTH, width)));
}

export function readSiteChatPanelLayout(
  storageId: string,
  storage: PanelStorage | null = browserStorage(),
): SiteChatPanelLayout {
  const fallback = { width: SITE_CHAT_DEFAULT_WIDTH, collapsed: false };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(storageId);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const { width, collapsed } = value as Record<string, unknown>;
    return {
      width: typeof width === "number" ? clampSiteChatWidth(width) : fallback.width,
      collapsed: collapsed === true,
    };
  } catch {
    return fallback;
  }
}

export function writeSiteChatPanelLayout(
  storageId: string,
  layout: SiteChatPanelLayout,
  storage: PanelStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      storageId,
      JSON.stringify({ width: clampSiteChatWidth(layout.width), collapsed: layout.collapsed }),
    );
  } catch {
    // The panel stays usable when persistence is blocked or quota is exhausted.
  }
}

/** The signed-in person's panel layout, saved as it changes. */
export function useSiteChatPanelLayout(subjectId: string) {
  const storageId = siteChatPanelStorageId(subjectId);
  const [state, setState] = useState(() => ({
    storageId,
    layout: readSiteChatPanelLayout(storageId),
  }));
  // Another person signing in on this page reads their own layout.
  const current =
    state.storageId === storageId
      ? state
      : { storageId, layout: readSiteChatPanelLayout(storageId) };
  if (current !== state) setState(current);
  const latest = useRef(current);
  latest.current = current;
  const update = useCallback((patch: Partial<SiteChatPanelLayout>) => {
    const { storageId: id, layout: previous } = latest.current;
    const layout = {
      ...previous,
      ...patch,
      ...(patch.width !== undefined ? { width: clampSiteChatWidth(patch.width) } : {}),
    };
    writeSiteChatPanelLayout(id, layout);
    latest.current = { storageId: id, layout };
    setState(latest.current);
  }, []);
  return { layout: current.layout, update };
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
