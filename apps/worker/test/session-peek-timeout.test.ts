import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SESSION_PEEK_ACTIVITY_OPTIONS } from "../src/workflows/activities";

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("session peek before turn dispatch", () => {
  test("a lost peek attempt delays a queued turn by seconds, not the control bound", () => {
    // Temporal schedules the retry of a started attempt only when its
    // start-to-close timeout fires. A fresh prompt waits for that retry before
    // any turn-queue task exists. Under the general two-minute control bound
    // one lost attempt held a prompt for about 124 seconds.
    const { startToCloseTimeout, retry } = SESSION_PEEK_ACTIVITY_OPTIONS;
    const lostAttemptDelayMs = startToCloseTimeout + retry.initialInterval;
    expect(lostAttemptDelayMs).toBeLessThanOrEqual(16_000);
    // Bounded attempts, never bounded retries: the session must not fail
    // because the database was briefly slow.
    expect("maximumAttempts" in retry).toBe(false);
    expect("scheduleToCloseTimeout" in SESSION_PEEK_ACTIVITY_OPTIONS).toBe(false);
  });

  test("every workflow peek uses the bounded proxy", () => {
    const workflow = source("../src/workflows/session.ts");
    expect(workflow).not.toMatch(/\bactivity\.peekSessionWork\(/);
    expect(workflow.match(/\bsessionPeekActivity\.peekSessionWork\(/g)).toHaveLength(4);
    const proxies = source("../src/workflows/activities.ts");
    const controlActivities = proxies.slice(
      proxies.indexOf("type WorkflowControlActivities"),
      proxies.indexOf("export const activity ="),
    );
    expect(controlActivities).not.toContain('"peekSessionWork"');
  });
});
