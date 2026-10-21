import { expect, test } from "bun:test";
import { SiteSessionPathError, siteSessionPath } from "../src/site-session-http";

test("current Site list binds to the host identity and preview never widens it", () => {
  const path = "/v1/workspaces/site-host/sessions?originSiteId=current&view=page";
  expect(siteSessionPath(path, "site-host")).toBe(path);
  expect(siteSessionPath(path, "ws", "GET", "site-1")).toBe(
    "/v1/workspaces/ws/sessions?originSiteId=site-1&view=page",
  );
  expect(siteSessionPath(path, "ws")).toContain(
    "originSiteId=00000000-0000-0000-0000-000000000000",
  );
  // A project filter narrows the Site's own list; it never replaces it.
  expect(
    siteSessionPath(
      "/v1/workspaces/site-host/sessions?originSiteId=current&channelId=project",
      "ws",
      "GET",
      "site-1",
    ),
  ).toBe("/v1/workspaces/ws/sessions?originSiteId=site-1&channelId=project");
});

test("a Site list that does not name exactly its own Site is refused", () => {
  for (const query of [
    "",
    "?channelId=project",
    "?originSiteId=11111111-2222-4333-8444-555555555555",
    "?originSiteId=current&originSiteId=11111111-2222-4333-8444-555555555555",
    "?originSiteId=",
  ]) {
    for (const workspace of ["ws", "site-host"])
      expect(() =>
        siteSessionPath(`/v1/workspaces/site-host/sessions${query}`, workspace, "GET", "site-1"),
      ).toThrow(SiteSessionPathError);
  }
});
