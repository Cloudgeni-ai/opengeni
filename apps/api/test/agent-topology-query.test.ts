import { describe, expect, test } from "bun:test";

import { agentTopologyQuery, encodeAgentTopologyCursor } from "../src/routes/sessions";

const PARENT_ID = "00000000-0000-4000-8000-000000000001";
const CURSOR = {
  orderBy: "updatedAt" as const,
  sortRank: null,
  sortRevision: "12",
  sortAt: "2026-08-10T10:00:00.123456Z",
  id: "00000000-0000-4000-8000-000000000002",
  snapshotAt: "2026-08-10T10:00:01.123456Z",
  snapshotRevision: "20",
  updatedAfter: null,
  filterHash: null,
};
const RELEVANCE_CURSOR = {
  ...CURSOR,
  orderBy: "relevance" as const,
  sortRank: 10,
  filterHash: "a".repeat(64),
};

describe("agent topology query", () => {
  test("defaults to a bounded root page", () => {
    expect(agentTopologyQuery({})).toEqual({
      limit: 25,
      parentSessionId: null,
      rootSessionId: undefined,
      query: undefined,
      statuses: undefined,
      activeOnly: false,
      recentHours: undefined,
      subject: undefined,
      claimLimit: undefined,
      cursor: undefined,
    });
  });

  test("round-trips a cursor only with its original branch filters", () => {
    const cursor = encodeAgentTopologyCursor({
      cursor: CURSOR,
      parentSessionId: PARENT_ID,
      rootSessionId: null,
      query: null,
      statuses: [],
      activeOnly: false,
      recentHours: null,
      subject: null,
      claimLimit: null,
    });
    expect(agentTopologyQuery({ parentSessionId: PARENT_ID, cursor })).toMatchObject({
      parentSessionId: PARENT_ID,
      cursor: CURSOR,
    });
    expect(() => agentTopologyQuery({ parentSessionId: "null", cursor })).toThrow(
      "cursor does not match",
    );

    const globalCursor = encodeAgentTopologyCursor({
      cursor: RELEVANCE_CURSOR,
      parentSessionId: "all",
      rootSessionId: null,
      query: "rollout",
      statuses: [],
      activeOnly: false,
      recentHours: null,
      subject: null,
      claimLimit: null,
    });
    expect(agentTopologyQuery({ query: "rollout", cursor: globalCursor })).toMatchObject({
      parentSessionId: undefined,
      cursor: RELEVANCE_CURSOR,
    });
    expect(() =>
      agentTopologyQuery({ query: "rollout", parentSessionId: "null", cursor: globalCursor }),
    ).toThrow("cursor does not match");
  });

  test("rejects invalid limits, parents, searches, and cursors", () => {
    expect(() => agentTopologyQuery({ limit: "101" })).toThrow("between 1 and 100");
    expect(() => agentTopologyQuery({ parentSessionId: "not-a-uuid" })).toThrow("parentSessionId");
    expect(() => agentTopologyQuery({ search: "x".repeat(201) })).toThrow("at most 200");
    expect(() => agentTopologyQuery({ query: "bad\u0000query" })).toThrow("control characters");
    expect(() => agentTopologyQuery({ query: "bad\tquery" })).toThrow("control characters");
    expect(() =>
      agentTopologyQuery({
        query: "rollout",
        subjectNamespace: "github",
        subjectType: "pull_request",
        subjectKey: "Cloudgeni-ai/opengeni#1840",
      }),
    ).toThrow("cannot be combined");
    expect(() => agentTopologyQuery({ cursor: "not-a-cursor" })).toThrow("cursor is invalid");
  });

  test("parses bounded lifecycle, recency, root, and exact-subject filters", () => {
    const parsed = agentTopologyQuery({
      statuses: "running,requires_action,running",
      activeOnly: "true",
      recentHours: "72",
      rootSessionId: PARENT_ID,
      subjectNamespace: " GitHub ",
      subjectType: "pull_request",
      subjectKey: " Cafe\u0301#1840 ",
      claimLimit: "4",
    });
    expect(parsed).toMatchObject({
      statuses: ["requires_action", "running"],
      activeOnly: true,
      recentHours: 72,
      rootSessionId: PARENT_ID,
      subject: {
        namespace: "github",
        type: "pull_request",
        canonicalKey: "Café#1840",
      },
      claimLimit: 4,
    });
    expect(parsed.parentSessionId).toBeUndefined();
  });

  test("normalizes query text and lifecycle order before cursor binding", () => {
    const parsed = agentTopologyQuery({
      query: "  Cafe\u0301   rollout  ",
      statuses: "running,idle,running",
    });
    expect(parsed).toMatchObject({
      query: "café rollout",
      statuses: ["idle", "running"],
    });
    expect(parsed.parentSessionId).toBeUndefined();
    expect(
      agentTopologyQuery({ query: "rollout", parentSessionId: "null" }).parentSessionId,
    ).toBeNull();
  });
});
