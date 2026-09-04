import { describe, expect, test } from "bun:test";
import {
  codexCredentialLeaseHolderId,
  turnAttemptProducerId,
} from "../src/activities/agent-turn/claim";

describe("turn attempt durable producer identity", () => {
  test("does not collide when Temporal reuses an activity id across workflow runs", () => {
    const first = turnAttemptProducerId(
      { workflowId: "session-1", attemptId: "attempt-before-pause" },
      "turn-1",
    );
    const resumed = turnAttemptProducerId(
      { workflowId: "session-1", attemptId: "attempt-after-resume" },
      "turn-1",
    );

    expect(first).not.toBe(resumed);
  });

  test("is stable for a retry of the same scheduled attempt", () => {
    const input = { workflowId: "session-1", attemptId: "attempt-1" };
    expect(turnAttemptProducerId(input, "turn-1")).toBe(turnAttemptProducerId(input, "turn-1"));
  });
});

describe("Codex credential lease holder identity", () => {
  test("is stable for retries and unique across worker death and continue-as-new", () => {
    const first = codexCredentialLeaseHolderId(
      {
        workflowId: "session-1",
        attemptId: "attempt-before",
      },
      "turn-1",
    );
    const retry = codexCredentialLeaseHolderId(
      { workflowId: "session-1", attemptId: "attempt-before" },
      "turn-1",
    );
    const workerDeathRedispatch = codexCredentialLeaseHolderId(
      {
        workflowId: "session-1",
        attemptId: "attempt-after-worker-death",
      },
      "turn-1",
    );
    const continuedRun = codexCredentialLeaseHolderId(
      {
        workflowId: "session-1",
        attemptId: "attempt-after-continue-as-new",
      },
      "turn-1",
    );

    expect(retry).toBe(first);
    expect(new Set([first, workerDeathRedispatch, continuedRun]).size).toBe(3);
    expect(first).toBe("codex-turn:session-1:turn-1:attempt-before");
  });

  test("keeps component boundaries unambiguous", () => {
    const first = codexCredentialLeaseHolderId(
      { workflowId: "session:one", attemptId: "attempt" },
      "turn-1",
    );
    const second = codexCredentialLeaseHolderId(
      { workflowId: "session", attemptId: "attempt" },
      "one:turn-1",
    );

    expect(first).not.toBe(second);
  });

  test("rejects an incomplete turn attempt identity", () => {
    expect(() =>
      codexCredentialLeaseHolderId({ workflowId: "session-1", attemptId: "attempt-1" }, " "),
    ).toThrow("Codex credential lease holder requires a complete turn attempt identity");
  });
});
