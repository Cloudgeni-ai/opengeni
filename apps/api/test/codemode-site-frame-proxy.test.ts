import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import {
  SITE_FRAME_HEADER,
  SITE_FRAME_ID_HEADER,
  SITE_ID_HEADER,
  SITE_NO_ORIGIN_ID,
  SITE_VERSION_HEADER,
  SiteDataUnsupportedError,
  SiteSessionPathError,
} from "@opengeni/contracts/site-session-http";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { codemodeSessionRequest } from "../src/codemode";

// OPE-801: a Codemode local preview forwards page SDK requests through the
// agent's own SDK proxy. Requests it marks as a Site frame are Site code: the
// proxy holds them to SITE_OPERATIONS, and forwards them still marked as a
// preview frame (never as a published Site) so the API records the preview
// as their origin and keeps it to the sessions it started.

const delegationSecret = "codemode-site-frame-test";
const settings = testSettings({ productAccessMode: "managed", delegationSecret });
const restores: (() => void)[] = [];
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
afterEach(() => {
  while (restores.length) restores.pop()!();
});

const grant: AccessGrant = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  subjectId: "sandbox:codemode-fixture",
  permissions: ["codemode:call"],
  principalKind: "agent_attempt",
};
const framed = (method: string, extra: Record<string, string> = {}) =>
  new Request("http://localhost/proxy", {
    method,
    headers: { [SITE_FRAME_HEADER]: "preview", [SITE_FRAME_ID_HEADER]: "frame-1", ...extra },
  });

describe("Codemode SDK proxy and Site preview frames", () => {
  test("a framed request outside SITE_OPERATIONS is refused before any lookup", async () => {
    const deps = { db: {} as never, settings } as core.ApiRouteDeps;
    const refused: Array<[string, string]> = [
      ["PUT", "/v1/workspaces/site-host/sessions/s1/tool-policy"],
      ["PUT", "/v1/workspaces/site-host/sessions/s1/visibility"],
      ["POST", "/v1/workspaces/site-host/sessions/s1/fork"],
      ["GET", "/v1/workspaces/site-host/scheduled-tasks"],
      ["POST", "/v1/workspaces/site-host/scheduled-tasks"],
      ["POST", "/v1/workspaces/site-host/automations/triggers"],
      ["GET", "/v1/workspaces/site-host/files"],
      // A list must name only the frame's own Site.
      ["GET", "/v1/workspaces/site-host/sessions"],
      ["GET", "/v1/workspaces/site-host/sessions?originSiteId=other"],
    ];
    for (const [method, path] of refused) {
      await expect(
        codemodeSessionRequest(deps, grant, framed(method), path),
      ).rejects.toBeInstanceOf(SiteSessionPathError);
    }
    // A preview has no published Site, so it has no Site Data.
    await expect(
      codemodeSessionRequest(
        deps,
        grant,
        framed("GET"),
        "/v1/workspaces/site-host/published-artifacts/current/data",
      ),
    ).rejects.toBeInstanceOf(SiteDataUnsupportedError);
    // The agent's own (unframed) SDK request keeps the workspace prefix
    // boundary: it passes the path check and fails later on the fake deps.
    const own = codemodeSessionRequest(
      deps,
      grant,
      new Request("http://localhost/proxy", { method: "GET" }),
      "/v1/workspaces/site-host/scheduled-tasks",
    );
    await expect(own).rejects.not.toBeInstanceOf(SiteSessionPathError);
  });

  test("an allowed framed request stays a preview frame and never claims a published Site", async () => {
    const authority = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      subjectId: "sandbox:codemode-fixture",
    };
    track(spyOn(core, "requireSessionAuthorization").mockResolvedValue(null));
    track(spyOn(db, "requireWorkspace").mockResolvedValue({ settings: {} } as never));
    track(
      spyOn(db, "getActiveSessionTurnForExecution").mockResolvedValue({
        id: authority.turnId,
        status: "running",
        activeAttemptId: authority.attemptId,
        executionGeneration: 1,
        metadata: {},
      } as never),
    );
    track(
      spyOn(db, "getAttemptToolCatalog").mockResolvedValue({
        version: 1,
        ...authority,
        generation: 1,
        digest: "0".repeat(64),
        createdAt: new Date().toISOString(),
        entries: [{ identity: { serverId: "opengeni", toolName: "session_create" } }],
      } as never),
    );
    track(
      spyOn(db, "getSession").mockResolvedValue({
        id: authority.sessionId,
        firstPartyMcpTools: ["session_create"],
        toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
        firstPartyMcpPermissions: ["workspace:read", "sessions:create", "sessions:read"],
        metadata: {},
      } as never),
    );
    const bearer = await signDelegatedAccessToken(delegationSecret, {
      ...authority,
      principalKind: "agent_attempt",
      permissions: ["codemode:call"],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const deps = { db: {} as never, settings, managedAuth: null } as core.ApiRouteDeps;
    const forwarded: Request[] = [];
    const app = new Hono().all("/", async (c) => {
      const caller = await core.requireAccessGrant(c, deps, authority.workspaceId);
      const path = c.req.query("path")!;
      forwarded.push(await codemodeSessionRequest(deps, caller, c.req.raw, path));
      return c.text("proxied");
    });
    const send = (path: string, headers: Record<string, string>) =>
      app.request(`/?path=${encodeURIComponent(path)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${bearer}`, ...headers },
      });
    // Page code cannot claim a published Site through the preview.
    const response = await send("/v1/workspaces/site-host/sessions?originSiteId=current", {
      [SITE_FRAME_HEADER]: "1",
      [SITE_FRAME_ID_HEADER]: "frame-1",
      [SITE_ID_HEADER]: crypto.randomUUID(),
      [SITE_VERSION_HEADER]: crypto.randomUUID(),
    });
    expect(response.status).toBe(200);
    const [list] = forwarded;
    const url = new URL(list!.url);
    expect(url.pathname).toBe(`/v1/workspaces/${authority.workspaceId}/sessions`);
    expect(url.searchParams.getAll("originSiteId")).toEqual([SITE_NO_ORIGIN_ID]);
    expect(list!.headers.get(SITE_FRAME_HEADER)).toBe("preview");
    expect(list!.headers.get(SITE_FRAME_ID_HEADER)).toBe("frame-1");
    expect(list!.headers.get(SITE_ID_HEADER)).toBeNull();
    expect(list!.headers.get(SITE_VERSION_HEADER)).toBeNull();
    // An invalid frame id is dropped rather than forwarded.
    await send("/v1/workspaces/site-host/sessions/s1", {
      [SITE_FRAME_HEADER]: "preview",
      [SITE_FRAME_ID_HEADER]: "not a valid id!",
    });
    expect(forwarded[1]!.headers.get(SITE_FRAME_HEADER)).toBe("preview");
    expect(forwarded[1]!.headers.get(SITE_FRAME_ID_HEADER)).toBeNull();
  });
});
