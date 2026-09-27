import { describe, expect, test } from "bun:test";
import { childCompletionSummary } from "../src/activities/parent-wake";

const child = { id: "child-1" } as any;

describe("childCompletionSummary", () => {
  test("names the terminal state and worker id, without an instruction", () => {
    const summary = childCompletionSummary(child, null, "failed");
    expect(summary).toContain("FAILED");
    expect(summary).toContain("child-1");
    // The summary is also the timeline preview. How to use a child's result
    // lives in the operational contract, not in every per-child line.
    expect(summary).not.toContain("resume it now");
    expect(summary).not.toContain("continue");
    expect(summary).not.toContain("session events");
  });
});
