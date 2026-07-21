import { describe, expect, test } from "bun:test";
import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  TimeoutFailure,
} from "@temporalio/workflow";
import { isTurnActivityFenceCancellation } from "../src/workflows/session";

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
