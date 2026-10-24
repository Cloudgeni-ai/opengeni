import { expect, test } from "bun:test";
import { reason, tick, type Ports } from "../docs/merge-batcher-admin/minimal-watchdog";

// Paired with batcher-progress/v1 immutable instance/cycle timing fields.
const now = 10_000_000;
const status = {
  state: "running",
  controlObservedAt: now,
  consecutiveUnclassifiedFailures: 0,
  progressSchema: "batcher-progress/v1",
  lastSuccessfulCycleAt: now - 1_000,
  firstObservationDeferredAt: null,
  consecutiveObservationDeferrals: 0,
  lastCycleError: null,
  writerActive: false,
  uncertainOutcome: false,
  reconciliationRequired: false,
  runtimeStartedAt: now - 2_000_000,
  cycleStartedAt: null,
  cycleDeadlineAt: null,
};

test("startup grace expires against immutable runtime start despite fresh heartbeat", () => {
  const startup = { ...status, lastSuccessfulCycleAt: null, runtimeStartedAt: now - 119_999 };
  expect(reason(startup, now)).toBeNull();
  expect(reason({ ...startup, runtimeStartedAt: now - 120_000 }, now)).toBe("stalled");
});

test("a timely active cycle has fixed grace, but a later retry cannot renew it", () => {
  const cycle = {
    ...status,
    lastSuccessfulCycleAt: now - 900_000,
    cycleStartedAt: now - 60_000,
    cycleDeadlineAt: now + 1_025_000,
  };
  expect(reason(cycle, now)).toBeNull();
  expect(reason({ ...cycle, cycleDeadlineAt: now }, now)).toBe("stalled");
  expect(reason({ ...cycle, cycleStartedAt: now }, now)).toBe("stalled");
});

test("configured one-hour execution is bounded, not mistaken for the default fifteen minutes", () => {
  const cycle = { ...status, cycleStartedAt: now - 1, cycleDeadlineAt: now - 1 + 3_785_000 };
  expect(reason(cycle, now)).toBeNull();
  expect(reason({ ...cycle, cycleDeadlineAt: cycle.cycleDeadlineAt + 1 }, now)).toBe("unavailable");
});

test("missing, future, cross-instance and inconsistent timing is unknown", () => {
  for (const delta of [
    { runtimeStartedAt: undefined },
    { runtimeStartedAt: now + 1 },
    { runtimeStartedAt: now, lastSuccessfulCycleAt: now - 1 },
    { cycleStartedAt: now, cycleDeadlineAt: null },
    { cycleStartedAt: null, cycleDeadlineAt: now + 1 },
    { cycleStartedAt: now + 1, cycleDeadlineAt: now + 100 },
    { cycleStartedAt: status.runtimeStartedAt - 1, cycleDeadlineAt: now + 1 },
  ])
    expect(reason({ ...status, ...delta }, now)).toBe("unavailable");
});

test("recent successful idle or Batch-wait cycles need no landing to be healthy", () => {
  for (const extra of [{ queued: 0 }, { activeBatch: "waiting-for-tests" }]) {
    expect(reason({ ...status, ...extra }, now)).toBeNull();
  }
});

test("fresh heartbeat and cumulative successes cannot hide stale controller progress", () => {
  expect(
    reason({ ...status, lastSuccessfulCycleAt: now - 900_000, successfulCycles: 7 }, now),
  ).not.toBeNull();
});

test("repeated read deferrals and moving next-cycle time do not renew progress", () => {
  expect(
    reason(
      {
        ...status,
        lastSuccessfulCycleAt: now - 900_000,
        firstObservationDeferredAt: now - 800_000,
        consecutiveObservationDeferrals: 12,
        lastCycleError: "observation_deferred",
        nextCycleAt: now + 60_000,
        completedCycles: 100,
      },
      now,
    ),
  ).not.toBeNull();
});

test("stalled uncertain reconciliation is not made healthy by a fresh heartbeat", () => {
  expect(
    reason(
      {
        ...status,
        state: "holding",
        uncertainOutcome: true,
        reconciliationRequired: true,
        lastSuccessfulCycleAt: now - 900_000,
      },
      now,
    ),
  ).not.toBeNull();
});

test("missing or mismatched progress schema is unknown, not healthy", () => {
  for (const progressSchema of [undefined, null, "batcher-progress/v0", {}]) {
    expect(reason({ ...status, progressSchema }, now)).toBe("unavailable");
  }
});

test("malformed and future successful-cycle timestamps are not evidence", () => {
  for (const lastSuccessfulCycleAt of [undefined, -1, NaN, Infinity, now + 1, "100"]) {
    expect(reason({ ...status, lastSuccessfulCycleAt }, now)).toBe("unavailable");
  }
});

test("malformed deferral counters are unknown", () => {
  for (const consecutiveObservationDeferrals of [undefined, -1, 1.5, "2", Infinity]) {
    expect(reason({ ...status, consecutiveObservationDeferrals }, now)).toBe("unavailable");
  }
});

test("progress-triggered OFF still requires proven restoration and never repeats unknown effects", async () => {
  let claimed = false;
  let calls = 0;
  const events: string[] = [];
  const ports: Ports = {
    verifyBinding: async () => {},
    now: () => now,
    status: async () => ({ ...status, lastSuccessfulCycleAt: now - 900_000 }),
    claim: async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    off: async () => {
      calls++;
      throw Error("unresolved write; no restoration proof");
    },
    record: async ({ outcome }) => {
      events.push(outcome);
    },
  };
  expect(await tick(ports)).toBe("held");
  expect(await tick(ports)).toBe("held");
  expect(calls).toBe(1);
  expect(events).not.toContain("manual");
});
