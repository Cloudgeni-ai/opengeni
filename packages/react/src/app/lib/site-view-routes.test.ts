import { expect, test } from "bun:test";
import { railRouteSelection, siteViewSearch, workspaceSitePath } from "./routes";

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
});
