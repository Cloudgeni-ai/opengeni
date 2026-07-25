import { describe, expect, test } from "bun:test";
import { type CodexTokenDeadlineClock, withCodexTokenDeadline } from "../src/codex-token-resolver";

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
