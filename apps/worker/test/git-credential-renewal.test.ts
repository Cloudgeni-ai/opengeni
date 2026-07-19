import { describe, expect, test } from "bun:test";
import type { GitCredentialProvider } from "@opengeni/contracts";
import {
  GIT_CREDENTIAL_DEFAULT_REFRESH_MS,
  GIT_CREDENTIAL_MIN_REFRESH_MS,
  nextGitCredentialRenewalDelay,
  startGitCredentialRenewalLoop,
} from "../src/activities/git-credential-renewal";

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

describe("host-managed Git credential renewal", () => {
  test("caps unknown/long expiries and advances an imminent expiry", () => {
    const now = Date.parse("2026-07-14T10:00:00.000Z");
    expect(nextGitCredentialRenewalDelay(undefined, ["github"], now)).toBe(
      GIT_CREDENTIAL_DEFAULT_REFRESH_MS,
    );
    expect(
      nextGitCredentialRenewalDelay({ github: "2026-07-14T12:00:00.000Z" }, ["github"], now),
    ).toBe(GIT_CREDENTIAL_DEFAULT_REFRESH_MS);
    expect(
      nextGitCredentialRenewalDelay({ github: "2026-07-14T10:04:00.000Z" }, ["github"], now),
    ).toBe(GIT_CREDENTIAL_MIN_REFRESH_MS);
  });

  test("mints the complete provider set once and submits one validated write", async () => {
    const scheduler = fakeScheduler();
    const writes: Array<Record<string, string>> = [];
    const successes: Array<readonly GitCredentialProvider[]> = [];
    let mints = 0;
    const controller = startGitCredentialRenewalLoop({
      expectedProviders: ["github", "gitlab", "azure_devops"],
      mint: async () => {
        mints += 1;
        return {
          gitTokens: { github: "gh-new", gitlab: "gl-new", azure_devops: "az-new" },
          expiresAt: {},
        };
      },
      write: async (tokens) => {
        writes.push({ ...tokens } as Record<string, string>);
      },
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
      onSuccess: ({ providers }) => successes.push(providers),
    });

    await controller.refreshNow();

    expect(mints).toBe(1);
    expect(writes).toEqual([{ github: "gh-new", gitlab: "gl-new", azure_devops: "az-new" }]);
    expect(successes).toEqual([["github", "gitlab", "azure_devops"]]);
    await controller.stop();
  });

  test("never replaces files with a partial provider bundle and retries", async () => {
    const scheduler = fakeScheduler();
    const failures: Array<{ retryDelayMs: number; errorClass: string }> = [];
    let writes = 0;
    const controller = startGitCredentialRenewalLoop({
      expectedProviders: ["github", "gitlab"],
      mint: async () => ({ gitTokens: { github: "gh-only" }, expiresAt: {} }),
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
      { retryDelayMs: 5_000, errorClass: "GitCredentialRenewalError" },
      { retryDelayMs: 10_000, errorClass: "GitCredentialRenewalError" },
    ]);
    await controller.stop();
  });

  test("coalesces concurrent refreshes", async () => {
    const scheduler = fakeScheduler();
    let releaseMint!: () => void;
    const mintGate = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    let mints = 0;
    let writes = 0;
    const controller = startGitCredentialRenewalLoop({
      expectedProviders: ["github"],
      mint: async () => {
        mints += 1;
        await mintGate;
        return { gitTokens: { github: "gh-new" }, expiresAt: {} };
      },
      write: async () => {
        writes += 1;
      },
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });

    const first = controller.refreshNow();
    const second = controller.refreshNow();
    releaseMint();
    await Promise.all([first, second]);

    expect(mints).toBe(1);
    expect(writes).toBe(1);
    await controller.stop();
  });

  test("stop does not wait on a hung mint and never writes its late token", async () => {
    const scheduler = fakeScheduler();
    let releaseMint!: () => void;
    const mintGate = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    let writes = 0;
    const controller = startGitCredentialRenewalLoop({
      expectedProviders: ["github"],
      mint: async () => {
        await mintGate;
        return { gitTokens: { github: "gh-late" }, expiresAt: {} };
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
    releaseMint();
    await refresh;

    expect(writes).toBe(0);
    expect(scheduler.scheduled.every((entry) => entry.cleared)).toBe(true);
  });

  test("stop drains an in-flight token-file write", async () => {
    const scheduler = fakeScheduler();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let stopped = false;
    const controller = startGitCredentialRenewalLoop({
      expectedProviders: ["github"],
      mint: async () => ({ gitTokens: { github: "gh-new" }, expiresAt: {} }),
      write: async () => {
        await writeGate;
      },
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
    releaseWrite();
    await Promise.all([refresh, stopping]);
    expect(stopped).toBe(true);
  });

  test("invalidates a known-expired provider at its exact deadline", async () => {
    const scheduler = fakeScheduler();
    let now = Date.parse("2026-07-19T04:00:00.000Z");
    let resolveInvalidated!: (providers: readonly GitCredentialProvider[]) => void;
    const invalidated = new Promise<readonly GitCredentialProvider[]>((resolve) => {
      resolveInvalidated = resolve;
    });
    const controller = startGitCredentialRenewalLoop({
      expectedProviders: ["github"],
      initialExpiresAt: { github: "2026-07-19T04:00:10.000Z" },
      mint: async () => ({ gitTokens: { github: "gh-new" }, expiresAt: {} }),
      write: async () => undefined,
      invalidate: async (providers) => resolveInvalidated(providers),
      now: () => now,
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });

    const expiry = scheduler.scheduled.find((entry) => entry.delayMs === 10_000);
    expect(expiry).toBeDefined();
    now += 10_000;
    expiry!.callback();

    expect(await invalidated).toEqual(["github"]);
    await controller.stop();
  });

  test("a refresh write racing the old expiry deterministically preserves the new token", async () => {
    const scheduler = fakeScheduler();
    let now = Date.parse("2026-07-19T04:00:00.000Z");
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const mutations: string[] = [];
    const controller = startGitCredentialRenewalLoop({
      expectedProviders: ["github"],
      initialExpiresAt: { github: "2026-07-19T04:00:10.000Z" },
      mint: async () => ({
        gitTokens: { github: "gh-new" },
        expiresAt: { github: "2026-07-19T05:00:00.000Z" },
      }),
      write: async () => {
        mutations.push("write:start");
        await writeGate;
        mutations.push("write:end");
      },
      invalidate: async () => {
        mutations.push("invalidate");
      },
      now: () => now,
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });

    const oldExpiry = scheduler.scheduled.find((entry) => entry.delayMs === 10_000)!;
    const refresh = controller.refreshNow();
    await Promise.resolve();
    now += 10_000;
    oldExpiry.callback();
    releaseWrite();
    await refresh;
    await Promise.resolve();

    expect(mutations).toEqual(["write:start", "write:end"]);
    await controller.stop();
  });

  test("immediate invalidation is serialized with writes and drains on stop", async () => {
    const scheduler = fakeScheduler();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const mutations: string[] = [];
    const controller = startGitCredentialRenewalLoop({
      expectedProviders: ["github"],
      mint: async () => ({ gitTokens: { github: "gh-new" }, expiresAt: {} }),
      write: async () => {
        mutations.push("write:start");
        await writeGate;
        mutations.push("write:end");
      },
      invalidate: async () => {
        mutations.push("invalidate");
      },
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });

    const refresh = controller.refreshNow();
    await Promise.resolve();
    const invalidate = controller.invalidateNow(["github"]);
    await Promise.resolve();
    expect(mutations).toEqual(["write:start"]);
    releaseWrite();
    await Promise.all([refresh, invalidate, controller.stop()]);

    expect(mutations).toEqual(["write:start", "write:end", "invalidate"]);
  });
});
