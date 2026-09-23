import { describe, expect, test } from "bun:test";
import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  TimeoutFailure,
} from "@temporalio/workflow";
import {
  escapedMcpTimeoutRecoveryDetail,
  isTurnActivityFenceCancellation,
  postClaimDatabaseRecoveryDetail,
  preClaimFailureDetail,
  preClaimFailureDisposition,
} from "../src/workflows/session";
import {
  ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_MESSAGE,
  ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_TYPE,
  POST_CLAIM_DATABASE_RECOVERY_FAILURE_MESSAGE,
  POST_CLAIM_DATABASE_RECOVERY_FAILURE_TYPE,
  PRE_CLAIM_FAILURE_MESSAGE,
  PRE_CLAIM_FAILURE_TYPE,
} from "../src/activities/types";
import { workflowFailureMessage } from "../src/workflows/activities";

function activityFailure(cause: Error): ActivityFailure {
  return new ActivityFailure(
    "Activity task failed",
    "runAgentTurn",
    "activity-1",
    "CANCEL_REQUESTED",
    "worker-1",
    cause,
  );
}

test("definition mismatch diagnostics survive Temporal without unwrapping arbitrary causes", () => {
  for (const message of [
    "Turn execution policy does not match the current provider definition",
    "Turn execution policy does not match the current provider definition. Automatic same-turn configuration recovery exhausted after 5 retries.",
  ]) {
    expect(
      workflowFailureMessage(
        activityFailure(
          ApplicationFailure.create({
            message,
            type: "TurnExecutionPolicyDefinitionMismatchError",
            nonRetryable: true,
          }),
        ),
      ),
    ).toBe(message);
  }
  expect(
    workflowFailureMessage(
      activityFailure(
        ApplicationFailure.create({
          message: "private provider detail",
          type: "OtherError",
        }),
      ),
    ),
  ).toBe("Activity task failed");
  expect(workflowFailureMessage(new Error("ordinary failure"))).toBe("ordinary failure");
});

describe("turn activity fence-cancellation arbitration", () => {
  test("accepts both direct and Temporal ActivityFailure-wrapped cancellation", () => {
    const cancelled = new CancelledFailure("TURN_ATTEMPT_FENCED");
    expect(isTurnActivityFenceCancellation(cancelled)).toBe(true);
    expect(isTurnActivityFenceCancellation(activityFailure(cancelled))).toBe(true);
  });

  test("accepts the Temporal 1.20 fence-before-cancel wire shape only for runAgentTurn", () => {
    const preRequestCancellation = ApplicationFailure.create({
      message: "TURN_ATTEMPT_FENCED",
      type: "CancelledFailure",
    });
    expect(isTurnActivityFenceCancellation(activityFailure(preRequestCancellation))).toBe(true);
    expect(
      isTurnActivityFenceCancellation(
        new ActivityFailure(
          "Activity task failed",
          "someOtherActivity",
          "activity-1",
          "IN_PROGRESS",
          "worker-1",
          preRequestCancellation,
        ),
      ),
    ).toBe(false);
    expect(
      isTurnActivityFenceCancellation(
        activityFailure(
          ApplicationFailure.create({
            message: "some other cancellation",
            type: "CancelledFailure",
          }),
        ),
      ),
    ).toBe(false);
  });

  test("rejects timeout and arbitrary cause chains as control-race protocol shapes", () => {
    const timeout = new TimeoutFailure("heartbeat expired", null, "HEARTBEAT");
    expect(isTurnActivityFenceCancellation(activityFailure(timeout))).toBe(false);
    expect(isTurnActivityFenceCancellation(new Error("cancelled by message only"))).toBe(false);
    expect(
      isTurnActivityFenceCancellation(
        activityFailure(new Error("wrapper", { cause: new CancelledFailure("hidden") })),
      ),
    ).toBe(false);
  });
});

