import { describe, expect, test } from "bun:test";
import { temporalActivityLeaseSettled, temporalWorkflowExecutionNotFound } from "../src/index";

describe("Temporal attempt activity lease", () => {
  test("keeps a live heartbeat lease pending", () => {
    expect(
      temporalActivityLeaseSettled(
        {
          lastHeartbeatTime: { seconds: "100", nanos: 0 },
          activityOptions: { heartbeatTimeout: { seconds: "120", nanos: 0 } },
        },
        219_999,
      ),
    ).toBe(false);
  });

  test("settles only at the exact server heartbeat deadline", () => {
    const pending = {
      lastHeartbeatTime: { seconds: "100", nanos: 500_000_000 },
      activityOptions: { heartbeatTimeout: { seconds: "120", nanos: 0 } },
    };
    expect(temporalActivityLeaseSettled(pending, 220_499)).toBe(false);
    expect(temporalActivityLeaseSettled(pending, 220_500)).toBe(true);
  });

  test("fails closed when Temporal omitted the heartbeat contract", () => {
    expect(temporalActivityLeaseSettled({ lastStartedTime: { seconds: "100" } }, 999_999)).toBe(
      false,
    );
  });

  test("treats an absent exact activity as settled", () => {
    expect(temporalActivityLeaseSettled(undefined)).toBe(true);
  });

  test("only a typed Temporal gRPC NOT_FOUND proves the exact run absent", () => {
    const temporalNotFound = Object.assign(new Error("workflow execution not found"), {
      code: 5,
      details: "workflow execution not found",
      metadata: {},
    });
    expect(temporalWorkflowExecutionNotFound(temporalNotFound)).toBe(true);
    expect(
      temporalWorkflowExecutionNotFound(
        Object.assign(new Error("ordinary HTTP 404"), { code: 5, status: 404 }),
      ),
    ).toBe(false);
    expect(
      temporalWorkflowExecutionNotFound(
        Object.assign(new Error("Temporal unavailable"), {
          code: 14,
          details: "unavailable",
          metadata: {},
        }),
      ),
    ).toBe(false);
  });
});
