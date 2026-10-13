import { describe, expect, test } from "bun:test";
import { agentVersionState } from "../src/sandbox/machines";

function failed(targetVersion: string, errorCode: string | null) {
  return {
    operationId: "00000000-0000-4000-8000-000000000001",
    status: "failed" as const,
    targetVersion,
    expectedBinarySha256: null,
    errorCode,
    retryable: true,
    rolledBack: false,
    requestedAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:05.000Z",
    completedAt: "2026-10-10T12:00:05.000Z",
  };
}

describe("agentVersionState", () => {
  test("a real failure to reach a newer build is a failure", () => {
    expect(agentVersionState("0.1.53", "0.1.54", failed("0.1.54", "signature_invalid"))).toBe(
      "update_failed",
    );
  });

  test("a failed update whose target is already installed is moot", () => {
    expect(agentVersionState("0.1.54", "0.1.54", failed("0.1.54", "update_busy_work"))).toBe(
      "current",
    );
    expect(agentVersionState("0.1.55", "0.1.54", failed("0.1.54", "signature_invalid"))).toBe(
      "ahead",
    );
  });

  test("a busy machine postponing the update is still outdated, not failed", () => {
    expect(agentVersionState("0.1.53", "0.1.54", failed("0.1.54", "update_busy_work"))).toBe(
      "outdated",
    );
    expect(agentVersionState("0.1.53", "0.1.54", failed("0.1.54", "update_busy_uploads"))).toBe(
      "outdated",
    );
  });

  test("an update in flight is updating, and no update compares versions", () => {
    expect(
      agentVersionState("0.1.53", "0.1.54", { ...failed("0.1.54", null), status: "applying" }),
    ).toBe("updating");
    expect(agentVersionState("0.1.54", "0.1.54", null)).toBe("current");
    expect(agentVersionState(null, "0.1.54", null)).toBe("unknown");
  });
});
