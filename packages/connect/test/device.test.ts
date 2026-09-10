import { expect, test } from "bun:test";
import { pollDeviceAuthorization } from "../src/device";

test("device slowdown without a provider interval increases pacing", async () => {
  let clock = 0;
  const delays: number[] = [];
  let calls = 0;
  const result = await pollDeviceAuthorization({
    poll: async () => ({ status: ++calls === 1 ? "slow_down" : "complete" }),
    expired: { status: "expired" },
    initialIntervalSeconds: 1,
    expiresAtMs: 30_000,
    signal: new AbortController().signal,
    now: () => clock,
    wait: async (delay) => {
      delays.push(delay);
      clock += delay;
      return true;
    },
  });
  expect(result).toEqual({ status: "complete" });
  expect(delays).toEqual([1000, 6000]);
});

test("a hanging device transport cannot outlive the observation deadline", async () => {
  let calls = 0;
  const result = await pollDeviceAuthorization({
    poll: () => {
      calls++;
      return new Promise<{ status: string }>(() => {});
    },
    expired: { status: "expired" },
    initialIntervalSeconds: 1,
    expiresAtMs: Date.now() + 20,
    signal: new AbortController().signal,
    wait: async () => true,
  });
  expect(result).toEqual({ status: "expired" });
  expect(calls).toBe(1);
});

test("abort stops observing a hanging device transport without retry", async () => {
  const controller = new AbortController();
  const result = await pollDeviceAuthorization({
    poll: () => {
      queueMicrotask(() => controller.abort());
      return new Promise<{ status: string }>(() => {});
    },
    expired: { status: "expired" },
    initialIntervalSeconds: 1,
    expiresAtMs: Date.now() + 30_000,
    signal: controller.signal,
    wait: async () => true,
  });
  expect(result).toBeNull();
});
