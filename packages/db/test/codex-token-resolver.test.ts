import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  buildCodexTokenResolver,
  type CodexAuthDeps,
  type CodexCredentialForRun,
  type CodexTokenDeadlineClock,
  withCodexTokenDeadline,
} from "../src/codex-token-resolver";
import type { Database } from "../src/database";

type PendingTimer = { callback: () => void; dueAt: number };

class FakeClock implements CodexTokenDeadlineClock {
  private nextHandle = 1;
  private now = 0;
  private readonly timers = new Map<number, PendingTimer>();
  clearCount = 0;

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout> {
    const handle = this.nextHandle++;
    this.timers.set(handle, { callback, dueAt: this.now + delayMs });
    return handle as unknown as ReturnType<typeof globalThis.setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
    this.clearCount += 1;
    this.timers.delete(handle as unknown as number);
  }

  advanceBy(delayMs: number): void {
    this.now += delayMs;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.now)
      .sort(([, left], [, right]) => left.dueAt - right.dueAt);
    for (const [handle, timer] of due) {
      this.timers.delete(handle);
      timer.callback();
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function expectNoUnhandledRejection(run: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    await run();
    await flushMicrotasks();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
  }
}

function staleCredential(): CodexCredentialForRun {
  return {
    id: "credential-shared",
    version: 1,
    workspaceId: "workspace-shared",
    tokens: { accessToken: "old-access", refreshToken: "refresh-1", idToken: "id" },
    chatgptAccountId: null,
    scopes: null,
    planType: null,
    isFedramp: false,
    expiresAt: new Date(0),
    lastRefreshAt: null,
    status: "active",
    lastError: null,
    exhaustedUntil: null,
    exhaustedKind: null,
    exhaustedRevision: 0,
  };
}

function fakeAuthDeps(overrides: Partial<CodexAuthDeps>): CodexAuthDeps {
  return {
    loadCredential: async () => staleCredential(),
    recordRefresh: async () => true,
    setStatus: async () => true,
    refresh: async () => ({ accessToken: "fresh-access", refreshToken: "refresh-2" }),
    encrypt: () => "encrypted",
    keyBytes: () => Buffer.alloc(32, 1),
    withRefreshLock: async (lockedDb, _workspaceId, _credentialId, fn) => await fn(lockedDb),
    ...overrides,
  };
}

describe("buildCodexTokenResolver refresh single-flight", () => {
  test("SUB-APPS-01: resolvers with different refresh key scopes never adopt each other's in-flight outcome", async () => {
    const db = {} as Database;
    const settings = {} as Settings;
    const appsLock = deferred<void>();
    let appsLoads = 0;
    const apps = buildCodexTokenResolver(
      db,
      settings,
      "workspace-shared",
      "credential-shared",
      fakeAuthDeps({
        refreshKeyScope: "codex_apps",
        // The designation disappears while the Apps refresh waits for the lock.
        loadCredential: async () => {
          appsLoads += 1;
          if (appsLoads > 1) throw new Error("designated Apps credential unavailable");
          return staleCredential();
        },
        withRefreshLock: async (lockedDb, _workspaceId, _credentialId, fn) => {
          await appsLock.promise;
          return await fn(lockedDb);
        },
      }),
    );
    const inference = buildCodexTokenResolver(
      db,
      settings,
      "workspace-shared",
      "credential-shared",
      fakeAuthDeps({}),
    );

    const appsToken = apps.getToken();
    const appsOutcome = appsToken.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await flushMicrotasks();
    const first = await Promise.race([
      inference.getToken().then((token) => token.accessToken),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked-on-apps-refresh"), 100)),
    ]);
    expect(first).toBe("fresh-access");

    appsLock.resolve();
    expect(await appsOutcome).toBe("designated Apps credential unavailable");
  });
});

describe("withCodexTokenDeadline", () => {
  test("deadline-first consumes a late provider rejection", async () => {
    await expectNoUnhandledRejection(async () => {
      const clock = new FakeClock();
      const provider = deferred<string>();
      const result = withCodexTokenDeadline(provider.promise, { timeoutMs: 10, clock });

      clock.advanceBy(10);
      await expect(result).rejects.toThrow("Codex token refresh timed out");

      provider.reject(new Error("late provider failure"));
      await flushMicrotasks();
      expect(clock.clearCount).toBe(1);
    });
  });

  test("deadline-first consumes a late provider resolution", async () => {
    const clock = new FakeClock();
    const provider = deferred<string>();
    const result = withCodexTokenDeadline(provider.promise, { timeoutMs: 10, clock });

    clock.advanceBy(10);
    await expect(result).rejects.toThrow("Codex token refresh timed out");

    provider.resolve("late value");
    await flushMicrotasks();
    expect(clock.clearCount).toBe(1);
  });

  test("provider-first fulfillment remains authoritative", async () => {
    const clock = new FakeClock();
    const provider = deferred<string>();
    const result = withCodexTokenDeadline(provider.promise, { timeoutMs: 10, clock });

    provider.resolve("provider value");
    await expect(result).resolves.toBe("provider value");
    clock.advanceBy(10);
    expect(clock.clearCount).toBe(1);
  });

  test("provider-first rejection remains authoritative", async () => {
    const clock = new FakeClock();
    const provider = deferred<string>();
    const providerError = new Error("provider failure");
    const result = withCodexTokenDeadline(provider.promise, { timeoutMs: 10, clock });

    provider.reject(providerError);
    await expect(result).rejects.toBe(providerError);
    clock.advanceBy(10);
    expect(clock.clearCount).toBe(1);
  });

  test("cancellation wins the race and late provider rejection stays observed", async () => {
    await expectNoUnhandledRejection(async () => {
      const clock = new FakeClock();
      const controller = new AbortController();
      const provider = deferred<string>();
      const result = withCodexTokenDeadline(provider.promise, {
        timeoutMs: 10,
        clock,
        signal: controller.signal,
      });
      const cancellation = new Error("turn cancelled");

      controller.abort(cancellation);
      await expect(result).rejects.toBe(cancellation);
      clock.advanceBy(10);
      provider.reject(new Error("late provider failure"));
      await flushMicrotasks();
      expect(clock.clearCount).toBe(1);
    });
  });

  test("settles once when provider fulfillment is followed by cancellation and deadline", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const provider = deferred<string>();
    const result = withCodexTokenDeadline(provider.promise, {
      timeoutMs: 10,
      clock,
      signal: controller.signal,
    });

    provider.resolve("provider value");
    await expect(result).resolves.toBe("provider value");
    controller.abort(new Error("late cancellation"));
    clock.advanceBy(10);
    expect(clock.clearCount).toBe(1);
  });
});
