/*
 * The bottom bar's places: Chats (Home), Artifacts, Meetings and Inbox; a
 * place is one entry in APP_TABS. Home stays at the bottom of the stack; another place sits on top
 * of it, and moving between those replaces the top, so the stack never grows
 * from switching. Kept free of React Native so it is tested directly.
 */

export type AppTab = "chats" | "artifacts" | "meetings" | "inbox";

export const APP_TABS: readonly {
  tab: AppTab;
  label: string;
  icon: "message-square" | "panels-top-left" | "audio-lines" | "inbox";
  path: "/" | "/artifacts" | "/meetings" | "/inbox";
}[] = [
  { tab: "chats", label: "Chats", icon: "message-square", path: "/" },
  { tab: "artifacts", label: "Artifacts", icon: "panels-top-left", path: "/artifacts" },
  { tab: "meetings", label: "Meetings", icon: "audio-lines", path: "/meetings" },
  { tab: "inbox", label: "Inbox", icon: "inbox", path: "/inbox" },
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

/** The pill's height: an icon over a small label, with room for the filled highlight. */
export const TAB_BAR_HEIGHT = 56;
/** Page background between the content's end and the pill. */
export const TAB_BAR_GAP = 8;
/** The pill's distance from each side of the screen. */
export const TAB_BAR_SIDE = 20;

/** The badge on Inbox: what waits on the person, capped as iOS does. */
export function tabBadge(waiting: number): string | null {
  if (waiting <= 0) return null;
  return waiting > 99 ? "99+" : String(waiting);
}

/**
 * The bar's places the person keeps: the sidebar layout's hidden entries
 * (docs/sidebar-layout.md, `hiddenNavEntries`) leave Artifacts, Meetings or
 * Inbox out, as on the web's rail. Chats always stays, and so does the place
 * in use, Meetings while it records and Inbox while something waits.
 */
export function visibleAppTabs(
  hidden: readonly string[],
  keep: { current: AppTab; recording: boolean; inboxWaiting: boolean },
): (typeof APP_TABS)[number][] {
  return APP_TABS.filter(
    (entry) =>
      entry.tab === "chats" ||
      entry.tab === keep.current ||
      (entry.tab === "meetings" && keep.recording) ||
      (entry.tab === "inbox" && keep.inboxWaiting) ||
      !hidden.includes(entry.tab),
  );
}
/**
 * The pill's distance from the bottom: just above the home indicator, as in
 * Claude, and a little room on phones without one.
 */
export function tabBarBottomGap(bottomInset: number): number {
  return Math.max(bottomInset - 12, 10);
}

/**
 * The strip the pill takes under a screen's content: a gap, the pill, then the
 * room to the bottom edge. The content ends above it, so nothing sits behind
 * the pill.
 */
export function tabBarHeight(bottomInset: number): number {
  return TAB_BAR_GAP + TAB_BAR_HEIGHT + tabBarBottomGap(bottomInset);
}
