import { describe, expect, test } from "bun:test";
import type { MintedSandboxToolspaceToken } from "../src/activities/environment";
import {
  TOOLSPACE_TOKEN_DEFAULT_REFRESH_MS,
  startToolspaceTokenRenewalLoop,
} from "../src/activities/toolspace-token-renewal";

function material(token: string, expiresAt = new Date(Date.now() + 60 * 60_000)) {
  return { token, expiresAt } satisfies MintedSandboxToolspaceToken;
}

function fakeScheduler() {
  const scheduled: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  return {
    scheduled,
    schedule(callback: () => void, delayMs: number) {
      const entry = { callback, delayMs, cleared: false };
      scheduled.push(entry);
      return entry;
    },
    clearSchedule(timer: unknown) {
      (timer as (typeof scheduled)[number]).cleared = true;
    },
  };
}

describe("sandbox Toolspace token renewal", () => {
  test("uses the bounded cadence for a fresh one-hour token", async () => {
    const scheduler = fakeScheduler();
    const now = Date.parse("2026-07-21T10:00:00.000Z");
    const controller = startToolspaceTokenRenewalLoop({
      initialExpiresAt: new Date(now + 60 * 60_000),
      mint: async () => material("renewed"),
      write: async () => undefined,
      now: () => now,
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });
    expect(scheduler.scheduled[0]?.delayMs).toBe(TOOLSPACE_TOKEN_DEFAULT_REFRESH_MS);
    await controller.stop();
  });

  test("coalesces refreshes and drains an in-flight sandbox write on stop", async () => {
    const scheduler = fakeScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mints = 0;
    let stopCompleted = false;
    const controller = startToolspaceTokenRenewalLoop({
      initialExpiresAt: new Date(Date.now() + 60 * 60_000),
      mint: async () => {
        mints += 1;
        return material("renewed");
      },
      write: async () => await gate,
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });
    const first = controller.refreshNow();
    const second = controller.refreshNow();
    await Promise.resolve();
    const stopping = controller.stop().then(() => {
      stopCompleted = true;
    });
    await Promise.resolve();
    expect(mints).toBe(1);
    expect(stopCompleted).toBe(false);
    release();
    await Promise.all([first, second, stopping]);
    expect(stopCompleted).toBe(true);
  });

  test("retries a temporarily unavailable mint without writing partial state", async () => {
    const scheduler = fakeScheduler();
    const retries: number[] = [];
    let writes = 0;
    const controller = startToolspaceTokenRenewalLoop({
      initialExpiresAt: new Date(Date.now() + 60 * 60_000),
      mint: async () => undefined,
      write: async () => {
        writes += 1;
      },
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
      onFailure: ({ retryDelayMs }) => retries.push(retryDelayMs),
    });
    await controller.refreshNow();
    await controller.refreshNow();
    expect(writes).toBe(0);
    expect(retries).toEqual([5_000, 10_000]);
    await controller.stop();
  });
});
