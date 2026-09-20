import { expect, test } from "bun:test";
import { failedSessionCopy } from "./failed-session-copy";

const summary = { failedAt: null, consecutiveRecoveryCount: null };
test("only explicit model availability evidence suggests another model", () => {
  for (const reason of [
    "The model is not supported with this account.",
    "The model `example` is not available.",
    "The 'example' model does not exist.",
    "Fixture model unavailable before execution",
  ]) {
    expect(failedSessionCopy({ ...summary, reason })).toEqual({
      reason: "This model isn’t available. Choose another below.",
      unavailableModel: true,
    });
  }
  for (const reason of [
    "The model connection is unavailable.",
    "The model service is not available.",
    "Connection failed.",
    "An unknown response was received.",
  ]) {
    expect(failedSessionCopy({ ...summary, reason })).toEqual({ reason, unavailableModel: false });
  }
});
test("long recorded errors are bounded without inventing a recovery diagnosis", () => {
  const result = failedSessionCopy({ ...summary, reason: "Connection interrupted. ".repeat(100) });
  expect(result.reason.length).toBeLessThanOrEqual(160);
  expect(result.reason.endsWith("…")).toBe(true);
  expect(failedSessionCopy({ ...summary, reason: null }).reason).toBe("This session failed.");
});
