import { expect, test } from "bun:test";
import { reason } from "../docs/merge-batcher-admin/minimal-watchdog";

const now = 2_000_000;
const live = {
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
test("fresh control observation and successful cycle are both required", () => {
  expect(reason(live, now)).toBeNull();
  expect(reason({ ...live, state: "holding" }, now)).toBeNull();
  expect(reason({ ...live, state: "unexpected" }, now)).toBe("unavailable");
  expect(reason({ ...live, controlObservedAt: now - 899_999 }, now)).toBeNull();
  expect(reason({ ...live, controlObservedAt: now - 900_000 }, now)).toBe("stale");
  expect(reason({ ...live, state: "stopped" }, now)).toBe("stopped");
  expect(reason({ ...live, state: "draining" }, now)).toBe("stopped");
  expect(reason({ ...live, consecutiveUnclassifiedFailures: 3 }, now)).toBe("crash-loop");
  for (const value of [
    null,
    {},
    { ...live, controlObservedAt: now + 1 },
    { ...live, controlObservedAt: null },
    { ...live, consecutiveUnclassifiedFailures: -1 },
  ])
    expect(reason(value, now)).toBe("unavailable");
});
