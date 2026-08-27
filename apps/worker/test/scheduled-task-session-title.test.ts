import { describe, expect, test } from "bun:test";
import { scheduledTaskSessionTitle } from "../src/activities/scheduled-tasks";

describe("scheduled session title", () => {
  test("names the task", () => {
    // A scheduled session starts with the neutral automatic fallback; the task
    // name is the stable human label that should replace it.
    expect(scheduledTaskSessionTitle("Daily production alert sweep")).toBe(
      "Daily production alert sweep",
    );
  });

  test("carries no wall-clock time", () => {
    // A title is one stored string shown to every viewer, while every surface
    // that renders a run's fire instant renders it viewer-local (the rail pairs
    // the title with relativeTimeLabel(session.updatedAt); the Schedules run
    // list uses formatTimestamp(run.firedAt) -> toLocaleString). A stored clock
    // can never agree with a viewer-local one, so the title carries none.
    const title = scheduledTaskSessionTitle("Nightly backup audit");
    expect(title).toBe("Nightly backup audit");
    expect(title).not.toMatch(/\d{2}:\d{2}/);
    expect(title).not.toContain("UTC");
  });

  test("a reusable session keeps one correct title across every run", () => {
    // The defect this replaces: a reusable_session task generates its session on
    // the first fire and reuses it forever, so a title naming run 1's instant is
    // wrong for runs 2..N. A name-only title is true on every run, which is why
    // the scheduler can title the session once at generation and never revisit
    // it.
    const runOne = scheduledTaskSessionTitle("Nightly backup audit");
    const runSeventy = scheduledTaskSessionTitle("Nightly backup audit");
    expect(runOne).toBe(runSeventy);
  });

  test("the same task always produces the same text", () => {
    // Normal dispatch and a later recovery of the same run execute in different
    // worker processes and must land byte-identical text. With no Intl call
    // there is no host ICU or tzdata build left to make the two differ.
    expect(scheduledTaskSessionTitle("Weekly digest")).toBe(
      scheduledTaskSessionTitle("Weekly digest"),
    );
  });

  test("an unbounded task name uses the short automatic-title ceiling without artifacts", () => {
    const title = scheduledTaskSessionTitle("x".repeat(400));
    expect(title.length).toBe(80);
    expect(title.endsWith("…")).toBe(false);
  });

  test("a name already at the automatic ceiling is left intact", () => {
    const exact = "y".repeat(80);
    expect(scheduledTaskSessionTitle(exact)).toBe(exact);
  });

  test("a blank name degrades instead of writing an empty title", () => {
    expect(scheduledTaskSessionTitle("   ")).toBe("Scheduled run");
    expect(scheduledTaskSessionTitle("")).toBe("Scheduled run");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(scheduledTaskSessionTitle("  Weekly digest  ")).toBe("Weekly digest");
  });
});
