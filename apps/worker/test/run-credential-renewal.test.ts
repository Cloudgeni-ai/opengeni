import { describe, expect, test } from "bun:test";
import { RunMcpCredentials, type NormalizedRunCredentialMaterial } from "@opengeni/runtime";
import {
  RUN_CREDENTIAL_DEFAULT_REFRESH_MS,
  RUN_CREDENTIAL_MIN_REFRESH_MS,
  nextRunCredentialRenewalDelay,
  startRunCredentialRenewalLoop,
  runCredentialRenewalExpiry,
} from "../src/activities/run-credential-renewal";

function material(value: string, expiresAt: Date | null = null): NormalizedRunCredentialMaterial {
  return {
    environment: { TOKEN: value },
    files: [],
    fileEnvironment: {},
    expiresAt,
    authNeeded: [],
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
  test("MCP-only renewal uses the earliest entry expiry and the shared cancellation fence", async () => {
    const scheduler = fakeScheduler();
    const now = Date.parse("2026-09-30T08:00:00Z");
    const target = { id: "custom", url: "https://product.example/mcp" };
    const seed = {
      ...material("unrelated", new Date(now + 3_600_000)),
      mcp: [
        {
          server: "custom",
          headers: { authorization: "initial" },
          expiresAt: new Date(now + 600_000).toISOString(),
        },
      ],
    };
    const credentials = new RunMcpCredentials([target], { now: () => now });
    credentials.replace(seed);
    expect(runCredentialRenewalExpiry(seed)?.getTime()).toBe(now + 600_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = startRunCredentialRenewalLoop({
      initialExpiresAt: runCredentialRenewalExpiry(seed),
      now: () => now,
      resolve: async () => {
        await gate;
        return { ...seed, mcp: [{ ...seed.mcp[0]!, headers: { authorization: "renewed" } }] };
      },
      write: async (next) => credentials.replace(next),
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });
    expect(scheduler.scheduled[0]!.delayMs).toBe(300_000);
    const refresh = controller.refreshNow();
    await controller.stop();
    release();
    await refresh;
    expect(
      new Headers(credentials.requestInit(target, target.url)!.headers).get("authorization"),
    ).toBe("initial");
  });

  test("failed MCP target renewal retains the last valid headers and redacts its failure", async () => {
    const scheduler = fakeScheduler();
    const target = { id: "custom", url: "https://product.example/mcp" };
    const credentials = new RunMcpCredentials([target]);
    credentials.replace({
      expiresAt: null,
      mcp: [{ server: "custom", headers: { authorization: "initial" } }],
    });
    const failures: unknown[] = [];
    const controller = startRunCredentialRenewalLoop({
      initialExpiresAt: null,
      resolve: async () => ({
        ...material(""),
        mcp: [{ server: "unknown", headers: { authorization: "secret-invalid" } }],
      }),
      write: async (next) => credentials.replace(next),
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
      onFailure: (failure) => failures.push(failure),
    });
    await controller.refreshNow();
    expect(
      new Headers(credentials.requestInit(target, target.url)!.headers).get("authorization"),
    ).toBe("initial");
    expect(failures).toEqual([
      { retryDelayMs: 5000, errorClass: "RunCredentialRenewalOperationError" },
    ]);
    expect(JSON.stringify(failures)).not.toContain("secret-invalid");
    await controller.stop();
  });

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
    const failures: Array<{ retryDelayMs: number; errorClass: string }> = [];
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
      onFailure: ({ retryDelayMs, errorClass }) => failures.push({ retryDelayMs, errorClass }),
    });
    await controller.refreshNow();
    await controller.refreshNow();
    expect(writes).toBe(0);
    expect(failures).toEqual([
      { retryDelayMs: 5_000, errorClass: "RunCredentialRenewalOperationError" },
      { retryDelayMs: 10_000, errorClass: "RunCredentialRenewalOperationError" },
    ]);
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
