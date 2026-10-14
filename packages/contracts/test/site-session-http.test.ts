import { expect, test } from "bun:test";
import {
  SITE_FRAME_HEADER,
  SITE_FRAME_ID_HEADER,
  SITE_ID_HEADER,
  SITE_NO_ORIGIN_ID,
  SITE_VERSION_HEADER,
  SiteDataUnsupportedError,
  SiteSessionPathError,
  siteFrameFromHeaders,
  siteFrameOperation,
  siteHostWorkspacePath,
  siteSessionPath,
} from "../src/site-session-http";

const host = "/v1/workspaces/site-host";

test("Site code reaches only the SITE_OPERATIONS allowlist", () => {
  for (const [method, suffix] of [
    ["GET", ""],
    ["GET", "/model-catalog"],
    ["POST", "/sessions"],
    ["GET", "/sessions/one"],
    ["GET", "/sessions/one/events"],
    ["GET", "/sessions/one/events/stream"],
    ["POST", "/sessions/one/events"],
    ["POST", "/sessions/one/steer"],
    ["POST", "/sessions/one/control"],
    ["GET", "/sessions/one/queue"],
    ["POST", "/sessions/one/queue/turn/edit"],
    ["GET", "/sessions/one/composer-draft"],
    ["PUT", "/sessions/one/composer-draft"],
    ["POST", "/sessions/one/composer-draft/submit"],
    ["GET", "/sessions/one/human-input-requests"],
    ["GET", "/sessions/one/human-input-requests/req"],
  ] as const) {
    expect(siteSessionPath(`${host}${suffix}?limit=5`, "ws", method, "site-1")).toBe(
      `/v1/workspaces/ws${suffix}?limit=5`,
    );
    // The in-Site check leaves the path unresolved.
    expect(siteSessionPath(`${host}${suffix}`, "site-host", method)).toBe(`${host}${suffix}`);
  }
  expect(siteSessionPath("/v1/config/client", "ws")).toBe("/v1/config/client");
});

test("every other workspace route and method is refused before any request", () => {
  for (const suffix of [
    "/projects",
    "/settings",
    "/api-keys",
    "/scheduled-tasks",
    "/scheduled-tasks/one/trigger",
    "/automations/sources",
    "/automations/triggers",
    "/tools/calls",
    "/files",
    "/new-session-draft",
    "/sessions/one/tool-policy",
    "/sessions/one/goal",
    "/sessions/one/fork",
    "/sessions/one/visibility",
    "/sessions/one/turns",
    "/sessions/one/fs/read",
    "/published-artifacts",
    "/future-endpoint",
  ]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(() => siteSessionPath(`${host}${suffix}`, "ws", method, "site-1")).toThrow(
        SiteSessionPathError,
      );
      expect(() => siteSessionPath(`${host}${suffix}`, "site-host", method)).toThrow(
        SiteSessionPathError,
      );
    }
  }
  // Allowed paths with a method outside the allowlist.
  for (const [method, suffix] of [
    ["DELETE", "/sessions/one"],
    ["PATCH", "/sessions/one"],
    ["PUT", "/sessions/one/events"],
    ["GET", "/sessions/one/steer"],
    ["GET", "/sessions/one/control"],
    ["POST", ""],
  ] as const)
    expect(() => siteSessionPath(`${host}${suffix}`, "ws", method, "site-1")).toThrow(
      SiteSessionPathError,
    );
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
    "/v1/workspaces/site-host/sessions/a%2fb",
  ]) {
    expect(() => siteSessionPath(path, "ws")).toThrow();
    expect(() => siteSessionPath(path, "ws", "POST", "site-1")).toThrow();
    expect(() => siteHostWorkspacePath(path, "ws")).toThrow();
  }
});

