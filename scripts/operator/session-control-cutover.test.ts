import { describe, expect, it } from "bun:test";
import { schedulePauseOwnedByRun } from "./session-control-cutover";

describe("production cutover operator retry ownership", () => {
  it("re-emits only unpaused schedules or schedules already paused by the same run", () => {
    const note = "OpenGeni production maintenance opengeni-cutover-main";
    expect(schedulePauseOwnedByRun(false, null, note)).toBe(true);
    expect(schedulePauseOwnedByRun(true, note, note)).toBe(true);
    expect(schedulePauseOwnedByRun(true, "manual operator pause", note)).toBe(
      false,
    );
    expect(schedulePauseOwnedByRun(true, null, note)).toBe(false);
  });
});
