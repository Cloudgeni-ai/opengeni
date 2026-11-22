import { useCallback, useRef, useState } from "react";

/**
 * The Site view's chat panel width and which side it sits on, remembered per
 * person (not per Site or workspace) in this browser: a reader who likes a
 * wide chat on the left gets it on every Site. Whether the chat is open is
 * remembered per person and Site (`useSiteChatOpen`). Storage that is blocked
 * or full only means the choice lasts until the page reloads.
 */
export const SITE_CHAT_MIN_WIDTH = 320;
export const SITE_CHAT_MAX_WIDTH = 720;
export const SITE_CHAT_DEFAULT_WIDTH = 400;
/** The Site keeps at least this much room beside the chat. */
export const SITE_MIN_WIDTH = 360;

const VERSION = 1;

type PanelStorage = Pick<Storage, "getItem" | "setItem">;

export type SiteChatPosition = "left" | "right";

export type SiteChatPanelLayout = Readonly<{
  width: number;
  position: SiteChatPosition;
}>;

export function siteChatPanelStorageId(subjectId: string): string {
  return ["og.site-view.chat", `v${VERSION}`, encodeURIComponent(subjectId)].join(":");
}

type WaitingCandidate = Readonly<{
  id: string;
  status: string;
  requiresActionSince?: string | null | undefined;
}>;

/**
 * The Site conversation that has just started waiting for the person (an
 * approval or question, such as one from the Site's own `ai.run`), newest
 * first, so the panel can show it. `seen` holds the waits already known;
 * a wait counts once, and the one already open never needs switching to.
 */
export function newlyWaitingConversation(
  sessions: readonly WaitingCandidate[],
  seen: ReadonlySet<string>,
  openId: string | null,
): { next: string | null; seen: Set<string> } {
  const waiting = sessions.filter((session) => session.status === "requires_action");
  const key = (session: WaitingCandidate) => `${session.id}:${session.requiresActionSince ?? ""}`;
  const next = waiting.find((session) => session.id !== openId && !seen.has(key(session)));
  return { next: next?.id ?? null, seen: new Set(waiting.map(key)) };
}

export function clampSiteChatWidth(width: number): number {
  if (!Number.isFinite(width)) return SITE_CHAT_DEFAULT_WIDTH;
  return Math.round(Math.min(SITE_CHAT_MAX_WIDTH, Math.max(SITE_CHAT_MIN_WIDTH, width)));
}

export function readSiteChatPanelLayout(
  storageId: string,
  storage: PanelStorage | null = browserStorage(),
): SiteChatPanelLayout {
  const fallback: SiteChatPanelLayout = {
    width: SITE_CHAT_DEFAULT_WIDTH,
    position: "right",
  };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(storageId);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const { width, position } = value as Record<string, unknown>;
    return {
      width: typeof width === "number" ? clampSiteChatWidth(width) : fallback.width,
      // Layouts saved before the choice existed, or unreadable, keep the right.
      position: position === "left" ? "left" : "right",
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
      JSON.stringify({
        width: clampSiteChatWidth(layout.width),
        position: layout.position,
      }),
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

/** Sites whose open or closed chat is remembered; the least recent is forgotten first. */
const OPEN_MEMORY = 200;

export function siteChatOpenStorageId(subjectId: string): string {
  return ["og.site-view.chat-open", `v${VERSION}`, encodeURIComponent(subjectId)].join(":");
}

/** The view's last default per Site, so a later visit starts with it instead of opening late. */
export function siteChatDefaultStorageId(subjectId: string): string {
  return ["og.site-view.chat-default", `v${VERSION}`, encodeURIComponent(subjectId)].join(":");
}

function readOpenMap(storageId: string, storage: PanelStorage | null): Record<string, boolean> {
  if (!storage) return {};
  try {
    const value: unknown = JSON.parse(storage.getItem(storageId) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

/** Whether this person left the Site's chat open or closed; undefined when they never chose. */
export function readSiteChatOpen(
  storageId: string,
  siteId: string,
  storage: PanelStorage | null = browserStorage(),
): boolean | undefined {
  return readOpenMap(storageId, storage)[siteId];
}

export function writeSiteChatOpen(
  storageId: string,
  siteId: string,
  open: boolean,
  storage: PanelStorage | null = browserStorage(),
): void {
  if (!storage) return;
  const { [siteId]: _previous, ...others } = readOpenMap(storageId, storage);
  // Most recent last, so the oldest choices are the ones dropped.
  const kept = Object.entries(others).slice(-(OPEN_MEMORY - 1));
  try {
    storage.setItem(storageId, JSON.stringify({ ...Object.fromEntries(kept), [siteId]: open }));
  } catch {
    // The choice lasts until the page reloads.
  }
}

/**
 * Whether the Site's chat is open, remembered per person and Site. Until the
 * person chooses, the view decides (`setFallback`): closed for a Site no one
 * has chatted with, open for one that has conversations or was reached from a
 * chat. That default is remembered too, so the next visit starts with it
 * rather than opening the chat once the conversations have loaded.
 * (The Site view also opens it, until the person chooses, wherever the window
 * has room for the chat beside the Site.)
 */
export function useSiteChatOpen(subjectId: string, siteId: string) {
  const storageId = siteChatOpenStorageId(subjectId);
  const defaultId = siteChatDefaultStorageId(subjectId);
  const key = `${storageId}|${siteId}`;
  const [state, setState] = useState(() => ({
    key,
    siteId,
    stored: readSiteChatOpen(storageId, siteId),
    fallback: readSiteChatOpen(defaultId, siteId) ?? false,
  }));
  // Another person signing in keeps the Site's default; another Site starts over.
  const current =
    state.key === key
      ? state
      : {
          key,
          siteId,
          stored: readSiteChatOpen(storageId, siteId),
          fallback:
            state.siteId === siteId
              ? state.fallback
              : (readSiteChatOpen(defaultId, siteId) ?? false),
        };
  if (current !== state) setState(current);
  const setOpen = useCallback(
    (open: boolean) => {
      writeSiteChatOpen(storageId, siteId, open);
      setState((previous) => ({ ...previous, key, stored: open }));
    },
    [key, siteId, storageId],
  );
  const setFallback = useCallback(
    (open: boolean) => {
      if (readSiteChatOpen(defaultId, siteId) !== open) writeSiteChatOpen(defaultId, siteId, open);
      setState((previous) =>
        previous.fallback === open ? previous : { ...previous, fallback: open },
      );
    },
    [defaultId, siteId],
  );
  return {
    open: current.stored ?? current.fallback,
    /** The person chose, so the view's default no longer applies. */
    chosen: current.stored !== undefined,
    setOpen,
    setFallback,
  };
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
