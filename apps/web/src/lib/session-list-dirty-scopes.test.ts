import { expect, test } from "bun:test";
import type { RailSession } from "./session-list-entry";
import {
  emptySessionListDirtyScopes,
  invalidateSessionListScopes,
  sessionListGroupRevision,
} from "./session-list-dirty-scopes";
import { sessionBranchSummaryDecision } from "./session-branch-cache";

const root = {
  id: "root",
  parentSessionId: null,
  channelId: "project",
  createdBy: { kind: "subject", subjectId: "owner" },
} as RailSession;
const child = { ...root, id: "child", parentSessionId: root.id };
const other = { ...root, id: "other", channelId: "other-project" };
const sessions = new Map([root, child, other].map((session) => [session.id, session]));
const project = {
  kind: "channel" as const,
  key: "project",
  channelId: "project",
  label: "Project",
};
const otherProject = { ...project, key: "other-project", channelId: "other-project" };

test("child command hints invalidate their ancestors and project, not unrelated loaded windows", () => {
  const scopes = invalidateSessionListScopes(emptySessionListDirtyScopes(), [child.id], sessions);
  expect(scopes.all).toBe(0);
  expect([...scopes.branches.keys()]).toEqual([child.id, root.id]);
  expect(sessionListGroupRevision(scopes, project)).toBe(1);
  expect(sessionListGroupRevision(scopes, otherProject)).toBe(0);
  const later = invalidateSessionListScopes(scopes, [other.id], sessions);
  expect(sessionListGroupRevision(later, project)).toBe(1);
  expect(sessionListGroupRevision(later, otherProject)).toBe(2);
});

test("reconnect, revoked rows and unknown new children reconcile every loaded scope", () => {
  for (const ids of [null, ["new-child"]]) {
    const scopes = invalidateSessionListScopes(emptySessionListDirtyScopes(), ids, sessions);
    expect(scopes.all).toBe(1);
    expect(sessionListGroupRevision(scopes, otherProject)).toBe(1);
  }
});

test("a dirty generation arriving during a child read is not acknowledged away", () => {
  const input = {
    previousKey: "read:1",
    nextKey: "read:2",
    loading: true,
    expanded: true,
    stale: false,
  };
  expect(sessionBranchSummaryDecision(input)).toEqual({
    acknowledge: false,
    refresh: false,
    markStale: false,
  });
  expect(sessionBranchSummaryDecision({ ...input, loading: false })).toEqual({
    acknowledge: true,
    refresh: true,
    markStale: false,
  });
});
