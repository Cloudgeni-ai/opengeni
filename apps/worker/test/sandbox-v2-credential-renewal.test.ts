import { expect, test } from "bun:test";
import type { SandboxV2ActiveCredentials } from "@opengeni/core";
import { startSandboxV2CredentialRenewalLoop } from "../src/sandbox-v2-credential-renewal";

const initial: SandboxV2ActiveCredentials = {
  ticket: {
    ordinal: 0,
    definition: { generationId: "synthetic-initial", purpose: "provision", forceRefresh: false },
    writerActionId: `sandbox-v2:${"a".repeat(64)}`,
  },
  resolution: {
    status: "not_applicable",
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
  },
};
function timerFixture() {
  const scheduled: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  return {
    scheduled,
    options: {
      schedule: (callback: () => void, delay: number) => {
        const timer = { callback, delay, cleared: false };
        scheduled.push(timer);
        return timer;
      },
      clearSchedule: (timer: unknown) => {
        (timer as (typeof scheduled)[number]).cleared = true;
      },
    },
  };
}
test("native renewal timer preserves predecessor across failure and advances only after activation", async () => {
  const timers = timerFixture();
  const expected: string[] = [];
  const failures: unknown[] = [];
  let first = true;
  const renewed = {
    ...initial,
    ticket: {
      ...initial.ticket,
      ordinal: 1,
      definition: {
        generationId: "synthetic-renewed",
        purpose: "renewal" as const,
        forceRefresh: true,
      },
    },
  };
  const controller = startSandboxV2CredentialRenewalLoop({
    initial,
    owner: {
      renew: async (id) => {
        expected.push(id);
        if (first) {
          first = false;
          throw Error("Unknown ordinary renewal writer");
        }
        return renewed;
      },
    },
    ...timers.options,
    onFailure: (failure) => {
      failures.push(failure);
    },
  });
  await controller.refreshNow();
  expect(expected).toEqual(["synthetic-initial"]);
  expect(failures).toEqual([
    { retryDelayMs: 5000, errorClass: "RunCredentialRenewalOperationError" },
  ]);
  await controller.refreshNow();
  await controller.refreshNow();
  expect(expected).toEqual(["synthetic-initial", "synthetic-initial", "synthetic-renewed"]);
  await controller.stop();
  for (const timer of timers.scheduled) timer.callback();
  await controller.refreshNow();
  expect(expected).toHaveLength(3);
});
test("native renewal stop drains the started lifecycle operation and suppresses late timers", async () => {
  const timers = timerFixture();
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let notices = 0;
  const controller = startSandboxV2CredentialRenewalLoop({
    initial,
    owner: {
      renew: async () => {
        calls++;
        started();
        await held;
        return initial;
      },
    },
    ...timers.options,
    onSuccess: () => {
      notices++;
    },
  });
  const refresh = controller.refreshNow();
  await startedPromise;
  let settled = false;
  const stopped = controller.stop().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  for (const timer of timers.scheduled) timer.callback();
  await controller.refreshNow();
  expect(calls).toBe(1);
  release();
  await Promise.all([refresh, stopped]);
  expect(settled).toBe(true);
  expect(notices).toBe(0);
});
test("native renewal uses the earliest host MCP expiry without exposing headers to the loop", async () => {
  const timers = timerFixture();
  const now = 1_700_000_000_000;
  const value: SandboxV2ActiveCredentials = {
    ...initial,
    resolution: {
      ...initial.resolution,
      status: "ok",
      environment: {},
      files: [],
      fileEnvironment: {},
      expiresAt: new Date(now + 3_600_000).toISOString(),
      mcp: [
        {
          url: "https://mcp.example.test/",
          headers: { Authorization: "Bearer synthetic" },
          expiresAt: new Date(now + 600_000).toISOString(),
        },
      ],
    },
  };
  const controller = startSandboxV2CredentialRenewalLoop({
    initial: value,
    owner: { renew: async () => value },
    now: () => now,
    ...timers.options,
  });
  expect(timers.scheduled[0]!.delay).toBe(300_000);
  await controller.stop();
});
