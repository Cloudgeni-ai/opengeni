import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// The route's own checks: the link must be one of the chat's pull requests
// (as a session read), and a failed GitHub read answers 502. Access checks are
// stubbed to pass with a service grant; the per-person fallback and its cache
// isolation are covered in session-link-pull-request.test.ts.
const realCore = await import("@opengeni/core");
const realDb = await import("@opengeni/db");
const authorizationCalls: string[] = [];
mock.module("@opengeni/core", () => ({
  ...realCore,
  requireAccessGrantAuthorization: async () => ({
    grant: { kind: "service", workspaceId: "ws-route", subjectId: "service:test" },
  }),
  requireSessionAuthorization: async (
    _deps: unknown,
    _grant: unknown,
    input: { operation: string },
  ) => {
    authorizationCalls.push(input.operation);
  },
}));
const LINKS = [
  { id: "pr", url: "https://github.com/acme/api/pull/7", provider: "github", kind: "pull_request" },
  { id: "issue", url: "https://linear.app/acme/issue/A-1", provider: "linear", kind: "issue" },
];
mock.module("@opengeni/db", () => ({
  ...realDb,
  getSessionLinks: async (_db: unknown, _workspaceId: string, sessionId: string) =>
    sessionId === "s1" ? LINKS : null,
}));

const { registerSessionLinkPullRequestRoutes } =
  await import("../src/routes/session-link-pull-request");

function app(reader: (workspaceId: string, link: { id: string }) => Promise<unknown>) {
  const hono = new Hono();
  registerSessionLinkPullRequestRoutes(hono, {} as never, reader as never);
  return hono;
}

const path = (session: string, link: string, query = "", workspace = "ws-route") =>
  `/v1/workspaces/${workspace}/sessions/${session}/links/${link}/pull-request${query}`;

describe("the linked pull request route", () => {
  test("reads only the chat's own pull request links, as a session read", async () => {
    const read: string[] = [];
    const hono = app(async (_workspaceId, link) => {
      read.push(link.id);
      return { title: "Faster diffs" };
    });
    const ok = await hono.request(path("s1", "pr"));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { pullRequest: { title: string } }).pullRequest.title).toBe(
      "Faster diffs",
    );
    expect((await hono.request(path("s1", "issue"))).status).toBe(404);
    expect((await hono.request(path("s1", "missing"))).status).toBe(404);
    expect((await hono.request(path("s2", "pr"))).status).toBe(404);
    expect(read).toEqual(["pr"]);
    expect(new Set(authorizationCalls)).toEqual(new Set(["session.read"]));
  });

  test("a failed GitHub read answers 502", async () => {
    const hono = app(async () => {
      throw new Error("GitHub 503");
    });
    const response = await hono.request(path("s1", "pr", "?fresh=true", "ws-failing"));
    expect(response.status).toBe(502);
  });
});
