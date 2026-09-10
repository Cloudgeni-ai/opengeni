import { expect, test } from "bun:test";
import { siteSessionPath } from "../src/site-session-http";

test("workspace endpoints and methods are authorized by the API, not the bridge", () => {
  for (const suffix of [
    "",
    "/sessions",
    "/projects",
    "/settings",
    "/api-keys",
    "/scheduled-tasks",
    "/sessions/one/tool-policy",
    "/sessions/one/goal",
    "/sessions/one/control",
    "/sessions/one/fs/read",
    "/future-endpoint",
  ]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(
        siteSessionPath(`/v1/workspaces/site-host${suffix}?limit=5`, "ws", method, "site-1"),
      ).toBe(`/v1/workspaces/ws${suffix}?limit=5`);
    }
  }
  expect(siteSessionPath("/v1/config/client", "ws")).toBe("/v1/config/client");
});

test("foreign workspaces and unsafe paths remain rejected", () => {
  for (const path of [
    "https://evil.test/v1/workspaces/site-host/sessions",
    "//evil.test/v1/workspaces/site-host/sessions",
    "/v1/workspaces/other/sessions",
    "/v1/workspaces/ws/sessions",
    "/v1/workspaces/site-host-evil/sessions",
    "/v1/workspaces/site-host/../other",
    "/v1/workspaces/site-host/./sessions",
    "/v1/workspaces/site-host/%2e%2e/other",
    "/v1/workspaces/site-host/%252e%252e/other",
    "/v1/workspaces/site-host/\\../other",
    "/v1/workspaces/site-host/sessions#fragment",
    "/v1/workspaces/site-host/\n../other",
  ]) {
    expect(() => siteSessionPath(path, "ws")).toThrow();
    expect(() => siteSessionPath(path, "ws", "POST", "site-1")).toThrow();
  }
});
