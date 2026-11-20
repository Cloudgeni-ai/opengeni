import { describe, expect, test } from "bun:test";
import { matchAppPage, splitAppSiteHref } from "./app-page";

const APP = "0f8c1a52-7d4b-4c55-9a1e-2b3c4d5e6f70";

describe("app pages", () => {
  test("the page URL carries the app's own address", () => {
    expect(matchAppPage(`/workspaces/w1/apps/${APP}`, undefined)).toEqual({
      workspaceId: "w1",
      appId: APP,
      siteHref: "/",
    });
    expect(
      matchAppPage(`/workspaces/w1/apps/${APP.toUpperCase()}/releases/2`, "?tab=1#top"),
    ).toEqual({ workspaceId: "w1", appId: APP, siteHref: "/releases/2?tab=1#top" });
    // `at` is only a query or fragment.
    expect(matchAppPage(`/workspaces/w1/apps/${APP}/a`, "//evil")?.siteHref).toBe("/a");
  });

  test("other pages and malformed ids are not app pages", () => {
    expect(matchAppPage(`/workspaces/w1/sites/${APP}`, undefined)).toBeNull();
    expect(matchAppPage("/workspaces/w1/apps/not-an-id", undefined)).toBeNull();
  });

  test("an app's own address splits back into the page URL", () => {
    expect(splitAppSiteHref("/")).toEqual({ splat: "", at: undefined });
    expect(splitAppSiteHref("/releases?tab=2#x")).toEqual({ splat: "releases", at: "?tab=2#x" });
  });
});
