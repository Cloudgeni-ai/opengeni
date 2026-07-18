import { describe, expect, test } from "bun:test";
import { goalPillState } from "./goal-surface";

const continuation = (
  state: "scheduled" | "running" | "blocked" | "invariant_broken" | "inactive",
  reason:
    | "wake_pending"
    | "goal_turn_running"
    | "human_turn_running"
    | "human_work_pending"
    | "workstream_paused"
    | "missing_obligation",
) => ({
  state,
  reason,
  wakeRevision: 1,
  observedRevision: 1,
  nextAttemptAt: null,
  lastError: null,
});

describe("goal continuation surface", () => {
  test("only a running continuation is shown as pursuing", () => {
    expect(goalPillState("active", continuation("running", "goal_turn_running"))).toBe("pursuing");
    expect(goalPillState("active", continuation("running", "human_turn_running"))).toBe("blocked");
    expect(goalPillState("active", undefined)).toBe("invariant_broken");
    expect(goalPillState("active", continuation("inactive", "missing_obligation"))).toBe(
      "invariant_broken",
    );
  });

  test("preserves truthful scheduled, blocked, held, and invariant-broken states", () => {
    expect(goalPillState("active", continuation("scheduled", "wake_pending"))).toBe("scheduled");
    expect(goalPillState("active", continuation("blocked", "human_work_pending"))).toBe("blocked");
    expect(goalPillState("active", continuation("blocked", "workstream_paused"))).toBe("held");
    expect(goalPillState("active", continuation("invariant_broken", "missing_obligation"))).toBe(
      "invariant_broken",
    );
  });
});
