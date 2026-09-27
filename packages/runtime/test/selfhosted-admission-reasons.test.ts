import { expect, test } from "bun:test";
import { ErrorCode } from "@opengeni/agent-proto";
import {
  agentErrorToControlError,
  drainingExhaustedError,
} from "../src/sandbox/selfhosted/control-rpc";
import { renderSelfhostedFault } from "../src/sandbox/selfhosted/fault-rendering";

for (const [detail, expected] of [
  [{ reason: "agent_update" }, "self-update"],
  [{ backpressure: "queue_breaker" }, "queue_breaker"],
  [{ backpressure: "wait_breaker" }, "wait_breaker"],
  [{}, "admission"],
  [{ reason: "future_reason" }, "admission"],
] as const) {
  test(`admission refusal preserves cause ${expected} through retries and rendering`, () => {
    const error = agentErrorToControlError(
      {
        code: ErrorCode.ERROR_CODE_DRAINING,
        message: "native refusal",
        retryable: true,
        detail,
      },
      "request-one",
    );
    const exhausted = drainingExhaustedError(error, 3);
    for (const current of [error, exhausted]) {
      expect(current.message).toContain(expected);
      expect(current.message).not.toContain("concurrent-work capacity");
      expect(current.draining).toBe(true);
      expect(current.retryable).toBe(true);
      expect(current.controlRequestId).toBe("request-one");
      const rendered = renderSelfhostedFault(current);
      expect(rendered).toContain(expected);
      expect(rendered).toContain("nothing ran");
      expect(rendered).not.toContain("saturated");
      expect(rendered).not.toContain("reduce the number");
    }
    expect(exhausted.detail).toEqual({ ...detail, retries: "3" });
    expect(exhausted.message).toContain("retried 3 times");
    expect(renderSelfhostedFault(exhausted)).toContain("after 3 retries");
  });
}
