import { expect, test } from "bun:test";
import {
  APP_TABS,
  EDGE_SWIPE_DISTANCE,
  edgeSwipeOpensDrawer,
  tabBarHeight,
  tabBadge,
  tabForPath,
  tabNavigation,
  TAB_BAR_HEIGHT,
} from "./app-tabs";

test("the bar has Chats, Artifacts, Meetings and Inbox, in that order", () => {
  expect(APP_TABS.map((entry) => entry.label)).toEqual(["Chats", "Artifacts", "Meetings", "Inbox"]);
});

test("each place is found from its screen path", () => {
  expect(tabForPath("/")).toBe("chats");
  expect(tabForPath("/artifacts")).toBe("artifacts");
  expect(tabForPath("/meetings/")).toBe("meetings");
  expect(tabForPath("/inbox")).toBe("inbox");
  // Automations opens from the chats menu, not the bar.
  expect(tabForPath("/automations")).toBeNull();
  expect(tabForPath("/artifact/abc")).toBeNull();
  expect(tabForPath("/session/1")).toBeNull();
});

test("switching places never grows the stack", () => {
  expect(tabNavigation("chats", "chats")).toEqual({ kind: "stay" });
  expect(tabNavigation("chats", "artifacts")).toEqual({ kind: "push", path: "/artifacts" });
  expect(tabNavigation("artifacts", "meetings")).toEqual({ kind: "replace", path: "/meetings" });
  expect(tabNavigation("meetings", "chats")).toEqual({ kind: "home" });
  expect(tabNavigation("inbox", "artifacts")).toEqual({ kind: "replace", path: "/artifacts" });
  expect(tabNavigation(null, "artifacts")).toEqual({
    kind: "home-then-push",
    path: "/artifacts",
  });
  expect(tabNavigation(null, "chats")).toEqual({ kind: "home" });
});

test("a swipe right from the left edge opens the chats menu", () => {
  expect(edgeSwipeOpensDrawer({ startX: 4, dx: EDGE_SWIPE_DISTANCE, dy: 6, vx: 100 })).toBe(true);
  // Short but fast.
  expect(edgeSwipeOpensDrawer({ startX: 10, dx: 20, dy: 2, vx: 900 })).toBe(true);
});

test("other swipes don't open it", () => {
  // Started away from the edge.
  expect(edgeSwipeOpensDrawer({ startX: 80, dx: 200, dy: 0, vx: 1000 })).toBe(false);
  // Leftwards.
  expect(edgeSwipeOpensDrawer({ startX: 4, dx: -120, dy: 0, vx: -900 })).toBe(false);
  // Mostly a scroll.
  expect(edgeSwipeOpensDrawer({ startX: 4, dx: 70, dy: 140, vx: 300 })).toBe(false);
  // Too short and slow.
  expect(edgeSwipeOpensDrawer({ startX: 4, dx: 30, dy: 0, vx: 100 })).toBe(false);
});

test("the docked bar takes its row plus the home indicator's area", () => {
  // Slim: no taller than iOS's own tab bar row (49pt).
  expect(TAB_BAR_HEIGHT).toBeLessThanOrEqual(49);
  expect(tabBarHeight(34)).toBe(TAB_BAR_HEIGHT + 34);
  expect(tabBarHeight(0)).toBe(TAB_BAR_HEIGHT + 6);
});

test("Inbox's badge counts what waits, capped at 99+", () => {
  expect(tabBadge(0)).toBeNull();
  expect(tabBadge(3)).toBe("3");
  expect(tabBadge(120)).toBe("99+");
});
