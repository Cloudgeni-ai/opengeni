import { describe, expect, test } from "bun:test";
import {
  finalReplyNudge,
  hasFinalReplyNudge,
  needsFinalReply,
} from "../src/activities/agent-turn/final-reply";

const empty = {
  output: "",
  inputWaitYielded: false,
  interrupted: false,
  maintenance: false,
  toolsExecuted: true,
  completedGoal: false,
};

describe("same-turn final reply handoff", () => {
  test("nudges empty or whitespace-only finals after tools or a completed goal", () => {
    expect(needsFinalReply(empty)).toBe(true);
    expect(needsFinalReply({ ...empty, output: " \n\t" })).toBe(true);
    expect(needsFinalReply({ ...empty, toolsExecuted: false, completedGoal: true })).toBe(true);
  });
  test("asks for a real answer when the only output was a hidden search-record copy", () => {
    const quiet = { ...empty, toolsExecuted: false, completedGoal: false };
    expect(needsFinalReply(quiet)).toBe(false);
    expect(needsFinalReply({ ...quiet, suppressedEcho: true })).toBe(true);
    expect(needsFinalReply({ ...quiet, suppressedEcho: true, inputWaitYielded: true })).toBe(false);
    expect(needsFinalReply({ ...quiet, suppressedEcho: true, maintenance: true })).toBe(false);
  });
  test("preserves deliberate waits, approvals, maintenance, and ordinary answers", () => {
    for (const patch of [
      { inputWaitYielded: true },
      { interrupted: true },
      { maintenance: true },
      { output: "Delivered." },
      { toolsExecuted: false },
      { output: undefined },
    ])
      expect(needsFinalReply({ ...empty, ...patch })).toBe(false);
  });
  test("durable nudge identity is exact and logical-turn scoped", () => {
    const history = [finalReplyNudge("turn-one")];
    expect(hasFinalReplyNudge(history, "turn-one")).toBe(true);
    expect(hasFinalReplyNudge(history, "turn-two")).toBe(false);
    expect(hasFinalReplyNudge([{ ...history[0], role: "user" }], "turn-one")).toBe(false);
    expect(finalReplyNudge("turn-one").content[0]!.text).toContain("do not repeat completed tools");
  });
});
