import { describe, expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import {
  idleCompactionEligibility,
  requestIdleCompactionAfterCompletedTurn,
} from "../src/activities/agent-turn/idle-compaction-request";

const humanTurn = { source: "user", initiatorKind: "subject" };

describe("idleCompactionEligibility", () => {
  test("a human or API turn with a threshold is eligible", () => {
    expect(idleCompactionEligibility({ enabled: true, turn: humanTurn, thresholdTokens: 1 })).toBe(
      "eligible",
    );
    expect(
      idleCompactionEligibility({
        enabled: true,
        turn: { source: "api", initiatorKind: "subject" },
        thresholdTokens: 244_800,
      }),
    ).toBe("eligible");
  });

  test("the deployment setting turns it off", () => {
    expect(
      idleCompactionEligibility({ enabled: false, turn: humanTurn, thresholdTokens: 244_800 }),
    ).toBe("disabled");
  });

  test("maintenance compaction never requests another compaction", () => {
    expect(
      idleCompactionEligibility({
        enabled: true,
        turn: { source: "compaction", initiatorKind: "service" },
        thresholdTokens: 244_800,
      }),
    ).toBe("maintenance");
  });

  test("service, scheduled, goal and system work keep compacting at their next boundary", () => {
    for (const turn of [
      { source: "goal", initiatorKind: "service" },
      { source: "scheduled_task", initiatorKind: "service" },
      { source: "system", initiatorKind: "subject" },
      { source: "user", initiatorKind: "service" },
      { source: "", initiatorKind: "subject" },
    ]) {
      expect(idleCompactionEligibility({ enabled: true, turn, thresholdTokens: 244_800 })).toBe(
        "not_human_turn",
      );
    }
  });

  test("an unusable threshold never requests", () => {
    for (const thresholdTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(idleCompactionEligibility({ enabled: true, turn: humanTurn, thresholdTokens })).toBe(
        "no_threshold",
      );
    }
  });
});

describe("requestIdleCompactionAfterCompletedTurn", () => {
  const base = {
    db: {} as Database,
    workspaceId: "w",
    sessionId: "s",
    turnId: "t",
    thresholdTokens: 244_800,
  };

  test("an eligible turn asks the database with the resolved threshold", async () => {
    const calls: unknown[] = [];
    const warnings: string[] = [];
    const result = await requestIdleCompactionAfterCompletedTurn({
      ...base,
      enabled: true,
      turn: humanTurn,
      logger: { warn: (message) => warnings.push(message) },
      request: async (_db, input) => {
        calls.push(input);
        return { requested: true, wakeRevision: 3, temporalWorkflowId: "session-s" };
      },
    });
    expect(calls).toEqual([{ workspaceId: "w", sessionId: "s", thresholdTokens: 244_800 }]);
    expect(result).toEqual({ requested: true, wakeRevision: 3, temporalWorkflowId: "session-s" });
    expect(warnings).toEqual([]);
  });

  test("an ineligible turn never touches the database", async () => {
    let called = false;
    const result = await requestIdleCompactionAfterCompletedTurn({
      ...base,
      enabled: false,
      turn: humanTurn,
      logger: { warn: () => {} },
      request: async () => {
        called = true;
        return { requested: false, reason: "below_threshold" };
      },
    });
    expect(called).toBe(false);
    expect(result).toBeNull();
  });

  test("a failed request is logged and never fails the completed turn", async () => {
    const warnings: Array<{ message: string; fields?: Record<string, string> }> = [];
    const result = await requestIdleCompactionAfterCompletedTurn({
      ...base,
      enabled: true,
      turn: humanTurn,
      logger: { warn: (message, fields) => warnings.push({ message, fields }) },
      request: async () => {
        throw new TypeError("connection reset");
      },
    });
    expect(result).toBeNull();
    expect(warnings).toEqual([
      {
        message: "idle context compaction request failed; next turn compacts instead",
        fields: { sessionId: "s", turnId: "t", error: "TypeError" },
      },
    ]);
  });
});
