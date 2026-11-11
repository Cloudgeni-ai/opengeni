import { expect, test } from "bun:test";
import {
  FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
  effectiveProviderRecoveryStartedAt,
  recoverProviderClockAfterDependencyWait,
} from "../src/provider-recovery-clock";

test("an internal API outage suspends an existing provider deadline without replenishing attempts", () => {
  const started = Date.parse("2026-10-20T14:00:00Z");
  const original = {
    providerRecoveryCount: 3,
    providerRecoveryReason: "provider_overloaded",
    providerRecoveryStartedAt: new Date(started).toISOString(),
  };
  const waiting = recoverProviderClockAfterDependencyWait(
    original,
    FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
    new Date(started + 60_000),
  );
  const afterOutage = started + 60 * 60_000;
  expect(effectiveProviderRecoveryStartedAt(waiting, afterOutage)).toBe(afterOutage - 60_000);
  expect(
    recoverProviderClockAfterDependencyWait(
      waiting,
      FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
      new Date(afterOutage),
    ),
  ).toEqual(waiting);
  const resumed = recoverProviderClockAfterDependencyWait(
    waiting,
    "provider_overloaded",
    new Date(afterOutage),
  );
  expect(resumed.providerRecoveryCount).toBe(3);
  expect(resumed).not.toHaveProperty("internalMcpSetupWaitStartedAt");
  expect(effectiveProviderRecoveryStartedAt(resumed, afterOutage + 60_000)).toBe(
    afterOutage - 60_000,
  );
  expect(original.providerRecoveryStartedAt).toBe(new Date(started).toISOString());
});

test("malformed or future suspension clocks cannot renew a provider window", () => {
  for (const internalMcpSetupWaitStartedAt of [
    "invalid",
    new Date(3000).toISOString(),
    new Date(500).toISOString(),
  ]) {
    const metadata = {
      providerRecoveryStartedAt: new Date(1000).toISOString(),
      internalMcpSetupWaitStartedAt,
    };
    expect(effectiveProviderRecoveryStartedAt(metadata, 2000)).toBeUndefined();
    expect(
      effectiveProviderRecoveryStartedAt(
        recoverProviderClockAfterDependencyWait(metadata, "provider_overloaded", new Date(2000)),
        2000,
      ),
    ).toBeUndefined();
  }
});

test("an internal wait without a provider failure does not invent a provider clock", () => {
  const waiting = recoverProviderClockAfterDependencyWait(
    {},
    FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
    new Date(1000),
  );
  expect(effectiveProviderRecoveryStartedAt(waiting, 5000)).toBeUndefined();
  expect(
    recoverProviderClockAfterDependencyWait(waiting, "provider_unavailable", new Date(5000)),
  ).toEqual({});
});
