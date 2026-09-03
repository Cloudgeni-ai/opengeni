import { describe, expect, test } from "bun:test";
import { turnAttemptProducerId } from "../src/activities/agent-turn/claim";
import { codexCredentialLeaseHolderId } from "../src/activities/agent-turn/credential-leases";

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
  test("does not reuse a holder across worker death, continue-as-new, or activity execution", () => {
    const first = codexCredentialLeaseHolderId(
      {
        workflowId: "session-1",
        workflowRunId: "run-before",
        attemptId: "attempt-before",
      },
      "runAgentTurn",
      100,
    );
    const workerDeathRedispatch = codexCredentialLeaseHolderId(
      {
        workflowId: "session-1",
        workflowRunId: "run-before",
        attemptId: "attempt-after-worker-death",
      },
      "runAgentTurn",
      101,
    );
    const sameAttemptNewExecution = codexCredentialLeaseHolderId(
      {
        workflowId: "session-1",
        workflowRunId: "run-before",
        attemptId: "attempt-before",
      },
      "runAgentTurn",
      101,
    );
    const continuedRun = codexCredentialLeaseHolderId(
      {
        workflowId: "session-1",
        workflowRunId: "run-after-continue-as-new",
        attemptId: "attempt-after-continue-as-new",
      },
      "runAgentTurn",
      100,
    );

    expect(
      new Set([first, workerDeathRedispatch, sameAttemptNewExecution, continuedRun]).size,
    ).toBe(4);
    expect(
      codexCredentialLeaseHolderId(
        { workflowId: "session-1", workflowRunId: "run-before", attemptId: "attempt-before" },
        "runAgentTurn",
        100,
      ),
    ).toBe(first);
    expect(first).toBe("codex-turn:session-1:run-before:attempt-before:runAgentTurn:100");
  });

  test("keeps component boundaries unambiguous", () => {
    const first = codexCredentialLeaseHolderId(
      { workflowId: "session:one", workflowRunId: "run", attemptId: "attempt" },
      "activity",
      100,
    );
    const second = codexCredentialLeaseHolderId(
      { workflowId: "session", workflowRunId: "one:run", attemptId: "attempt" },
      "activity",
      100,
    );

    expect(first).not.toBe(second);
  });

  test("rejects an incomplete execution identity", () => {
    expect(() =>
      codexCredentialLeaseHolderId(
        { workflowId: "session-1", workflowRunId: "run-1", attemptId: "attempt-1" },
        "runAgentTurn",
        " ",
      ),
    ).toThrow("Codex credential lease holder requires a complete activity identity");
  });
});
