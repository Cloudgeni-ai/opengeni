import { expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { subscriptionCapacityArmingFailure } from "../src/activities/agent-turn/subscription-capacity-arming";

test("a capacity wait that cannot be armed becomes an explicit, secret-safe user state", () => {
  for (const provider of ["claude", "xai"] as const) {
    const failure = subscriptionCapacityArmingFailure(
      provider,
      new Error("Session not found: private-row-identifier"),
    );
    expect(failure).toEqual({
      error: expect.stringContaining(provider === "claude" ? "Claude" : "SuperGrok"),
      code: provider + "_capacity_wait_unavailable",
      retryable: true,
      recovery: "user_message",
    });
    expect(JSON.stringify(failure)).not.toContain("private-row-identifier");
  }
});

test("structured database outages keep their exact-attempt recovery path", () => {
  const driver = Object.assign(new Error("private driver detail"), { code: "ECONNRESET" });
  const orm = new DrizzleQueryError("select 1", [], driver);
  expect(subscriptionCapacityArmingFailure("claude", orm)).toBeNull();
});
