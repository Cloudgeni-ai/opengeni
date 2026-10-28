import { expect, test } from "bun:test";
import { tick, type Ports } from "../docs/merge-batcher-admin/minimal-watchdog";

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

test.each([
  ["stopped", { ...healthy, state: "stopped" }],
  ["stopped", { ...healthy, state: "draining" }],
  ["crash-loop", { ...healthy, consecutiveUnclassifiedFailures: 3 }],
  ["stale", { ...healthy, controlObservedAt: now - 900_000 }],
  ["stalled", { ...healthy, lastSuccessfulCycleAt: now - 900_000 }],
  ["unavailable", null],
] as const)("%s only records an alert, including repeated and concurrent ticks", async (reason, status) => {
  const effects: string[] = [];
  const events: unknown[] = [];
  const ports: Ports = {
    now: () => now,
    verifyBinding: async () => {},
    status: async () => status,
    claim: async () => { effects.push("claim"); return true; },
    off: async () => { effects.push("off"); },
    resumeOff: async () => { effects.push("resumeOff"); },
    record: async (event) => { events.push(event); },
  };
  expect(await tick(ports)).toBe("held");
  expect(await Promise.all([tick(ports), tick(ports)])).toEqual(["held", "held"]);
  expect(effects).toEqual([]);
  expect(events).toEqual(Array(3).fill({ outcome: "held", reason }));
});

test("pinned deployment/control-plane grace expires without a healthy claim or effects", async () => {
  let clock = now;
  const events: unknown[] = [];
  const forbidden = async () => { throw Error("Control action must not be called"); };
  const ports: Ports = {
    now: () => clock,
    graceUntil: now + 60_000,
    verifyBinding: async () => {},
    status: async () => ({ ...healthy, state: "stopped" }),
    claim: forbidden,
    off: forbidden,
    resumeOff: forbidden,
    record: async (event) => { events.push(event); },
  };
  expect(await tick(ports)).toBe("held");
  expect(events.at(-1)).toEqual({ outcome: "held", reason: "stopped", suppressedUntil: now + 60_000 });
  clock += 60_000;
  expect(await tick(ports)).toBe("held");
  expect(events.at(-1)).toEqual({ outcome: "held", reason: "stopped" });
});
