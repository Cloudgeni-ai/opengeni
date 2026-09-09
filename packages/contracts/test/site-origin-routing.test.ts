import { expect, test } from "bun:test";
import { siteSessionPath } from "../src/site-session-http";

test("current Site list binds to the host identity and preview never widens it", () => {
  const path = "/v1/workspaces/site-host/sessions?originSiteId=current&view=page";
  expect(siteSessionPath(path, "site-host")).toBe(path);
  expect(siteSessionPath(path, "ws", "GET", "site-1")).toBe(
    "/v1/workspaces/ws/sessions?originSiteId=site-1&view=page",
  );
  expect(siteSessionPath(path, "ws")).toContain(
    "originSiteId=00000000-0000-0000-0000-000000000000",
  );
  expect(siteSessionPath("/v1/workspaces/site-host/sessions?channelId=project", "ws")).toBe(
    "/v1/workspaces/ws/sessions?channelId=project",
  );
});
