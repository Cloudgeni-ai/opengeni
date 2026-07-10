import { describe, expect, test } from "bun:test";
import { childCompletionSummary, childCompletionTrailing } from "../src/activities/parent-wake";

const child = { id: "child-1" } as any;

describe("childCompletionSummary", () => {
  test("names the terminal state and worker id, without a trailing instruction", () => {
    const summary = childCompletionSummary(child, null, "failed");
    expect(summary).toContain("FAILED");
    expect(summary).toContain("child-1");
    // The trailing "what to do next" line is NOT part of the summary (it is
    // appended once per digest, not once per child).
    expect(summary).not.toContain("resume it now");
    expect(summary).not.toContain("continue");
  });
});

describe("childCompletionTrailing (sacred user pause)", () => {
  test("normally nudges the manager to continue / resume", () => {
    const trailing = childCompletionTrailing(false);
    expect(trailing).toContain("resume it now");
  });

  test("when the manager's goal is user-paused, it suppresses the resume nudge", () => {
    const trailing = childCompletionTrailing(true);
    expect(trailing).toContain("paused by the user");
    expect(trailing).toContain("do NOT resume");
    expect(trailing).not.toContain("resume it now");
  });
});
