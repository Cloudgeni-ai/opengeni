import { describe, expect, test } from "bun:test";

import { agentTopologyQuery, encodeAgentTopologyCursor } from "../src/routes/sessions";

const PARENT_ID = "00000000-0000-4000-8000-000000000001";
const CURSOR = {
  orderBy: "updatedAt" as const,
  sortRevision: "12",
  sortAt: "2026-08-10T10:00:00.123456Z",
  id: "00000000-0000-4000-8000-000000000002",
  snapshotAt: "2026-08-10T10:00:01.123456Z",
  snapshotRevision: "20",
  updatedAfter: null,
};

describe("agent topology query", () => {
  test("defaults to a bounded root page", () => {
    expect(agentTopologyQuery({})).toEqual({
      limit: 25,
      parentSessionId: null,
      search: undefined,
      cursor: undefined,
    });
  });

  test("round-trips a cursor only with its original branch filters", () => {
    const cursor = encodeAgentTopologyCursor({
      cursor: CURSOR,
      parentSessionId: PARENT_ID,
      search: null,
    });
    expect(agentTopologyQuery({ parentSessionId: PARENT_ID, cursor })).toMatchObject({
      parentSessionId: PARENT_ID,
      cursor: CURSOR,
    });
    expect(() => agentTopologyQuery({ parentSessionId: "null", cursor })).toThrow(
      "cursor does not match",
    );
  });

  test("rejects invalid limits, parents, searches, and cursors", () => {
    expect(() => agentTopologyQuery({ limit: "101" })).toThrow("between 1 and 100");
    expect(() => agentTopologyQuery({ parentSessionId: "not-a-uuid" })).toThrow("parentSessionId");
    expect(() => agentTopologyQuery({ search: "x".repeat(201) })).toThrow("at most 200");
    expect(() => agentTopologyQuery({ search: "rollout", parentSessionId: "null" })).toThrow(
      "cannot be combined",
    );
    expect(() => agentTopologyQuery({ cursor: "not-a-cursor" })).toThrow("cursor is invalid");
  });
});
