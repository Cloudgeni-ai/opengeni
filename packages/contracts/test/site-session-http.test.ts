import { describe, expect, test } from "bun:test";
import { siteSessionPath } from "../src/site-session-http";

const WORKSPACE = "11111111-2222-4333-8444-555555555555";

describe("Site host-owned destination routing", () => {
  test("leaves operation authorization to the API for every workspace resource", () => {
    for (const suffix of [
      "",
      "/sessions",
      "/sessions/one/events?after=4",
      "/sessions/one/control",
      "/sessions/one/visibility",
      "/sessions/one/goal",
      "/sessions/one/tool-policy",
      "/sessions/one/terminal/exec",
      "/scheduled-tasks",
      "/api-keys",
      "/new-session-draft",
    ]) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        expect(siteSessionPath(`/v1/workspaces/site-host${suffix}`, WORKSPACE, method)).toBe(
          `/v1/workspaces/${WORKSPACE}${suffix}`,
        );
      }
    }
    // Forwarding a path is deliberately not a promise that the API permits it.
    expect(siteSessionPath("/v1/config/client", WORKSPACE)).toBe("/v1/config/client");
    expect(() => siteSessionPath("/v1/config/client", WORKSPACE, "POST")).toThrow();
  });

  test("rejects destination escapes independently of the HTTP operation", () => {
    for (const path of [
      "https://evil.test/",
      "//evil.test/v1/workspaces/site-host",
      "/v1/workspaces/other/sessions",
      `/v1/workspaces/${WORKSPACE}/sessions`,
      "/v1/workspaces/site-host-other/sessions",
      "/v1/organizations/one/api-keys",
      "/v1/workspaces/site-host/sessions/../billing",
      "/v1/workspaces/site-host/sessions/%2e%2e/billing",
      "/v1/workspaces/site-host/sessions/./events",
      "/v1/workspaces/site-host/sessions\\other",
      "/v1/workspaces/site-host/sessions#fragment",
    ]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        expect(() => siteSessionPath(path, WORKSPACE, method)).toThrow();
        expect(() => siteSessionPath(path, WORKSPACE, method, "published-site")).toThrow();
      }
    }
  });
});
