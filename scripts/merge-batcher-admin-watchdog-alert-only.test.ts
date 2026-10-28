import { expect, test } from "bun:test";
import {
  tick,
  exitCode,
  maxGraceMs,
  type Ports,
} from "../docs/merge-batcher-admin/minimal-watchdog";

const now = 2_000_000;
const healthy = {
  state: "running",
  controlObservedAt: now,
  consecutiveUnclassifiedFailures: 0,
  progressSchema: "batcher-progress/v1",
  lastSuccessfulCycleAt: now,
  firstObservationDeferredAt: null,
  consecutiveObservationDeferrals: 0,
  runtimeStartedAt: 0,
  cycleStartedAt: null,
  cycleDeadlineAt: null,
};
function fixture(status: unknown = healthy) {
  const events: unknown[] = [];
  const ports: Ports = {
    now: () => now,
    verifyBinding: async () => {},
    status: async () => status,
    record: async (event) => {
      events.push(event);
    },
  };
  // Old injected effects must never be used, even by repeated/concurrent ticks.
  const forbidden = async () => {
    throw Error("Forbidden control action");
  };
  Object.assign(ports, { claim: forbidden, off: forbidden, resumeOff: forbidden });
  return { ports, events };
}
test.each([
  ["stopped", { ...healthy, state: "stopped" }],
  ["stopped", { ...healthy, state: "draining" }],
  ["crash-loop", { ...healthy, consecutiveUnclassifiedFailures: 3 }],
  ["stale", { ...healthy, controlObservedAt: now - 900_000 }],
  ["stalled", { ...healthy, lastSuccessfulCycleAt: now - 900_000 }],
  ["unavailable", null],
] as const)("%s only alerts on repeated/concurrent ticks", async (reason, status) => {
  const { ports, events } = fixture(status);
  expect(await tick(ports)).toBe("held");
  expect(await Promise.all([tick(ports), tick(ports)])).toEqual(["held", "held"]);
  expect(events).toEqual(
    Array(3).fill({ policy: "alert-only/v1", severity: "WARNING", outcome: "held", reason }),
  );
});
test("binding failures respect fixed grace, then alert at expiry", async () => {
  const { ports, events } = fixture();
  let clock = now;
  ports.now = () => clock;
  ports.graceUntil = now + 60_000;
  ports.verifyBinding = async () => {
    throw Error("deploy reconciling");
  };
  ports.status = async () => {
    throw Error("must not read unbound target");
  };
  expect(exitCode(await tick(ports))).toBe(0);
  expect(events.at(-1)).toEqual({
    policy: "alert-only/v1",
    severity: "INFO",
    outcome: "suppressed",
    reason: "binding-failure",
    suppressedUntil: now + 60_000,
  });
  clock += 60_000;
  expect(exitCode(await tick(ports))).toBe(1);
  expect(events.at(-1)).toMatchObject({
    outcome: "held",
    severity: "WARNING",
    reason: "binding-failure",
  });
});
test("healthy tick during grace remains healthy", async () => {
  const { ports, events } = fixture();
  ports.graceUntil = now + maxGraceMs;
  expect(await tick(ports)).toBe("healthy");
  expect(events).toEqual([{ policy: "alert-only/v1", outcome: "healthy", severity: "INFO" }]);
});
test.each(["3000000", null, -1, NaN, Infinity, now * 1000, now + maxGraceMs + 1])(
  "invalid grace %s warns without breaking healthy observation or suppressing failures",
  async (value) => {
    const { ports, events } = fixture();
    ports.graceUntil = value as unknown as number;
    expect(await tick(ports)).toBe("healthy");
    expect(events[0]).toMatchObject({ reason: "invalid-grace", severity: "WARNING" });
    ports.status = async () => null;
    expect(await tick(ports)).toBe("held");
    expect(events.at(-1)).toMatchObject({ reason: "unavailable", severity: "WARNING" });
  },
);
test("status request failure during grace is suppressed, never healthy", async () => {
  const { ports, events } = fixture();
  ports.graceUntil = now + 1;
  ports.status = async () => {
    throw Error("unavailable");
  };
  expect(await tick(ports)).toBe("suppressed");
  expect(events.at(-1)).toMatchObject({ severity: "INFO", reason: "unavailable" });
});
