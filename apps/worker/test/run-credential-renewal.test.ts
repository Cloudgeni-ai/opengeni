import { describe, expect, test } from "bun:test";
import type { NormalizedRunCredentialMaterial } from "@opengeni/runtime";
import {
  RUN_CREDENTIAL_DEFAULT_REFRESH_MS,
  RUN_CREDENTIAL_MIN_REFRESH_MS,
  nextRunCredentialRenewalDelay,
  startRunCredentialRenewalLoop,
} from "../src/activities/run-credential-renewal";

function material(value: string, expiresAt: Date | null = null): NormalizedRunCredentialMaterial {
  return {
    environment: { TOKEN: value },
    files: [],
    fileEnvironment: {},
    expiresAt,
    authNeeded: [],
    redactions: [{ name: "TOKEN", value }],
  };
}

function fakeScheduler() {
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    cleared: boolean;
  }> = [];
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

describe("host-managed run credential renewal", () => {
  test("caps unknown/long expiries and advances imminent expiry", () => {
    const now = Date.parse("2026-07-21T10:00:00.000Z");
    expect(nextRunCredentialRenewalDelay(null, now)).toBe(RUN_CREDENTIAL_DEFAULT_REFRESH_MS);
    expect(nextRunCredentialRenewalDelay(new Date(now + 2 * 60 * 60_000), now)).toBe(
      RUN_CREDENTIAL_DEFAULT_REFRESH_MS,
    );
    expect(nextRunCredentialRenewalDelay(new Date(now + 60_000), now)).toBe(
      RUN_CREDENTIAL_MIN_REFRESH_MS,
    );
  });

  test("coalesces concurrent refreshes and writes one complete generation", async () => {
    const scheduler = fakeScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolves = 0;
    const writes: string[] = [];
    const controller = startRunCredentialRenewalLoop({
      initialExpiresAt: null,
      resolve: async () => {
        resolves += 1;
        await gate;
        return material("renewed-secret");
      },
      write: async (resolved) =>
        writes.push(resolved?.environment.TOKEN ?? "missing-renewed-material"),
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });
    const first = controller.refreshNow();
    const second = controller.refreshNow();
    release();
    await Promise.all([first, second]);
    expect(resolves).toBe(1);
    expect(writes).toEqual(["renewed-secret"]);
    await controller.stop();
  });

  test("stop rejects a late host resolution without waiting for it", async () => {
    const scheduler = fakeScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const controller = startRunCredentialRenewalLoop({
      initialExpiresAt: null,
      resolve: async () => {
        await gate;
        return material("late-secret");
      },
      write: async () => {
        writes += 1;
      },
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });
    const refresh = controller.refreshNow();
    await controller.stop();
    expect(writes).toBe(0);
    release();
    await refresh;
    expect(writes).toBe(0);
  });

  test("stop drains an in-flight physical sandbox write", async () => {
    const scheduler = fakeScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopped = false;
    const controller = startRunCredentialRenewalLoop({
      initialExpiresAt: null,
      resolve: async () => material("new-secret"),
      write: async () => await gate,
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });
    const refresh = controller.refreshNow();
    await Promise.resolve();
    const stopping = controller.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([refresh, stopping]);
    expect(stopped).toBe(true);
  });

  test("retries a failed host resolution without writing partial state", async () => {
    const scheduler = fakeScheduler();
    const failures: number[] = [];
    let writes = 0;
    const controller = startRunCredentialRenewalLoop({
      initialExpiresAt: null,
      resolve: async () => {
        throw new Error("host unavailable");
      },
      write: async () => {
        writes += 1;
      },
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
      onFailure: ({ retryDelayMs }) => failures.push(retryDelayMs),
    });
    await controller.refreshNow();
    await controller.refreshNow();
    expect(writes).toBe(0);
    expect(failures).toEqual([5_000, 10_000]);
    await controller.stop();
  });

  test("delivers a renewal opt-out so the caller can remove active material", async () => {
    const scheduler = fakeScheduler();
    const writes: Array<NormalizedRunCredentialMaterial | null> = [];
    const controller = startRunCredentialRenewalLoop({
      initialExpiresAt: null,
      resolve: async () => null,
      write: async (resolved) => {
        writes.push(resolved);
      },
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });
    await controller.refreshNow();
    expect(writes).toEqual([null]);
    await controller.stop();
  });
});