test("Site Data paths reach only the host's own Site, as current", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  for (const suffix of [
    "/data",
    "/data/query",
    "/data/collections/x/export",
    "/files",
    "/files/abc",
  ]) {
    const named = `${host}/published-artifacts/${id}${suffix}`;
    const current = `${host}/published-artifacts/current${suffix}`;
    // Every host refuses an explicit Site id, pinned or not.
    expect(() => siteSessionPath(named, "ws", "POST", "site-1")).toThrow(SiteSessionPathError);
    expect(() => siteSessionPath(named, "ws")).toThrow(SiteSessionPathError);
    expect(() => siteSessionPath(named, "site-host")).toThrow(SiteSessionPathError);
    expect(() => siteHostWorkspacePath(named, "ws")).toThrow(SiteSessionPathError);
    // A pinned host resolves current to its own Site.
    expect(siteSessionPath(current, "ws", "POST", "site-1")).toBe(
      `/v1/workspaces/ws/published-artifacts/site-1${suffix}`,
    );
    // An unpinned host (inline HTML, previews) and an agent's own proxy serve no Site Data.
    expect(() => siteSessionPath(current, "ws")).toThrow(SiteDataUnsupportedError);
    expect(() => siteHostWorkspacePath(current, "ws")).toThrow(SiteDataUnsupportedError);
  }
  // Other published-artifact routes are not Site operations.
  expect(() => siteSessionPath(`${host}/published-artifacts/${id}`, "ws")).toThrow(
    SiteSessionPathError,
  );
});

test("an agent's own Codemode SDK proxy keeps the workspace prefix boundary", () => {
  for (const suffix of ["", "/sessions", "/sessions/one/goal", "/connect/attempts", "/api-keys"]) {
    expect(siteHostWorkspacePath(`${host}${suffix}?x=1`, "ws")).toBe(
      `/v1/workspaces/ws${suffix}?x=1`,
    );
  }
  expect(siteHostWorkspacePath("/v1/config/client", "ws")).toBe("/v1/config/client");
  expect(siteHostWorkspacePath(`${host}/sessions?originSiteId=current`, "ws")).toBe(
    `/v1/workspaces/ws/sessions?originSiteId=${SITE_NO_ORIGIN_ID}`,
  );
});

test("the API maps a framed workspace request back onto the allowlist", () => {
  const ws = "ws-1";
  const site = "11111111-2222-4333-8444-555555555555";
  const op = (method: string, path: string, frameSite: string | null) =>
    siteFrameOperation(method, path, ws, frameSite);
  expect(op("POST", `/v1/workspaces/${ws}/sessions`, null)?.operation.id).toBe("sessions.create");
  const send = op("POST", `/v1/workspaces/${ws}/sessions/s-1/events`, site);
  expect(send?.operation.id).toBe("sessions.send");
  expect(send?.sessionId).toBe("s-1");
  expect(op("GET", `/v1/workspaces/${ws}`, null)?.operation.id).toBe("workspace.get");
  expect(op("GET", "/v1/config/client", null)?.operation.id).toBe("config.client");
  expect(
    op("POST", `/v1/workspaces/${ws}/published-artifacts/${site}/data/query`, site)?.operation.id,
  ).toBe("data.write");
  for (const [method, path, frameSite] of [
    ["POST", `/v1/workspaces/${ws}/scheduled-tasks`, site],
    ["POST", `/v1/workspaces/${ws}/scheduled-tasks/t-1/trigger`, null],
    ["POST", `/v1/workspaces/${ws}/automations/sources`, null],
    ["POST", `/v1/workspaces/${ws}/sessions/s-1/tool-policy`, site],
    ["GET", `/v1/workspaces/other/sessions`, site],
    ["POST", `/v1/workspaces/${ws}/published-artifacts/other/data/query`, site],
    ["POST", `/v1/workspaces/${ws}/published-artifacts/${site}/data/query`, null],
    ["POST", `/v1/workspaces/${ws}/published-artifacts/current/data/query`, site],
    ["GET", `/v1/workspaces/${ws}/sessions/%2e%2e`, site],
  ] as const)
    expect(op(method, path, frameSite)).toBeNull();
});

test("frame headers are read only from the host-set names", () => {
  const headers = new Headers({
    [SITE_FRAME_HEADER]: "1",
    [SITE_FRAME_ID_HEADER]: "frame-1",
    [SITE_ID_HEADER]: "site-1",
    [SITE_VERSION_HEADER]: "version-1",
  });
  expect(siteFrameFromHeaders((name) => headers.get(name))).toEqual({
    marker: "1",
    frameId: "frame-1",
    siteId: "site-1",
    versionId: "version-1",
  });
  expect(siteFrameFromHeaders(() => undefined)).toBeNull();
  expect(siteFrameFromHeaders((name) => (name === SITE_FRAME_HEADER ? "1" : null))).toEqual({
    marker: "1",
    frameId: null,
    siteId: null,
    versionId: null,
  });
});
