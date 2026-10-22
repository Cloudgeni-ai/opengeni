import { describe, expect, test } from "bun:test";

import { OPENGENI_WEB_PATHS, type AppWebPaths } from "@opengeni/sdk/app-links";

import { reopenablePath } from "../src/main/page-paths";

describe("reopening the last page", () => {
  test("Opengeni's workspace and session pages, not others", () => {
    expect(
      reopenablePath("https://app.example.com/workspaces/w1/sessions/s1?at=4", OPENGENI_WEB_PATHS),
    ).toEqual({ path: "/workspaces/w1/sessions/s1", workspaceId: "w1" });
    expect(
      reopenablePath("https://app.example.com/workspaces/w1/settings", OPENGENI_WEB_PATHS),
    ).toBeNull();
    expect(reopenablePath("not a url", OPENGENI_WEB_PATHS)).toBeNull();
    expect(reopenablePath("custom://open", OPENGENI_WEB_PATHS)).toBeNull();
  });

  test("a product page whose address names no workspace", () => {
    const paths: AppWebPaths = {
      home: (w) => `/open/${w}`,
      session: (w, s) => `/open/${w}/${s}`,
      inbox: (w) => `/open/${w}/inbox`,
      match: (path) =>
        /^\/org\/[\w-]+\/chat\/[\w-]+$/u.test(path) ? { workspaceId: null, sessionId: null } : null,
    };
    expect(reopenablePath("https://app.example.com/org/acme/chat/c1", paths)).toEqual({
      path: "/org/acme/chat/c1",
      workspaceId: null,
    });
    expect(reopenablePath("https://app.example.com/org/acme/billing", paths)).toBeNull();
  });
});
