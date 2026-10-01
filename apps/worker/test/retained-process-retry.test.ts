import { describe, expect, test } from "bun:test";
import { retainedProcessDeadlineRetryMs } from "../src/retained-process-retry";

const now = 1_800_000_000_000;
const settings = { sandboxRotationLeadMs: 240_000, sandboxLeaseReaperPeriodMs: 5_000 };
const process = {
  leaseId: "lease",
  leaseEpoch: 7,
  providerBackend: "modal",
  providerInstanceId: "original",
  routeTargetId: null,
};
const lease = {
  id: "lease",
  leaseEpoch: 7,
  backend: "modal",
  instanceId: "original",
  providerDeadlineAt: new Date(now + 240_000 + 90_000),
};

describe("retained command deadline retry", () => {
  test("wakes a backed-off background server at the rotation lead boundary", () => {
    expect(retainedProcessDeadlineRetryMs(process, lease, settings, 300_000, now)).toBe(90_000);
  });

  test("keeps probing during rotation without a zero-delay busy loop", () => {
    for (const remaining of [240_000, 80_000, 0, -30_000]) {
      expect(
        retainedProcessDeadlineRetryMs(
          process,
          { ...lease, providerDeadlineAt: new Date(now + remaining) },
          settings,
          300_000,
          now,
        ),
      ).toBe(5_000);
    }
  });

  test("preserves normal backoff away from rotation and never extends a shorter retry", () => {
    expect(
      retainedProcessDeadlineRetryMs(
        process,
        { ...lease, providerDeadlineAt: new Date(now + 900_000) },
        settings,
        300_000,
        now,
      ),
    ).toBe(300_000);
    expect(retainedProcessDeadlineRetryMs(process, lease, settings, 1_000, now)).toBe(1_000);
  });

  test("never applies a successor or unrelated lease deadline to an old command", () => {
    for (const unrelated of [
      null,
      { ...lease, id: "other" },
      { ...lease, leaseEpoch: 8 },
      { ...lease, backend: "selfhosted" },
      { ...lease, instanceId: "successor" },
      { ...lease, providerDeadlineAt: null },
      { ...lease, providerDeadlineAt: new Date(NaN) },
    ]) {
      expect(retainedProcessDeadlineRetryMs(process, unrelated, settings, 300_000, now)).toBe(
        300_000,
      );
    }
    expect(
      retainedProcessDeadlineRetryMs(
        { ...process, routeTargetId: "connected" },
        lease,
        settings,
        300_000,
        now,
      ),
    ).toBe(300_000);
    expect(
      retainedProcessDeadlineRetryMs(
        { ...process, providerBackend: "selfhosted" },
        lease,
        settings,
        300_000,
        now,
      ),
    ).toBe(300_000);
  });
});
