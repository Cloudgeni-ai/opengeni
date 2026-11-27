import { describe, expect, test } from "bun:test";
import { appRowActive } from "./app-page-location";

describe("appRowActive", () => {
  const ws = "w1";
  const app = "a1";
  test("the app's row stays highlighted anywhere in the app and on its Site view", () => {
    expect(appRowActive("/workspaces/w1/apps/a1", ws, app)).toBe(true);
    expect(appRowActive("/workspaces/w1/apps/a1/", ws, app)).toBe(true);
    expect(appRowActive("/workspaces/w1/apps/a1/releases", ws, app)).toBe(true);
    expect(appRowActive("/workspaces/w1/sites/a1", ws, app)).toBe(true);
  });
  test("other apps and pages don't highlight it", () => {
    expect(appRowActive("/workspaces/w1/apps/a10", ws, app)).toBe(false);
    expect(appRowActive("/workspaces/w1/apps", ws, app)).toBe(false);
    expect(appRowActive("/workspaces/w2/apps/a1", ws, app)).toBe(false);
  });
  test("a row for one of the app's pages only on that page", () => {
    expect(appRowActive("/workspaces/w1/apps/a1/releases", ws, app, "releases")).toBe(true);
    expect(appRowActive("/workspaces/w1/apps/a1", ws, app, "releases")).toBe(false);
  });
});
