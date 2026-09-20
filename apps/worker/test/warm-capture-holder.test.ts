import { expect, test } from "bun:test";
import { retainsHolderForWarmCapture } from "../src/warm-capture-holder";

const lease = {
  liveness: "warm" as const,
  leaseEpoch: 3,
  archiveCapture: {
    id: "capture",
    operationId: "operation",
    providerRequestId: "request",
    providerReplaySafe: true,
    takeoverSafe: true,
    attempt: 1,
    workspaceGeneration: 7,
    startedAt: new Date(1000),
    deadlineAt: new Date(2000),
    publishedAt: null,
  },
};

test("closed-holder retention lasts only through the exact bounded warm capture", () => {
  expect(retainsHolderForWarmCapture(lease, 3, 1500)).toBe(true);
  expect(retainsHolderForWarmCapture(lease, 3, 2000)).toBe(false);
  expect(retainsHolderForWarmCapture(lease, 3, 2001)).toBe(false);
  expect(retainsHolderForWarmCapture(lease, 4, 1500)).toBe(false);
  expect(retainsHolderForWarmCapture({ ...lease, liveness: "draining" }, 3, 1500)).toBe(false);
  expect(retainsHolderForWarmCapture({ ...lease, archiveCapture: null }, 3, 1500)).toBe(false);
  expect(retainsHolderForWarmCapture(null, 3, 1500)).toBe(false);
  expect(
    retainsHolderForWarmCapture(
      { ...lease, archiveCapture: { ...lease.archiveCapture, publishedAt: new Date(1400) } },
      3,
      1500,
    ),
  ).toBe(true);
  expect(lease.archiveCapture.deadlineAt.getTime()).toBe(2000);
});