describe("pre-claim admission failure wire classification", () => {
  test("accepts only a complete sanitized recoverable block", () => {
    const detail = {
      disposition: "blocked",
      code: "db_failure",
      sqlState: "42501",
      reason: "database_claim_rejected",
      retryPolicy: "explicit_recheck",
    };
    const wrap = (value: unknown) =>
      activityFailure(
        ApplicationFailure.create({
          message: PRE_CLAIM_FAILURE_MESSAGE,
          type: PRE_CLAIM_FAILURE_TYPE,
          nonRetryable: true,
          details: [value],
        }),
      );
    expect(preClaimFailureDetail(wrap(detail))).toEqual(detail);
    for (const value of [
      { ...detail, sqlState: "SECRET" },
      { ...detail, retryPolicy: "automatic" },
      { ...detail, reason: "guessed_membership" },
      { ...detail, code: "db_deadlock" },
    ]) {
      expect(preClaimFailureDetail(wrap(value))).toBeUndefined();
    }
  });
  test("accepts only the exact upgraded-worker contract", () => {
    for (const disposition of ["retryable", "permanent"] as const) {
      const failure = ApplicationFailure.create({
        message: PRE_CLAIM_FAILURE_MESSAGE,
        type: PRE_CLAIM_FAILURE_TYPE,
        nonRetryable: true,
        details: [
          {
            disposition,
            code: disposition === "retryable" ? "db_deadlock" : "claim_invariant",
          },
        ],
      });
      expect(preClaimFailureDisposition(activityFailure(failure))).toBe(disposition);
      expect(preClaimFailureDetail(activityFailure(failure))).toEqual({
        disposition,
        code: disposition === "retryable" ? "db_deadlock" : "claim_invariant",
      });
    }
  });

  test("keeps legacy, malformed, and unrelated activity results unknown", () => {
    expect(preClaimFailureDisposition(new Error("legacy worker"))).toBeUndefined();
    expect(
      preClaimFailureDisposition(
        activityFailure(
          ApplicationFailure.create({
            message: PRE_CLAIM_FAILURE_MESSAGE,
            type: PRE_CLAIM_FAILURE_TYPE,
            details: [{ disposition: "invalid" }],
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      preClaimFailureDisposition(
        activityFailure(
          ApplicationFailure.create({
            message: PRE_CLAIM_FAILURE_MESSAGE,
            type: PRE_CLAIM_FAILURE_TYPE,
            details: [{ disposition: "permanent", code: "invented" }],
          }),
        ),
      ),
    ).toBeUndefined();
  });
});

describe("post-claim database recovery wire classification", () => {
  const detail = {
    turnId: "turn-1",
    triggerEventId: "trigger-1",
    executionGeneration: 2,
    code: "db_failure" as const,
  };

  test("accepts only the exact claimed-turn recovery contract", () => {
    const failure = ApplicationFailure.create({
      message: POST_CLAIM_DATABASE_RECOVERY_FAILURE_MESSAGE,
      type: POST_CLAIM_DATABASE_RECOVERY_FAILURE_TYPE,
      nonRetryable: true,
      details: [detail],
    });
    expect(postClaimDatabaseRecoveryDetail(activityFailure(failure))).toEqual(detail);
  });

  test("accepts a complete provider recovery authority pair", () => {
    const providerDetail = {
      ...detail,
      providerFailureCode: "mcp_transport_unavailable",
      providerRecoveryCount: 2,
    };
    const failure = ApplicationFailure.create({
      message: POST_CLAIM_DATABASE_RECOVERY_FAILURE_MESSAGE,
      type: POST_CLAIM_DATABASE_RECOVERY_FAILURE_TYPE,
      nonRetryable: true,
      details: [providerDetail],
    });
    expect(postClaimDatabaseRecoveryDetail(activityFailure(failure))).toEqual(providerDetail);
  });

  test("rejects malformed identity, permanent codes, and unrelated activities", () => {
    const failure = (candidate: Record<string, unknown>) =>
      activityFailure(
        ApplicationFailure.create({
          message: POST_CLAIM_DATABASE_RECOVERY_FAILURE_MESSAGE,
          type: POST_CLAIM_DATABASE_RECOVERY_FAILURE_TYPE,
          details: [candidate],
        }),
      );
    expect(
      postClaimDatabaseRecoveryDetail(failure({ ...detail, executionGeneration: 0 })),
    ).toBeNull();
    expect(
      postClaimDatabaseRecoveryDetail(failure({ ...detail, code: "claim_invariant" })),
    ).toBeNull();
    expect(
      postClaimDatabaseRecoveryDetail(failure({ ...detail, providerRecoveryCount: 2 })),
    ).toBeNull();
    expect(
      postClaimDatabaseRecoveryDetail(
        failure({
          ...detail,
          providerFailureCode: "unsafe provider code",
          providerRecoveryCount: 2,
        }),
      ),
    ).toBeNull();
    expect(
      postClaimDatabaseRecoveryDetail(
        new ActivityFailure(
          "Activity task failed",
          "someOtherActivity",
          "activity-1",
          "IN_PROGRESS",
          "worker-1",
          failure(detail).cause,
        ),
      ),
    ).toBeNull();
  });
});

describe("escaped MCP timeout activity-failure recovery", () => {
  const detail = {
    turnId: "turn-2",
    triggerEventId: "trigger-1",
    executionGeneration: 2,
    providerRecoveryCount: 1,
    continueDelayMs: 2_000,
  };
  const escaped = () =>
    activityFailure(
      ApplicationFailure.create({
        message: ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_MESSAGE,
        type: ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_TYPE,
        nonRetryable: true,
        details: [detail],
      }),
    );

  test("accepts only the explicit generation-2 runAgentTurn wire contract", () => {
    expect(escapedMcpTimeoutRecoveryDetail(escaped())).toEqual(detail);
    expect(
      escapedMcpTimeoutRecoveryDetail(
        new ActivityFailure(
          "Activity task failed",
          "someOtherActivity",
          "activity-1",
          "IN_PROGRESS",
          "worker-1",
          (escaped().cause as ApplicationFailure) ?? undefined,
        ),
      ),
    ).toBeNull();
    expect(
      escapedMcpTimeoutRecoveryDetail(
        activityFailure(
          ApplicationFailure.create({
            message: ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_MESSAGE,
            type: ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_TYPE,
            details: [{ ...detail, executionGeneration: 1 }],
          }),
        ),
      ),
    ).toBeNull();
    expect(
      escapedMcpTimeoutRecoveryDetail(
        activityFailure(
          ApplicationFailure.create({
            message: ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_MESSAGE,
            type: ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_TYPE,
            details: [{ ...detail, providerRecoveryCount: 0 }],
          }),
        ),
      ),
    ).toBeNull();
  });

  test("does not infer recovery from ambiguous -32001 or altered marker fields", () => {
    expect(
      escapedMcpTimeoutRecoveryDetail(
        activityFailure(
          ApplicationFailure.create({
            message: "MCP transport operation failed (McpError -32001)",
            type: "Error",
          }),
        ),
      ),
    ).toBeNull();
    expect(
      escapedMcpTimeoutRecoveryDetail(
        activityFailure(
          ApplicationFailure.create({
            message: "different message",
            type: ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_TYPE,
            details: [detail],
          }),
        ),
      ),
    ).toBeNull();
  });
});
