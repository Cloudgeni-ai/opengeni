import { expect, test } from "bun:test";
import {
  railRouteSelection,
  siteViewArtifactsReturn,
  siteViewSearch,
  workspaceSitePath,
} from "./routes";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

test("the rail marks a session page's session", () => {
  expect(
    railRouteSelection({
      pathname: `/workspaces/${workspaceId}/sessions/${sessionId}`,
      search: {},
    }),
  ).toEqual({ sessionId, siteId: null });
});

test("the rail marks a Site view's Site, and its selected conversation", () => {
  const pathname = `/workspaces/${workspaceId}/sites/${siteId}`;
  expect(railRouteSelection({ pathname, search: {} })).toEqual({ sessionId: null, siteId });
  expect(railRouteSelection({ pathname, search: { conversation: sessionId } })).toEqual({
    sessionId,
    siteId,
  });
  // A malformed conversation selects nothing rather than an arbitrary row.
  expect(railRouteSelection({ pathname, search: { conversation: "../x" } })).toEqual({
    sessionId: null,
    siteId,
  });
});

test("other pages mark nothing", () => {
  for (const pathname of [
    `/workspaces/${workspaceId}/artifacts/${siteId}`,
    `/workspaces/${workspaceId}/sites`,
    `/workspaces/${workspaceId}/sites/${siteId}/extra`,
    // Not a Site id, including a malformed escape that can't be decoded.
    `/workspaces/${workspaceId}/sites/%E0`,
    `/workspaces/${workspaceId}/sites/not-a-site`,
  ])
    expect(railRouteSelection({ pathname, search: { conversation: sessionId } })).toEqual({
      sessionId: null,
      siteId: null,
    });
});

test("Site view links and search", () => {
  expect(workspaceSitePath(workspaceId, siteId)).toBe(`/workspaces/${workspaceId}/sites/${siteId}`);
  expect(workspaceSitePath(workspaceId, siteId, sessionId)).toBe(
    `/workspaces/${workspaceId}/sites/${siteId}?conversation=${sessionId}`,
  );
  expect(siteViewSearch({ conversation: sessionId, other: 1 })).toEqual({
    conversation: sessionId,
  });
  expect(siteViewSearch({ conversation: 42 })).toEqual({ conversation: undefined });
  // Edit with Opengeni asks for a new conversation; anything else is no request.
  for (const asked of [true, "true", 1]) expect(siteViewSearch({ new: asked }).new).toBe(true);
  for (const other of [false, "false", 0, "yes", undefined])
    expect(siteViewSearch({ new: other }).new).toBeUndefined();
  // The Site's own address: a path within the Site, its root when omitted.
  expect(siteViewSearch({ page: "/unsubscribe?t=abc#done" }).page).toBe("/unsubscribe?t=abc#done");
  for (const other of ["/", "admin", "https://example.com/", 3, undefined])
    expect(siteViewSearch({ page: other }).page).toBeUndefined();
});

test("a Site view opened from the Artifacts page keeps that page's query for its Back", () => {
  const fromList = {
    browse: true,
    kind: "site",
    q: "usage",
    sort: "title",
    status: "archived",
    fromSession: sessionId,
  } as const;
  expect(siteViewArtifactsReturn(fromList)).toEqual(fromList);
  expect(siteViewSearch({ ...fromList, conversation: sessionId })).toMatchObject({
    conversation: sessionId,
    ...fromList,
  });
  // Only the keys that are set, so the Site view's address stays short.
  expect(siteViewArtifactsReturn({ browse: true })).toEqual({ browse: true });
  // Without `browse` the Site wasn't opened from the list: no Back, and its
  // query (from a hand-edited address) is not carried either.
  for (const search of [
    { kind: "site", q: "usage" },
    { browse: "yes", kind: "site" },
  ])
    expect(siteViewArtifactsReturn(search)).toEqual({});
  const plain = siteViewSearch({ kind: "site", q: "usage" });
  expect([plain.browse, plain.kind, plain.q]).toEqual([undefined, undefined, undefined]);
  // Invalid values are dropped, as on the Artifacts page.
  expect(
    siteViewArtifactsReturn({ browse: true, kind: "rocket", sort: "x", fromSession: "1" }),
  ).toEqual({ browse: true });
});
