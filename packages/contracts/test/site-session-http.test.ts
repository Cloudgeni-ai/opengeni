import { describe, expect, test } from "bun:test";
import { siteSessionPath } from "../src/site-session-http";

const WORKSPACE = "11111111-2222-4333-8444-555555555555";
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TURN = "99999999-8888-4777-8666-555555555555";

describe("siteSessionPath", () => {
  test("rewrites only the exact conversational session surface", () => {
    const allowed: Array<[string, string]> = [
      ["GET", "/v1/workspaces/site-host/sessions"],
      ["GET", "/v1/workspaces/site-host/sessions?limit=5&cursor=abc"],
      ["POST", "/v1/workspaces/site-host/sessions"],
      ["GET", "/v1/workspaces/site-host/new-session-draft"],
      ["PUT", "/v1/workspaces/site-host/new-session-draft"],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/events`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/events?after=4`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/events/stream`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/events/stream?after=4`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/events`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/queue`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/queue/${TURN}/move`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/queue/${TURN}/edit`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/queue/${TURN}/steer`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/queue/${TURN}/delete`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/composer-draft`],
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/composer-draft`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/composer-draft/submit`],
    ];
    for (const [method, path] of allowed) {
      expect(siteSessionPath(path, WORKSPACE, method)).toBe(
        path.replace("/workspaces/site-host", `/workspaces/${WORKSPACE}`),
      );
    }
  });

  test("keeps the read-only workspace context surface", () => {
    for (const path of [
      "/v1/config/client",
      "/v1/workspaces/site-host",
      "/v1/workspaces/site-host?fields=name",
      "/v1/workspaces/site-host/model-catalog",
      "/v1/workspaces/site-host/live-events/stream",
      "/v1/workspaces/site-host/control-events",
      "/v1/workspaces/site-host/control-events/stream",
      "/v1/workspaces/site-host/interaction-events/stream?after=1",
    ]) {
      expect(() => siteSessionPath(path, WORKSPACE, "GET")).not.toThrow();
      expect(() => siteSessionPath(path, WORKSPACE, "POST")).toThrow(
        "Unsupported Site session API path",
      );
    }
  });

  test("rejects every configuration and control session route", () => {
    const denied: Array<[string, string]> = [
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/tool-policy`],
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/visibility`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/forks`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/steer`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/control`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/api-keys`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/goal`],
      ["PATCH", `/v1/workspaces/site-host/sessions/${SESSION}/goal`],
      ["DELETE", `/v1/workspaces/site-host/sessions/${SESSION}/goal`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/history`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/turns`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/model-context`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/lineage`],
      ["PATCH", `/v1/workspaces/site-host/sessions/${SESSION}`],
      ["DELETE", `/v1/workspaces/site-host/sessions/${SESSION}`],
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/pin`],
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/archive`],
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/variable-sets`],
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/channel`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/realtime`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/codex-account`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/context/clear`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/context/compact`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/viewers`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/fs/read`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/git/status`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/terminal/exec`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/workspace/capture`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/human-input-requests`],
      // Wrong verb on an allowed path.
      ["DELETE", "/v1/workspaces/site-host/sessions"],
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/events`],
      ["DELETE", `/v1/workspaces/site-host/sessions/${SESSION}/events`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/events/stream`],
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/queue`],
      ["DELETE", `/v1/workspaces/site-host/sessions/${SESSION}/queue/${TURN}`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/queue/${TURN}/move`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/queue/${TURN}/promote`],
      ["DELETE", `/v1/workspaces/site-host/sessions/${SESSION}/composer-draft`],
      ["POST", `/v1/workspaces/site-host/sessions/${SESSION}/composer-draft`],
      ["POST", "/v1/workspaces/site-host/new-session-draft"],
      // Query strings cannot smuggle a different route.
      ["PUT", `/v1/workspaces/site-host/sessions/${SESSION}/tool-policy?x=/events`],
      ["GET", `/v1/workspaces/site-host/sessions/${SESSION}/events/stream/extra`],
      // Outside the Site session surface entirely.
      ["GET", "/v1/workspaces/other/sessions"],
      ["GET", `/v1/workspaces/${WORKSPACE}/sessions`],
      ["GET", "/v1/workspaces/site-host/api-keys"],
      ["GET", "/v1/workspaces/site-host/scheduled-tasks"],
      ["GET", "/v1/workspaces/site-host/sessionsx"],
      ["GET", "/v1/workspaces/site-host/sessions/"],
      ["GET", "https://evil.test/"],
      ["GET", "/v1/workspaces/site-host/sessions/../billing"],
      ["GET", "/v1/workspaces/site-host/sessions/%2e%2e/billing"],
      ["GET", "/v1/workspaces/site-host/sessions/./events"],
    ];
    for (const [method, path] of denied) {
      expect(() => siteSessionPath(path, WORKSPACE, method)).toThrow(
        "Unsupported Site session API path",
      );
      // Origin routing from the host must preserve the same path boundary.
      expect(() => siteSessionPath(path, WORKSPACE, method, "published-site")).toThrow(
        "Unsupported Site session API path",
      );
    }
  });

  test("defaults to GET and matches methods case-insensitively", () => {
    expect(siteSessionPath(`/v1/workspaces/site-host/sessions/${SESSION}`, WORKSPACE)).toBe(
      `/v1/workspaces/${WORKSPACE}/sessions/${SESSION}`,
    );
    expect(
      siteSessionPath(`/v1/workspaces/site-host/sessions/${SESSION}/events`, WORKSPACE, "post"),
    ).toBe(`/v1/workspaces/${WORKSPACE}/sessions/${SESSION}/events`);
  });
});
