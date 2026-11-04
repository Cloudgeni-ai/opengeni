import { describe, expect, test } from "bun:test";
import { allAgentCapabilities } from "@opengeni/contracts";
import {
  UNATTENDED_REQUEST_GOAL,
  unattendedRequestGoal,
} from "../src/domain/unattended-request-goal";

const base = {
  unattended: true,
  goal: undefined,
  initialMessage: "Fix the failing parser test.",
  hasParent: false,
  creator: "api",
  agentConfig: null,
} as const;

describe("automatic goal for an unattended single request (model-free)", () => {
  test("a top-level unattended API create with a request gets the fixed goal", () => {
    expect(unattendedRequestGoal(base)).toEqual({ ...UNATTENDED_REQUEST_GOAL });
    expect(
      unattendedRequestGoal({ ...base, agentConfig: { capabilities: allAgentCapabilities() } }),
    ).toEqual({ ...UNATTENDED_REQUEST_GOAL });
    // Fixed text: a retried or recovered create resolves the same goal.
    expect(unattendedRequestGoal(base)).toEqual(unattendedRequestGoal(base));
  });

  test("it names the request instead of copying it", () => {
    const goal = unattendedRequestGoal({ ...base, initialMessage: "x".repeat(20_000) })!;
    expect(goal.text).toBe(UNATTENDED_REQUEST_GOAL.text);
    expect(JSON.stringify(goal)).not.toContain("xxxx");
    expect(JSON.stringify(goal)).not.toMatch(/benchmark|commit|test/iu);
  });

  test("every other create keeps today's behaviour", () => {
    for (const input of [
      { ...base, unattended: undefined },
      { ...base, unattended: false },
      { ...base, goal: null },
      { ...base, goal: { text: "Ship it." } },
      { ...base, hasParent: true },
      { ...base, creator: "slack" },
      { ...base, creator: "scheduled" },
      { ...base, creator: "automation" },
      { ...base, initialMessage: undefined },
      { ...base, initialMessage: "  \n" },
      {
        ...base,
        agentConfig: { capabilities: { ...allAgentCapabilities(), goals: false } },
      },
    ]) {
      expect(unattendedRequestGoal(input)).toBeUndefined();
    }
  });
});
