import { describe, expect, test } from "bun:test";
import { DEFAULT_FIRST_PARTY_MCP_TOOLS } from "@opengeni/contracts";
import {
  resolveChildGoalFromAcceptedSnapshot,
  resolveFirstPartyMcpToolsForCreate,
} from "../src/domain/sessions";

describe("first-party MCP tool selection at session creation", () => {
  test("top-level omission snapshots the complete default catalog", () => {
    expect(resolveFirstPartyMcpToolsForCreate(undefined, undefined)).toEqual([
      ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
    ]);
  });

  test("explicit empty remains authoritative", () => {
    expect(resolveFirstPartyMcpToolsForCreate([], undefined)).toEqual([]);
  });

  test("a child omission inherits the parent's exact effective selection", () => {
    expect(resolveFirstPartyMcpToolsForCreate(undefined, ["set_session_title"])).toEqual([
      "set_session_title",
    ]);
    expect(resolveFirstPartyMcpToolsForCreate(undefined, [])).toEqual([]);
    expect(resolveFirstPartyMcpToolsForCreate(undefined, null)).toEqual([
      ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
    ]);
  });

  test("an explicit child selection replaces inherited visibility", () => {
    expect(resolveFirstPartyMcpToolsForCreate(["session_create"], ["set_session_title"])).toEqual([
      "session_create",
    ]);
  });

  test("deployment policy supplies top-level defaults and narrows inherited selections", () => {
    const policy = {
      default: ["session_get"] as const,
      allowed: ["session_get", "goal_update"] as const,
    };
    expect(resolveFirstPartyMcpToolsForCreate(undefined, undefined, policy)).toEqual([
      "session_get",
    ]);
    expect(
      resolveFirstPartyMcpToolsForCreate(
        undefined,
        ["session_get", "session_create", "goal_update"],
        policy,
      ),
    ).toEqual(["session_get", "goal_update"]);
  });
});

describe("child goal root constraints", () => {
  const snapshot = {
    state: "active" as const,
    goalId: "11111111-1111-4111-8111-111111111111",
    objectiveRevision: 3,
    text: "Ship safely",
    successCriteria: null,
    rootConstraints: ["Keep tenant isolation", "No production deploy"],
    mutationPolicy: "preserve_intent" as const,
    capturedAt: "2026-08-15T00:00:00.000Z",
  };

  test("omission inherits the exact frozen set while explicit empty remains empty", () => {
    expect(resolveChildGoalFromAcceptedSnapshot({ text: "delegate" }, snapshot)).toMatchObject({
      rootConstraints: snapshot.rootConstraints,
    });
    expect(
      resolveChildGoalFromAcceptedSnapshot({ text: "delegate", rootConstraints: [] }, snapshot),
    ).toMatchObject({ rootConstraints: [] });
  });

  test("accepts only an exact subset and never reads a later mutable parent head", () => {
    expect(
      resolveChildGoalFromAcceptedSnapshot(
        { text: "delegate", rootConstraints: ["Keep tenant isolation"] },
        snapshot,
      ),
    ).toMatchObject({ rootConstraints: ["Keep tenant isolation"] });
    expect(() =>
      resolveChildGoalFromAcceptedSnapshot(
        { text: "delegate", rootConstraints: ["A later mutable constraint"] },
        snapshot,
      ),
    ).toThrow("exact subset");
  });
});
