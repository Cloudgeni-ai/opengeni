import { expect, test } from "bun:test";
import { ConnectWaitTimedOutError, pollConnectAttempt } from "../src";
import type { ConnectAttempt } from "../src";

const complete: ConnectAttempt = {
  id: "attempt",
  workspaceId: "workspace",
  providerId: "provider",
  ownership: "personal",
  revision: 1,
  state: "complete",
  credentialsCommitted: true,
  integrationInstalled: false,
  completionRequirement: "connection",
  nextAction: { type: "none" },
  expiresAt: "2030-01-01T00:00:00Z",
};
test("returns backend completion without navigating or mutating", async () => {
  expect(await pollConnectAttempt({ get: async () => complete }, "workspace", "attempt")).toEqual(
    complete,
  );
});
test("rejects another attempt", async () => {
  await expect(
    pollConnectAttempt({ get: async () => ({ ...complete, id: "other" }) }, "workspace", "attempt"),
  ).rejects.toThrow("mismatch");
});
test("deadline settles even when a transport ignores abort", async () => {
  await expect(
    pollConnectAttempt({ get: () => new Promise(() => {}) }, "workspace", "attempt", {
      timeoutMs: 5,
    }),
  ).rejects.toBeInstanceOf(ConnectWaitTimedOutError);
});

/** Record the deadline timers pollConnectAttempt arms (delays of a minute or more). */
async function deadlines(run: () => Promise<unknown>): Promise<number[]> {
  const original = globalThis.setTimeout;
  const armed: number[] = [];
  globalThis.setTimeout = ((handler: () => void, delay?: number) => {
    if ((delay ?? 0) >= 60_000) armed.push(delay!);
    return original(handler, delay);
  }) as typeof setTimeout;
  try {
    await run();
  } finally {
    globalThis.setTimeout = original;
  }
  return armed;
}

test("without a timeout, the wait lasts until the attempt expires", async () => {
  // A sign-in in a system browser can take longer than a fixed two minutes;
  // the attempt's own expiry (plus grace for clock skew) bounds the wait.
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const armed = await deadlines(() =>
    pollConnectAttempt({ get: async () => ({ ...complete, expiresAt }) }, "workspace", "attempt", {
      expiresAt,
    }),
  );
  expect(armed).toHaveLength(1);
  expect(armed[0]!).toBeGreaterThan(31 * 60_000);
  expect(armed[0]!).toBeLessThanOrEqual(32 * 60_000);
});

test("a later attempt expiry from the backend moves the deadline", async () => {
  const later = new Date(Date.now() + 20 * 60_000).toISOString();
  const armed = await deadlines(() =>
    pollConnectAttempt(
      { get: async () => ({ ...complete, expiresAt: later }) },
      "workspace",
      "attempt",
    ),
  );
  expect(armed).toHaveLength(2);
  expect(armed[0]!).toBe(120_000);
  expect(armed[1]!).toBeGreaterThan(21 * 60_000);
});

test("an explicit timeout is kept as given", async () => {
  const armed = await deadlines(() =>
    pollConnectAttempt({ get: async () => complete }, "workspace", "attempt", {
      timeoutMs: 90_000,
    }),
  );
  expect(armed).toEqual([90_000]);
});

test("returns the backend's expired attempt instead of a client timeout", async () => {
  const expired = { ...complete, state: "expired", nextAction: { type: "none" } } as ConnectAttempt;
  expect(
    await pollConnectAttempt({ get: async () => expired }, "workspace", "attempt", {
      expiresAt: "2000-01-01T00:00:00Z",
    }),
  ).toEqual(expired);
});
test("already cancelled polling makes no request", async () => {
  let calls = 0;
  await expect(
    pollConnectAttempt(
      {
        get: async () => {
          calls++;
          return complete;
        },
      },
      "workspace",
      "attempt",
      { signal: AbortSignal.abort(new Error("stopped")) },
    ),
  ).rejects.toThrow("stopped");
  expect(calls).toBe(0);
});
