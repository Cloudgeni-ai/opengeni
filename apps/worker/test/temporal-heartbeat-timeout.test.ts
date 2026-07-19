import { describe, expect, test } from "bun:test";
import * as productionWorkflows from "../src/workflows";
import {
  PRODUCTION_TURN_HEARTBEAT_TIMEOUT,
  TEST_ONLY_TURN_HEARTBEAT_TIMEOUT,
  resolveTurnHeartbeatTimeout,
} from "../src/workflows/activities";

describe("Temporal turn heartbeat timeout seam", () => {
  test("keeps the production default exactly two minutes", () => {
    expect(PRODUCTION_TURN_HEARTBEAT_TIMEOUT).toBe("2 minutes");
    expect(resolveTurnHeartbeatTimeout(undefined)).toBe("2 minutes");
  });

  test("accepts only the explicit test timeout as an accelerated override", () => {
    expect(resolveTurnHeartbeatTimeout(TEST_ONLY_TURN_HEARTBEAT_TIMEOUT)).toBe("1 second");
    expect(resolveTurnHeartbeatTimeout("2 minutes")).toBe("2 minutes");
  });

  test("rejects malformed or unapproved timeout overrides instead of weakening production", () => {
    expect(() => resolveTurnHeartbeatTimeout("30 seconds")).toThrow(
      "unsupported turn heartbeat timeout override",
    );
    expect(() => resolveTurnHeartbeatTimeout("")).toThrow(
      "unsupported turn heartbeat timeout override",
    );
    expect(() => resolveTurnHeartbeatTimeout(null as unknown as string)).toThrow(
      "unsupported turn heartbeat timeout override",
    );
  });

  test("does not register the accelerated workflow in the production bundle", () => {
    expect("sessionWorkflowWithAcceleratedHeartbeat" in productionWorkflows).toBe(false);
  });
});
