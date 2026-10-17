import { expect, test } from "bun:test";
import { ModelSocketTransportError } from "@opengeni/network/responses-websocket";
import { shouldFallbackModelSocket } from "../src/activities/agent-turn/persistent-transport-recovery";

test("socket exhaustion chooses HTTP once without granting a new retry budget", () => {
  const error = new ModelSocketTransportError("closed", "response");
  const exhausted = {
    status: "exhausted",
    providerRecoveryCount: 5,
    maxProviderRecoveryCount: 5,
  } as const;
  const input = {
    error,
    recovery: { status: "recovering", continueDelayMs: 2000 } as const,
    httpOnly: false,
    nextRecoveryCount: 5,
    recoveryLimit: 5,
  };
  expect(shouldFallbackModelSocket({ ...input, nextRecoveryCount: 4 })).toBe(false);
  expect(shouldFallbackModelSocket(input)).toBe(true);
  expect(shouldFallbackModelSocket({ ...input, httpOnly: true })).toBe(false);
  expect(shouldFallbackModelSocket({ ...input, recovery: exhausted })).toBe(false);
  expect(shouldFallbackModelSocket({ ...input, error: new Error("network error") })).toBe(false);
  expect(
    shouldFallbackModelSocket({ ...input, error: new Error("SDK wrapper", { cause: error }) }),
  ).toBe(true);
});
