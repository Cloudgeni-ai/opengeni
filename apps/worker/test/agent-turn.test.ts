import { describe, expect, test } from "bun:test";
import { CancelledFailure } from "@temporalio/activity";
import { isWorkerShutdownCancellation, WORKER_SHUTDOWN_RESUME_TEXT } from "../src/activities/agent-turn";

describe("worker shutdown preemption", () => {
  test("classifies only WORKER_SHUTDOWN cancellations as graceful preemption", () => {
    expect(isWorkerShutdownCancellation(new CancelledFailure("WORKER_SHUTDOWN"))).toBe(true);
    // Workflow-requested cancellation (user interrupt) keeps its existing path.
    expect(isWorkerShutdownCancellation(new CancelledFailure("CANCELLED"))).toBe(false);
    // Server-side heartbeat timeout after a hard kill must stay terminal.
    expect(isWorkerShutdownCancellation(new CancelledFailure("TIMED_OUT"))).toBe(false);
    expect(isWorkerShutdownCancellation(new Error("WORKER_SHUTDOWN"))).toBe(false);
    expect(isWorkerShutdownCancellation(undefined)).toBe(false);
  });

  test("resume notice tells the agent to verify in-flight side effects", () => {
    expect(WORKER_SHUTDOWN_RESUME_TEXT).toContain("TURN RESUMED AFTER WORKER RESTART");
    expect(WORKER_SHUTDOWN_RESUME_TEXT).toContain("check whether it already happened");
  });
});
