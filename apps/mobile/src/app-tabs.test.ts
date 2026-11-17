import { expect, test } from "bun:test";
import {
  APP_TABS,
  EDGE_SWIPE_DISTANCE,
  edgeSwipeOpensDrawer,
  tabBarHeight,
  tabForPath,
  tabNavigation,
  TAB_BAR_HEIGHT,
} from "./app-tabs";

test("the bar has Chats, Artifacts, Automations and Meetings, in that order", () => {
  expect(APP_TABS.map((entry) => entry.label)).toEqual([
    "Chats",
    "Artifacts",
    "Automations",
    "Meetings",
  ]);
});

test("each place is found from its screen path", () => {
  expect(tabForPath("/")).toBe("chats");
  expect(tabForPath("/artifacts")).toBe("artifacts");
  expect(tabForPath("/automations/")).toBe("automations");
  expect(tabForPath("/meetings")).toBe("meetings");
  expect(tabForPath("/artifact/abc")).toBeNull();
  expect(tabForPath("/session/1")).toBeNull();
});

test("switching places never grows the stack", () => {
  expect(tabNavigation("chats", "chats")).toEqual({ kind: "stay" });
  expect(tabNavigation("chats", "artifacts")).toEqual({ kind: "push", path: "/artifacts" });
  expect(tabNavigation("artifacts", "meetings")).toEqual({ kind: "replace", path: "/meetings" });
  expect(tabNavigation("automations", "chats")).toEqual({ kind: "home" });
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
  expect(TAB_BAR_HEIGHT).toBeLessThan(56);
  expect(tabBarHeight(34)).toBe(TAB_BAR_HEIGHT + 34);
  expect(tabBarHeight(0)).toBe(TAB_BAR_HEIGHT + 6);
});
