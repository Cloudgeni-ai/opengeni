/*
 * The bottom bar's places: Chats (Home), Artifacts and Meetings; a place is
 * one entry in APP_TABS. Home stays at the bottom of the stack; another place sits on top
 * of it, and moving between those replaces the top, so the stack never grows
 * from switching. Kept free of React Native so it is tested directly.
 */

export type AppTab = "chats" | "artifacts" | "meetings";

export const APP_TABS: readonly {
  tab: AppTab;
  label: string;
  icon: "message-square" | "panels-top-left" | "audio-lines";
  path: "/" | "/artifacts" | "/meetings";
}[] = [
  { tab: "chats", label: "Chats", icon: "message-square", path: "/" },
  { tab: "artifacts", label: "Artifacts", icon: "panels-top-left", path: "/artifacts" },
  { tab: "meetings", label: "Meetings", icon: "audio-lines", path: "/meetings" },
];

/** The bar's place for a screen path, or null on screens without the bar. */
export function tabForPath(pathname: string): AppTab | null {
  const path = pathname.replace(/\/+$/u, "") || "/";
  return APP_TABS.find((entry) => entry.path === path)?.tab ?? null;
}

export type TabNavigation =
  | { kind: "stay" }
  /** Back to Home, closing everything above it. */
  | { kind: "home" }
  /** Open the place above Home (from Home itself). */
  | { kind: "push"; path: string }
  /** Swap the place on top for another (from a place above Home). */
  | { kind: "replace"; path: string }
  /** Close what is open above Home (a menu, a chat), then open the place. */
  | { kind: "home-then-push"; path: string };

/**
 * How to get from where the person is to a place. `from` is the bar's place
 * they are on, or null from elsewhere (the side menu, a chat).
 */
export function tabNavigation(from: AppTab | null, to: AppTab): TabNavigation {
  if (from === to) return { kind: "stay" };
  if (to === "chats") return { kind: "home" };
  const path = APP_TABS.find((entry) => entry.tab === to)!.path;
  if (from === "chats") return { kind: "push", path };
  if (from === null) return { kind: "home-then-push", path };
  return { kind: "replace", path };
}

/** Where a swipe from the left edge may start, in points from the edge. */
export const EDGE_SWIPE_WIDTH = 24;
/** How far right it must travel, or how fast, to open the chats menu. */
export const EDGE_SWIPE_DISTANCE = 56;
export const EDGE_SWIPE_VELOCITY = 600;

/**
 * A swipe right that started at the left edge opens the chats menu: far or
 * fast enough, and more sideways than up or down so a scroll never opens it.
 */
export function edgeSwipeOpensDrawer(swipe: {
  startX: number;
  dx: number;
  dy: number;
  vx: number;
}): boolean {
  if (swipe.startX > EDGE_SWIPE_WIDTH || swipe.dx <= 0) return false;
  if (Math.abs(swipe.dy) > Math.abs(swipe.dx)) return false;
  return swipe.dx >= EDGE_SWIPE_DISTANCE || swipe.vx >= EDGE_SWIPE_VELOCITY;
}

/** The bar's row; it docks at the bottom with the screen's content laid out above it. */
export const TAB_BAR_HEIGHT = 52;
/** The bar's whole height: its row, then the home indicator's area (a little room without one). */
export function tabBarHeight(bottomInset: number): number {
  return TAB_BAR_HEIGHT + Math.max(bottomInset, 6);
}
