import { expect, test } from "bun:test";
import { appLink } from "../src/app-notify/service";

const scope = { workspaceId: "w1" } as never;

test("an app's notification opens its own page, at its path, and never leaves the app", () => {
  expect(appLink(scope, "a1", undefined)).toBe("/workspaces/w1/apps/a1");
  expect(appLink(scope, "a1", "/")).toBe("/workspaces/w1/apps/a1");
  expect(appLink(scope, "a1", "/releases?tab=2")).toBe(
    "/workspaces/w1/apps/a1/releases?at=%3Ftab%3D2",
  );
  expect(appLink(scope, "a1", "/../../settings")).toBe("/workspaces/w1/apps/a1/settings");
  expect(appLink(scope, "a1", "/a/%2e%2e/b")).toBe("/workspaces/w1/apps/a1/a/b");
  expect(appLink(scope, "a1", "/team notes")).toBe("/workspaces/w1/apps/a1/team%20notes");
});
